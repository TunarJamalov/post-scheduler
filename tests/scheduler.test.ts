import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  claimDuePosts,
  cleanupMedia,
  createPost,
  getMedia,
  getAccountSecrets,
  getPost,
  openDatabase,
  saveAccount,
  storeMedia,
  type Account,
} from '../src/db.js';
import { blueskyClient, blueskyFacets, mastodonClient, type PublishClient } from '../src/providers.js';
import { runDuePosts, splitThread, validateSegments } from '../src/scheduler.js';
import { createServer } from '../src/server.js';

let db: Database.Database;
beforeEach(() => {
  process.env.AUTH_ENCRYPTION_KEY = 'test-key-'.repeat(5);
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
});

const fakeClient = (log: { text: string; replyTo?: string }[], fail = false): PublishClient => ({
  verify: async () => '@tester',
  publish: async (_account, _secrets, text, replyTo) => {
    if (fail) throw new Error('boom');
    log.push({ text, replyTo: replyTo?.id });
    return { id: `id-${log.length}`, url: `https://example.com/${log.length}`, ref: null };
  },
});

describe('thread splitting and validation', () => {
  it('splits on --- lines and trims parts', () => {
    expect(splitThread('one\n\n---\n\ntwo\r\n---\r\nthree\n')).toEqual(['one', 'two', 'three']);
    expect(splitThread('   ')).toEqual([]);
  });
  it('enforces provider character limits by code points', () => {
    expect(validateSegments(['x'.repeat(300)], 'bluesky')).toBeUndefined();
    expect(validateSegments(['x'.repeat(301)], 'bluesky')).toContain('301');
    expect(validateSegments(['😀'.repeat(500)], 'mastodon')).toBeUndefined();
    expect(validateSegments([], 'mastodon')).toContain('empty');
  });
});

describe('accounts', () => {
  it('stores tokens encrypted and never returns them in listings', () => {
    const account = saveAccount(db, {
      name: 'Me',
      provider: 'mastodon',
      server: 'https://m.example',
      identifier: '',
      secrets: { token: 'secret-token' },
    });
    expect(JSON.stringify(account)).not.toContain('secret-token');
    const raw = db.prepare('SELECT secrets_encrypted as s FROM accounts').get() as { s: string };
    expect(raw.s).not.toContain('secret-token');
    expect(getAccountSecrets(db, account.id)?.token).toBe('secret-token');
    saveAccount(db, {
      id: account.id,
      name: 'Renamed',
      provider: 'mastodon',
      server: 'https://m.example',
      identifier: '',
    });
    expect(getAccountSecrets(db, account.id)?.token).toBe('secret-token');
  });
});

describe('scheduler', () => {
  let account: Account;
  beforeEach(() => {
    account = saveAccount(db, {
      name: 'Me',
      provider: 'mastodon',
      server: 'https://m.example',
      identifier: '',
      secrets: { token: 't' },
    });
  });
  it('claims each due post once and publishes threads as replies in order', async () => {
    const due = createPost(db, { accountId: account.id, segments: ['first', 'second'], scheduledAt: 1000 });
    createPost(db, { accountId: account.id, segments: ['later'], scheduledAt: 5000 });
    createPost(db, { accountId: account.id, segments: ['draft'], scheduledAt: null });
    expect(claimDuePosts(db, 2000)).toHaveLength(1);
    expect(claimDuePosts(db, 2000)).toHaveLength(0);
    expect(getPost(db, due.id)?.status).toBe('publishing');
    db.prepare("UPDATE posts SET status='scheduled' WHERE id=?").run(due.id);
    const log: { text: string; replyTo?: string }[] = [];
    const results = await runDuePosts(
      db,
      { maxAttempts: 3, retryDelayMs: 1000, clients: { mastodon: fakeClient(log) } },
      2000
    );
    expect(results).toEqual([{ id: due.id, ok: true }]);
    expect(log).toEqual([
      { text: 'first', replyTo: undefined },
      { text: 'second', replyTo: 'id-1' },
    ]);
    const published = getPost(db, due.id)!;
    expect(published.status).toBe('published');
    expect(published.remoteUrl).toBe('https://example.com/1');
  });
  it('retries failed posts with a delay and marks them failed after the last attempt', async () => {
    const post = createPost(db, { accountId: account.id, segments: ['hi'], scheduledAt: 1000 });
    const options = { maxAttempts: 2, retryDelayMs: 60000, clients: { mastodon: fakeClient([], true) } };
    await runDuePosts(db, options, 1000);
    let row = getPost(db, post.id)!;
    expect(row.status).toBe('scheduled');
    expect(row.scheduledAt).toBe(61000);
    expect(row.error).toBe('boom');
    await runDuePosts(db, options, 61000);
    row = getPost(db, post.id)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(2);
  });
});

