import express from 'express';
import type Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import {
  basicCredentials,
  createSession,
  deleteTotp,
  destroySession,
  hasTotp,
  initAuth,
  randomTotpSetup,
  saveTotp,
  session,
  validateAuthEncryptionKey,
  validCsrf,
  verifyTotp,
} from './auth.js';
import {
  IMAGE_TYPES,
  MAX_IMAGES_PER_PART,
  MEDIA_LIMITS,
  cleanupMedia,
  createPost,
  getAccount,
  getMedia,
  mediaData,
  postMedia,
  removeMedia,
  storeMedia,
  getAccountSecrets,
  getPost,
  listAccounts,
  listPosts,
  postEvents,
  removeAccount,
  removePost,
  retryPost,
  saveAccount,
  setPostStatus,
  stats,
  updatePost,
  type Provider,
} from './db.js';
import { clientFor, type PublishClient } from './providers.js';
import { splitThread, validateSegments } from './scheduler.js';
import { accountsPage, loginPage, postsPage, securityPage } from './ui.js';

const SESSION_HOURS = 8;
const LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function sameString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ServerOptions {
  /** Called after a post is created or changed so the scheduler can react immediately. */
  onChanged?: () => void;
  clients?: Partial<Record<Provider, PublishClient>>;
}

function parseAccount(body: any) {
  const provider = body?.provider;
  if (provider !== 'mastodon' && provider !== 'bluesky')
    throw new Error('provider must be mastodon or bluesky');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('name is required');
  const server =
    typeof body.server === 'string' && body.server.trim()
      ? body.server.trim()
      : provider === 'bluesky'
        ? 'https://bsky.social'
        : '';
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error('server must be a valid URL such as https://mastodon.social');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('server must use http or https');
  const identifier = typeof body.identifier === 'string' ? body.identifier.trim().replace(/^@/, '') : '';
  if (provider === 'bluesky' && !identifier) throw new Error('Bluesky accounts need a handle');
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  return { name, provider: provider as Provider, server: url.origin, identifier, token };
}

function parsePost(db: Database.Database, body: any) {
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  const account = getAccount(db, accountId);
  if (!account) throw new Error('Choose an existing account');
  const segments = Array.isArray(body.segments)
    ? body.segments.map((s: unknown) => String(s).trim()).filter(Boolean)
    : splitThread(typeof body.text === 'string' ? body.text : '');
  const problem = validateSegments(segments, account.provider);
  if (problem) throw new Error(problem);
  const scheduledAt = body.scheduledAt == null || body.scheduledAt === '' ? null : Number(body.scheduledAt);
  if (scheduledAt !== null && !Number.isFinite(scheduledAt))
    throw new Error('scheduledAt must be a timestamp in milliseconds');
  const status = body.status === 'draft' ? 'draft' : scheduledAt ? 'scheduled' : 'draft';
  const media = Array.isArray(body.media) ? body.media : [];
  const perSegment = new Map<number, number>();
  const attachments = media.map((m: any) => {
    const item = typeof m?.id === 'string' ? getMedia(db, m.id) : undefined;
    if (!item) throw new Error('An attached image no longer exists; upload it again');
    const segment = Number(m.segment ?? 0);
    if (!Number.isInteger(segment) || segment < 0 || segment >= segments.length)
      throw new Error('An image is attached to a thread part that does not exist');
    if (item.size > MEDIA_LIMITS[account.provider])
      throw new Error(
        `${item.filename} is ${(item.size / 1024).toFixed(0)} KB; ${account.provider} allows ${(MEDIA_LIMITS[account.provider] / 1024).toFixed(0)} KB per image`
      );
    perSegment.set(segment, (perSegment.get(segment) ?? 0) + 1);
    if (perSegment.get(segment)! > MAX_IMAGES_PER_PART)
      throw new Error(`At most ${MAX_IMAGES_PER_PART} images per part`);
    return { id: item.id, segment, alt: typeof m.alt === 'string' ? m.alt.trim().slice(0, 1500) : '' };
  });
  return { accountId, segments, scheduledAt, status: status as 'draft' | 'scheduled', media: attachments };
}

