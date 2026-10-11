import type { Account, AccountSecrets, Provider } from './db.js';

export interface PublishedItem {
  id: string;
  url: string | null;
  /** Provider-specific reference needed to reply to this item (threads). */
  ref: unknown;
}
export interface MediaUpload {
  data: Buffer;
  mime: string;
  alt: string;
  filename: string;
}
export interface PublishClient {
  /** Verifies credentials and returns a human-readable identity, such as "@user@instance". */
  verify(account: Account, secrets: AccountSecrets): Promise<string>;
  /** Publishes one segment, optionally as a reply to the previous segment of the thread. */
  publish(
    account: Account,
    secrets: AccountSecrets,
    text: string,
    replyTo?: PublishedItem,
    media?: MediaUpload[]
  ): Promise<PublishedItem>;
}

export type Fetch = typeof fetch;

async function json<T = any>(request: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = body?.error ?? body?.message ?? text.slice(0, 200) ?? response.statusText;
      throw new Error(`HTTP ${response.status}: ${message || 'request failed'}`);
    }
    return body as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const base = (server: string) => server.replace(/\/+$/, '');

/* ---------- Mastodon ---------- */
export function mastodonClient(request: Fetch = fetch, timeoutMs = 15000): PublishClient {
  return {
    async verify(account, secrets) {
      const me = await json(
        request,
        `${base(account.server)}/api/v1/accounts/verify_credentials`,
        {
          headers: { Authorization: `Bearer ${secrets.token}` },
        },
        timeoutMs
      );
      return `@${me.acct}@${new URL(account.server).hostname}`;
    },
    async publish(account, secrets, text, replyTo, media = []) {
      const mediaIds: string[] = [];
      for (const item of media) {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(item.data)], { type: item.mime }), item.filename);
        if (item.alt) form.append('description', item.alt);
        const uploaded = await json(
          request,
          `${base(account.server)}/api/v2/media`,
          { method: 'POST', headers: { Authorization: `Bearer ${secrets.token}` }, body: form },
          timeoutMs * 4
        );
        // Mastodon answers 202 while it processes the file; wait until it is ready.
        for (let i = 0; i < 20 && !uploaded.url; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const state = await json(
            request,
            `${base(account.server)}/api/v1/media/${uploaded.id}`,
            { headers: { Authorization: `Bearer ${secrets.token}` } },
            timeoutMs
          );
          if (state?.url) break;
        }
        mediaIds.push(String(uploaded.id));
      }
      const status = await json(
        request,
        `${base(account.server)}/api/v1/statuses`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secrets.token}`,
            'content-type': 'application/json',
            'Idempotency-Key': `${account.id}-${hash(text)}-${replyTo?.id ?? 'root'}`,
          },
          body: JSON.stringify({ status: text, in_reply_to_id: replyTo?.id ?? null, media_ids: mediaIds }),
        },
        timeoutMs
      );
      return { id: String(status.id), url: status.url ?? null, ref: null };
    },
  };
}

/* ---------- Bluesky (AT Protocol) ---------- */
interface AtSession {
  accessJwt: string;
  did: string;
  handle: string;
}
interface StrongRef {
  uri: string;
  cid: string;
}

/** Converts the text into byte-offset facets so URLs and mentions become clickable on Bluesky. */
export function blueskyFacets(text: string) {
  const encoder = new TextEncoder();
  const facets: unknown[] = [];
  const byteIndex = (charIndex: number) => encoder.encode(text.slice(0, charIndex)).length;
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g)) {
    const start = match.index!;
    facets.push({
      index: { byteStart: byteIndex(start), byteEnd: byteIndex(start + match[0].length) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: match[0] }],
    });
  }
  return facets;
}

export function blueskyClient(request: Fetch = fetch, timeoutMs = 15000): PublishClient {
  const sessions = new Map<string, AtSession>();
  async function session(account: Account, secrets: AccountSecrets, fresh = false) {
    if (!fresh && sessions.has(account.id)) return sessions.get(account.id)!;
    const result = await json<AtSession>(
      request,
      `${base(account.server)}/xrpc/com.atproto.server.createSession`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: account.identifier, password: secrets.token }),
      },
      timeoutMs
    );
    sessions.set(account.id, result);
    return result;
  }
  return {
    async verify(account, secrets) {
      const s = await session(account, secrets, true);
      return `@${s.handle}`;
    },
    async publish(account, secrets, text, replyTo, media = []) {
      let s = await session(account, secrets);
      const parent = replyTo?.ref as StrongRef | undefined;
      const uploadAll = async (jwt: string) => {
        const images = [];
        for (const item of media) {
          const result = await json<{ blob: unknown }>(
            request,
            `${base(account.server)}/xrpc/com.atproto.repo.uploadBlob`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${jwt}`, 'content-type': item.mime },
              body: new Uint8Array(item.data),
            },
            timeoutMs * 4
          );
          images.push({ alt: item.alt, image: result.blob });
        }
        return images;
      };
      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        facets: blueskyFacets(text),
      };
      if (parent) {
        const root = (replyTo as PublishedItem & { root?: StrongRef }).root ?? parent;
        record.reply = { root, parent };
      }
      const attempt = async (jwt: string) => {
        if (media.length) record.embed = { $type: 'app.bsky.embed.images', images: await uploadAll(jwt) };
        return json<StrongRef>(
          request,
          `${base(account.server)}/xrpc/com.atproto.repo.createRecord`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
            body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record }),
          },
          timeoutMs
        );
      };
      let created: StrongRef;
      try {
        created = await attempt(s.accessJwt);
      } catch (error) {
        // Expired session: sign in again once and retry.
        if (!(error instanceof Error && /HTTP 401/.test(error.message))) throw error;
        s = await session(account, secrets, true);
        created = await attempt(s.accessJwt);
      }
      const rkey = created.uri.split('/').pop();
      const root = (replyTo as (PublishedItem & { root?: StrongRef }) | undefined)?.root ?? parent ?? created;
      const item: PublishedItem & { root: StrongRef } = {
        id: created.uri,
        url: `https://bsky.app/profile/${s.handle}/post/${rkey}`,
        ref: created,
        root,
      };
      return item;
    },
  };
}

function hash(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function clientFor(provider: Provider, request: Fetch = fetch): PublishClient {
  return provider === 'mastodon' ? mastodonClient(request) : blueskyClient(request);
}