describe('providers', () => {
  it('sends Mastodon statuses with reply ids and bearer tokens', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const request = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: '42', url: 'https://m.example/@me/42', acct: 'me' }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = mastodonClient(request);
    const account = {
      id: 'a',
      name: 'n',
      provider: 'mastodon' as const,
      server: 'https://m.example/',
      identifier: '',
      createdAt: 0,
    };
    expect(await client.verify(account, { token: 'tok' })).toBe('@me@m.example');
    const item = await client.publish(account, { token: 'tok' }, 'hello', { id: '41', url: null, ref: null });
    expect(item).toMatchObject({ id: '42', url: 'https://m.example/@me/42' });
    expect(calls[1].url).toBe('https://m.example/api/v1/statuses');
    expect((calls[1].init.headers as any).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      status: 'hello',
      in_reply_to_id: '41',
      media_ids: [],
    });
  });
  it('creates Bluesky sessions, records with facets, and threads replies to the root', async () => {
    const calls: { url: string; body: any }[] = [];
    const request = (async (url: any, init: any) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), body });
      if (String(url).endsWith('createSession'))
        return new Response(JSON.stringify({ accessJwt: 'jwt', did: 'did:plc:x', handle: 'me.bsky.social' }));
      return new Response(
        JSON.stringify({
          uri: `at://did:plc:x/app.bsky.feed.post/r${calls.length}`,
          cid: `cid${calls.length}`,
        })
      );
    }) as typeof fetch;
    const client = blueskyClient(request);
    const account = {
      id: 'b',
      name: 'n',
      provider: 'bluesky' as const,
      server: 'https://bsky.social',
      identifier: 'me.bsky.social',
      createdAt: 0,
    };
    const first = await client.publish(account, { token: 'app-pass' }, 'see https://example.com now');
    const second = await client.publish(account, { token: 'app-pass' }, 'reply', first);
    const third = await client.publish(account, { token: 'app-pass' }, 'reply 2', second);
    expect(first.url).toBe('https://bsky.app/profile/me.bsky.social/post/r2');
    expect(calls[0].body).toEqual({ identifier: 'me.bsky.social', password: 'app-pass' });
    expect(calls[1].body.record.facets[0].features[0].uri).toBe('https://example.com');
    expect(calls[2].body.record.reply.parent.cid).toBe('cid2');
    expect(calls[3].body.record.reply.root.cid).toBe('cid2');
    expect(calls[3].body.record.reply.parent.cid).toBe('cid3');
    expect(calls.filter((c) => c.url.endsWith('createSession'))).toHaveLength(1);
  });
  it('computes byte offsets for link facets in non-ASCII text', () => {
    const facets = blueskyFacets('héllo https://a.io/x.') as any[];
    expect(facets[0].index).toEqual({ byteStart: 7, byteEnd: 21 });
    expect(facets[0].features[0].uri).toBe('https://a.io/x');
  });
});