export function createServer(db: Database.Database, options: ServerOptions = {}) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const configured = Boolean(username || password);
  if (configured && (!username || !password))
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured together');
  validateAuthEncryptionKey(); // also protects stored account tokens, so it is always required
  initAuth(db);
  const onChanged = options.onChanged ?? (() => {});

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.use(express.json({ limit: '200kb' }));
  app.use('/api/admin/media', express.raw({ type: IMAGE_TYPES, limit: '16mb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const cookie = (req: express.Request, name: string) =>
    req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const basicOk = (req: express.Request) => {
    const c = basicCredentials(req);
    return Boolean(
      c && username && password && sameString(c.username, username) && sameString(c.password, password)
    );
  };
  const setAuthCookies = (
    req: express.Request,
    res: express.Response,
    s: { token: string; csrf: string }
  ) => {
    const secure = process.env.NODE_ENV === 'production' || req.secure;
    const attrs = `Path=/; Max-Age=${SESSION_HOURS * 60 * 60}; SameSite=Strict${secure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', [`session=${s.token}; HttpOnly; ${attrs}`, `csrf=${s.csrf}; ${attrs}`]);
  };
  const clearAuthCookies = (res: express.Response) =>
    res.setHeader('Set-Cookie', [
      'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict',
      'csrf=; Path=/; Max-Age=0; SameSite=Strict',
    ]);
  const failures = new Map<string, { count: number; until: number }>();
  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!configured) return next();
    const row = session(db, cookie(req, 'session'));
    if (!row)
      return req.originalUrl.startsWith('/api/')
        ? res.status(401).json({ error: 'Authentication required' })
        : res.redirect('/login');
    if (req.method !== 'GET' && !validCsrf(row, req.headers['x-csrf-token'] as string))
      return res.status(403).json({ error: 'CSRF validation failed' });
    next();
  };
  const setup = () => {
    const s = randomTotpSetup();
    return { ...s, otpauth: `otpauth://totp/Post%20Scheduler?secret=${s.secret}&issuer=Post%20Scheduler` };
  };
  const setupResponse = async (
    res: express.Response,
    s: { secret: string; codes: string[]; otpauth: string }
  ) =>
    res.json({
      secret: s.secret,
      recoveryCodes: s.codes,
      otpauth: s.otpauth,
      qrDataUrl: await QRCode.toDataURL(s.otpauth),
    });
  const badRequest = (res: express.Response, e: unknown) =>
    res.status(400).send(e instanceof Error ? e.message : 'Invalid request');
  const client = (provider: Provider) => options.clients?.[provider] ?? clientFor(provider);

  /* ---------- Public ---------- */
  app.get('/', (_q, r) => r.redirect('/dashboard'));
  app.get('/healthz', (_q, r) => r.json({ ok: true }));
  app.get('/login', (_q, r) => (configured ? r.type('html').send(loginPage()) : r.redirect('/dashboard')));
  app.post('/api/auth/login', (req, res) => {
    if (!configured) return res.status(401).json({ error: 'Authentication is not configured' });
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const old = failures.get(ip);
    if (old && old.until > now && old.count >= LOGIN_ATTEMPTS)
      return res.status(429).json({ error: 'Too many attempts, try again later' });
    const passwordOk = basicOk(req);
    const totpOk = !hasTotp(db) || (passwordOk && verifyTotp(db, String(req.body?.code ?? '').trim()));
    if (!passwordOk || !totpOk) {
      const count = (old?.count ?? 0) + 1;
      failures.set(ip, { count, until: now + (count >= LOGIN_ATTEMPTS ? LOCKOUT_MS : 60 * 1000) });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    failures.delete(ip);
    setAuthCookies(req, res, createSession(db));
    return res.json({ ok: true });
  });
  app.post('/api/auth/logout', auth, (req, res) => {
    destroySession(db, cookie(req, 'session'));
    clearAuthCookies(res);
    res.json({ ok: true });
  });

  /* ---------- Admin ---------- */
  app.use(['/dashboard', '/api/admin'], auth);
  app.get('/dashboard', (_q, r) => r.type('html').send(postsPage()));
  app.get('/dashboard/accounts', (_q, r) => r.type('html').send(accountsPage()));
  app.get('/dashboard/security', (_q, r) => r.type('html').send(securityPage()));

  app.get('/api/admin/security', (_q, r) =>
    r.json({ authConfigured: configured, totpConfigured: hasTotp(db) })
  );
  app.post('/api/admin/security/regenerate', async (_q, r) => {
    if (!configured)
      return r.status(400).json({ error: 'Set ADMIN_USERNAME and ADMIN_PASSWORD before enabling TOTP' });
    const s = setup();
    saveTotp(db, s.secret, s.codes);
    return setupResponse(r, s);
  });
  app.post('/api/admin/security/disable', (_q, r) => {
    deleteTotp(db);
    r.json({ ok: true });
  });

  app.get('/api/admin/accounts', (_q, r) => r.json(listAccounts(db)));
  const upsertAccount = async (req: express.Request, res: express.Response, id?: string) => {
    let input;
    try {
      input = parseAccount(req.body);
    } catch (e) {
      return badRequest(res, e);
    }
    if (id && !getAccount(db, id)) return res.sendStatus(404);
    const secrets = input.token ? { token: input.token } : id ? getAccountSecrets(db, id) : undefined;
    if (!secrets) return res.status(400).send('A token or app password is required');
    const candidate = {
      id: id ?? 'pending',
      name: input.name,
      provider: input.provider,
      server: input.server,
      identifier: input.identifier,
      createdAt: 0,
    };
    let identity: string;
    try {
      identity = await client(input.provider).verify(candidate, secrets);
    } catch (e) {
      return res.status(400).send(`Could not verify the account: ${e instanceof Error ? e.message : e}`);
    }
    const saved = saveAccount(db, {
      ...input,
      id,
      secrets: input.token ? { token: input.token } : undefined,
    });
    res.status(id ? 200 : 201).json({ ...saved, identity });
  };
  app.post('/api/admin/accounts', (q, r) => void upsertAccount(q, r));
  app.put('/api/admin/accounts/:id', (q, r) => void upsertAccount(q, r, q.params.id));
  app.post('/api/admin/accounts/:id/verify', async (q, r) => {
    const account = getAccount(db, q.params.id);
    const secrets = account && getAccountSecrets(db, account.id);
    if (!account || !secrets) return r.sendStatus(404);
    try {
      r.json({ identity: await client(account.provider).verify(account, secrets) });
    } catch (e) {
      r.status(400).json({ error: e instanceof Error ? e.message : 'Verification failed' });
    }
  });
  app.delete('/api/admin/accounts/:id', (q, r) => {
    if (!removeAccount(db, q.params.id)) return r.sendStatus(404);
    onChanged();
    r.sendStatus(204);
  });

  const withEvents = (post: ReturnType<typeof getPost>) =>
    post ? { ...post, events: postEvents(db, post.id), media: postMedia(db, post.id) } : undefined;

  /* Images are uploaded as raw bodies: POST /api/admin/media?filename=a.png with an image/* content type. */
  app.post('/api/admin/media', (q, r) => {
    const mime = (q.headers['content-type'] ?? '').split(';')[0].trim();
    if (!IMAGE_TYPES.includes(mime))
      return r.status(415).send(`Unsupported image type; use ${IMAGE_TYPES.join(', ')}`);
    if (!Buffer.isBuffer(q.body) || !q.body.length) return r.status(400).send('Image body is empty');
    const filename =
      String(q.query.filename ?? 'image')
        .replace(/[^\w.-]/g, '_')
        .slice(0, 120) || 'image';
    cleanupMedia(db);
    r.status(201).json(storeMedia(db, { filename, mime, data: q.body, alt: String(q.query.alt ?? '') }));
  });
  app.get('/api/admin/media/:id', (q, r) => {
    const item = mediaData(db, q.params.id);
    if (!item) return r.sendStatus(404);
    r.setHeader('Cache-Control', 'private, max-age=3600');
    r.type(item.mime).send(item.data);
  });
  app.delete('/api/admin/media/:id', (q, r) =>
    removeMedia(db, q.params.id) ? r.sendStatus(204) : r.sendStatus(404)
  );
  app.get('/api/admin/posts', (q, r) => {
    const status = typeof q.query.status === 'string' ? (q.query.status as any) : undefined;
    r.json(listPosts(db, status).map((p) => withEvents(p)));
  });
  app.get('/api/admin/posts/stats', (_q, r) => r.json(stats(db)));
  app.get('/api/admin/posts/:id', (q, r) => {
    const post = withEvents(getPost(db, q.params.id));
    return post ? r.json(post) : r.sendStatus(404);
  });
  app.post('/api/admin/posts', (q, r) => {
    try {
      const post = createPost(db, parsePost(db, q.body));
      onChanged();
      r.status(201).json(withEvents(post));
    } catch (e) {
      badRequest(r, e);
    }
  });
  app.put('/api/admin/posts/:id', (q, r) => {
    if (!getPost(db, q.params.id)) return r.sendStatus(404);
    try {
      const post = updatePost(db, q.params.id, parsePost(db, q.body));
      onChanged();
      r.json(withEvents(post));
    } catch (e) {
      badRequest(r, e);
    }
  });
  app.post('/api/admin/posts/:id/cancel', (q, r) => {
    const post = getPost(db, q.params.id);
    if (!post) return r.sendStatus(404);
    if (post.status !== 'scheduled') return r.status(400).send('Only scheduled posts can be cancelled');
    r.json(withEvents(setPostStatus(db, post.id, 'cancelled', 'Cancelled from the dashboard')));
  });
  app.post('/api/admin/posts/:id/publish', (q, r) => {
    const post = getPost(db, q.params.id);
    if (!post) return r.sendStatus(404);
    if (!['draft', 'failed', 'cancelled'].includes(post.status))
      return r.status(400).send(`A ${post.status} post cannot be published now`);
    const queued = retryPost(db, post.id);
    onChanged();
    r.json(withEvents(queued));
  });
  app.delete('/api/admin/posts/:id', (q, r) => {
    const post = getPost(db, q.params.id);
    if (!post) return r.sendStatus(404);
    if (post.status === 'publishing') return r.status(400).send('Wait until publishing finishes');
    removePost(db, post.id);
    r.sendStatus(204);
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as any)?.type === 'entity.parse.failed' ? 400 : ((error as any)?.status ?? 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status === 400 ? 'Invalid JSON body' : 'Internal server error' });
  });
  return app;
}