describe('HTTP API', () => {
  async function listen(clients: PublishClient) {
    const app = createServer(db, { clients: { mastodon: clients, bluesky: clients } });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
  }
  const json = (
    base: string,
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('verifies accounts on save, validates posts, and schedules or drafts them', async () => {
    const { server, base } = await listen(fakeClient([]));
    const created = await json(base, '/api/admin/accounts', 'POST', {
      name: 'Me',
      provider: 'bluesky',
      identifier: '@me.bsky.social',
      token: 'pw',
    });
    expect(created.status).toBe(201);
    const account = await created.json();
    expect(account).toMatchObject({
      identity: '@tester',
      server: 'https://bsky.social',
      identifier: 'me.bsky.social',
    });
    expect(JSON.stringify(account)).not.toContain('"pw"');
    const tooLong = await json(base, '/api/admin/posts', 'POST', {
      accountId: account.id,
      text: 'x'.repeat(301),
      scheduledAt: Date.now() + 60000,
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toContain('bluesky allows 300');
    const scheduled = await (
      await json(base, '/api/admin/posts', 'POST', {
        accountId: account.id,
        text: 'a\n---\nb',
        scheduledAt: Date.now() + 60000,
      })
    ).json();
    expect(scheduled).toMatchObject({ status: 'scheduled', segments: ['a', 'b'] });
    const draft = await (
      await json(base, '/api/admin/posts', 'POST', {
        accountId: account.id,
        text: 'draft',
        scheduledAt: null,
      })
    ).json();
    expect(draft.status).toBe('draft');
    const cancelled = await (await json(base, `/api/admin/posts/${scheduled.id}/cancel`, 'POST')).json();
    expect(cancelled.status).toBe('cancelled');
    const queued = await (await json(base, `/api/admin/posts/${draft.id}/publish`, 'POST')).json();
    expect(queued.status).toBe('scheduled');
    expect((await json(base, '/api/admin/posts/nope', 'DELETE')).status).toBe(404);
    expect((await json(base, '/api/admin/posts', 'POST', { accountId: 'missing', text: 'x' })).status).toBe(
      400
    );
    for (const path of ['/dashboard', '/dashboard/accounts', '/dashboard/security']) {
      const html = await (await fetch(`${base}${path}`)).text();
      const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
      expect(() => new Function(script!)).not.toThrow();
    }
    server.close();
  });

  it('rejects a bad token with a clear message', async () => {
    const failing: PublishClient = {
      verify: async () => {
        throw new Error('HTTP 401: invalid token');
      },
      publish: fakeClient([]).publish,
    };
    const { server, base } = await listen(failing);
    const response = await json(base, '/api/admin/accounts', 'POST', {
      name: 'Me',
      provider: 'mastodon',
      server: 'https://m.example',
      token: 'bad',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('invalid token');
    expect(await (await fetch(`${base}/api/admin/accounts`)).json()).toEqual([]);
    server.close();
  });

  it('requires a session when admin credentials are configured', async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = 'pw';
    const { server, base } = await listen(fakeClient([]));
    expect((await fetch(`${base}/api/admin/posts`)).status).toBe(401);
    expect((await fetch(`${base}/dashboard`, { redirect: 'manual' })).status).toBe(302);
    const login = await json(
      base,
      '/api/auth/login',
      'POST',
      {},
      { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') }
    );
    expect(login.status).toBe(200);
    const jar = login.headers
      .getSetCookie()
      .map((v) => v.split(';', 1)[0])
      .join('; ');
    expect((await fetch(`${base}/api/admin/posts`, { headers: { Cookie: jar } })).status).toBe(200);
    expect((await json(base, '/api/admin/posts', 'POST', {}, { Cookie: jar })).status).toBe(403);
    server.close();
  });
});

describe('media', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('uploads, attaches, limits, and cleans up images', async () => {
    const app = createServer(db, { clients: { mastodon: fakeClient([]), bluesky: fakeClient([]) } });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const account = await (
      await fetch(`${base}/api/admin/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'B', provider: 'bluesky', identifier: 'me.bsky.social', token: 'pw' }),
      })
    ).json();
    const upload = (body: Buffer, type = 'image/png') =>
      fetch(`${base}/api/admin/media?filename=photo one.png`, {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      });
    expect((await upload(png, 'text/plain')).status).toBe(415);
    const small = await (await upload(png)).json();
    expect(small).toMatchObject({
      filename: 'photo_one.png',
      mime: 'image/png',
      size: png.length,
      postId: null,
    });
    const image = await fetch(`${base}/api/admin/media/${small.id}`);
    expect(image.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
    const big = await (await upload(Buffer.alloc(1_000_001))).json();
    const post = (body: unknown) =>
      fetch(`${base}/api/admin/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const tooBig = await post({
      accountId: account.id,
      text: 'hi',
      media: [{ id: big.id, segment: 0, alt: 'x' }],
    });
    expect(tooBig.status).toBe(400);
    expect(await tooBig.text()).toContain('bluesky allows');
    const wrongPart = await post({
      accountId: account.id,
      text: 'hi',
      media: [{ id: small.id, segment: 3 }],
    });
    expect(wrongPart.status).toBe(400);
    const created = await (
      await post({
        accountId: account.id,
        text: 'a\n---\nb',
        media: [{ id: small.id, segment: 1, alt: 'A cat' }],
      })
    ).json();
    expect(created.media).toHaveLength(1);
    expect(created.media[0]).toMatchObject({ segment: 1, alt: 'A cat', postId: created.id });
    // Attached media cannot be deleted through the media endpoint; detached media can.
    expect((await fetch(`${base}/api/admin/media/${small.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/api/admin/media/${big.id}`, { method: 'DELETE' })).status).toBe(204);
    // Deleting the post removes its media.
    await fetch(`${base}/api/admin/posts/${created.id}`, { method: 'DELETE' });
    expect((await fetch(`${base}/api/admin/media/${small.id}`)).status).toBe(404);
    server.close();
  });

  it('removes stale unattached uploads', () => {
    const item = storeMedia(db, { filename: 'a.png', mime: 'image/png', data: png });
    expect(cleanupMedia(db, 1000, Date.now() + 500)).toBe(0);
    expect(cleanupMedia(db, 1000, Date.now() + 2000)).toBe(1);
    expect(getMedia(db, item.id)).toBeUndefined();
  });

  it('uploads images to Mastodon and Bluesky before posting', async () => {
    const account = saveAccount(db, {
      name: 'M',
      provider: 'mastodon',
      server: 'https://m.example',
      identifier: '',
      secrets: { token: 't' },
    });
    const item = storeMedia(db, { filename: 'a.png', mime: 'image/png', data: png });
    const post = createPost(db, {
      accountId: account.id,
      segments: ['with image'],
      scheduledAt: 1000,
      media: [{ id: item.id, segment: 0, alt: 'alt text' }],
    });
    const calls: { url: string; init: any }[] = [];
    const request = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/v2/media'))
        return new Response(JSON.stringify({ id: 'm1', url: 'https://m.example/media/1' }));
      if (String(url).endsWith('uploadBlob'))
        return new Response(JSON.stringify({ blob: { $type: 'blob', ref: { $link: 'abc' } } }));
      if (String(url).endsWith('createSession'))
        return new Response(JSON.stringify({ accessJwt: 'jwt', did: 'did:plc:x', handle: 'me' }));
      if (String(url).endsWith('createRecord'))
        return new Response(JSON.stringify({ uri: 'at://did:plc:x/app.bsky.feed.post/r1', cid: 'c1' }));
      return new Response(JSON.stringify({ id: '9', url: 'https://m.example/@me/9' }));
    }) as typeof fetch;
    const results = await runDuePosts(
      db,
      {
        maxAttempts: 1,
        retryDelayMs: 0,
        clients: { mastodon: mastodonClient(request), bluesky: blueskyClient(request) },
      },
      1000
    );
    expect(results[0].ok).toBe(true);
    const upload = calls.find((c) => c.url.endsWith('/api/v2/media'))!;
    expect(upload.init.body).toBeInstanceOf(FormData);
    expect((upload.init.body as FormData).get('description')).toBe('alt text');
    const status = calls.find((c) => c.url.endsWith('/api/v1/statuses'))!;
    expect(JSON.parse(status.init.body).media_ids).toEqual(['m1']);

    const bsky = saveAccount(db, {
      name: 'B',
      provider: 'bluesky',
      server: 'https://bsky.social',
      identifier: 'me',
      secrets: { token: 'pw' },
    });
    const item2 = storeMedia(db, { filename: 'b.png', mime: 'image/png', data: png });
    createPost(db, {
      accountId: bsky.id,
      segments: ['bsky image'],
      scheduledAt: 1000,
      media: [{ id: item2.id, segment: 0, alt: 'blue' }],
    });
    await runDuePosts(
      db,
      { maxAttempts: 1, retryDelayMs: 0, clients: { bluesky: blueskyClient(request) } },
      2000
    );
    const blob = calls.find((c) => c.url.endsWith('uploadBlob'))!;
    expect(blob.init.headers['content-type']).toBe('image/png');
    const record = JSON.parse(calls.filter((c) => c.url.endsWith('createRecord')).pop()!.init.body).record;
    expect(record.embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [{ alt: 'blue', image: { $type: 'blob', ref: { $link: 'abc' } } }],
    });
  });
});
