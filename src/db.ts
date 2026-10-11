import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decrypted, encrypted, initAuth } from './auth.js';

export type Provider = 'mastodon' | 'bluesky';
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export interface Account {
  id: string;
  name: string;
  provider: Provider;
  /** Mastodon: instance URL. Bluesky: PDS URL (default https://bsky.social). */
  server: string;
  /** Mastodon: not used. Bluesky: handle or email. */
  identifier: string;
  createdAt: number;
}
export interface AccountSecrets {
  /** Mastodon access token, or Bluesky app password. */
  token: string;
}
export interface Post {
  id: string;
  accountId: string;
  /** Thread segments in order. A single-segment thread is a normal post. */
  segments: string[];
  status: PostStatus;
  scheduledAt: number | null;
  publishedAt: number | null;
  remoteId: string | null;
  remoteUrl: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}
export interface MediaItem {
  id: string;
  postId: string | null;
  /** Thread part the image belongs to (0-based). */
  segment: number;
  position: number;
  filename: string;
  mime: string;
  size: number;
  alt: string;
  createdAt: number;
}
export interface MediaAttachment {
  id: string;
  segment: number;
  alt: string;
}
export interface PostEvent {
  id: number;
  postId: string;
  at: number;
  event: string;
  detail: string | null;
}

export const SEGMENT_LIMITS: Record<Provider, number> = { mastodon: 500, bluesky: 300 };
/** Maximum image size per provider in bytes. */
export const MEDIA_LIMITS: Record<Provider, number> = { mastodon: 16 * 1024 * 1024, bluesky: 1_000_000 };
export const MAX_IMAGES_PER_PART = 4;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function openDatabase(filename: string): Database.Database {
  const dir = path.dirname(filename);
  if (dir !== '.' && filename !== ':memory:') fs.mkdirSync(dir, { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initAuth(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      server TEXT NOT NULL,
      identifier TEXT NOT NULL DEFAULT '',
      secrets_encrypted TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      segments_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at INTEGER,
      published_at INTEGER,
      remote_id TEXT,
      remote_url TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      event TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
      segment INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      alt TEXT NOT NULL DEFAULT '',
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS media_post ON media(post_id, segment, position);
    CREATE INDEX IF NOT EXISTS post_events_post ON post_events(post_id, at);
  `);
  return db;
}

/* ---------- Accounts ---------- */
const accountColumns = 'id,name,provider,server,identifier,created_at as createdAt FROM accounts';

export function listAccounts(db: Database.Database): Account[] {
  return db.prepare(`SELECT ${accountColumns} ORDER BY name`).all() as Account[];
}
export function getAccount(db: Database.Database, id: string): Account | undefined {
  return db.prepare(`SELECT ${accountColumns} WHERE id=?`).get(id) as Account | undefined;
}
export function getAccountSecrets(db: Database.Database, id: string): AccountSecrets | undefined {
  const row = db.prepare('SELECT secrets_encrypted as secrets FROM accounts WHERE id=?').get(id) as
    { secrets: string } | undefined;
  return row ? (JSON.parse(decrypted(row.secrets)) as AccountSecrets) : undefined;
}
export function saveAccount(
  db: Database.Database,
  input: Omit<Account, 'id' | 'createdAt'> & { id?: string; secrets?: AccountSecrets }
): Account {
  const id = input.id ?? randomUUID();
  const existing = input.id ? getAccount(db, input.id) : undefined;
  if (!existing && !input.secrets?.token) throw new Error('A token or app password is required');
  const secrets = input.secrets?.token
    ? JSON.stringify(input.secrets)
    : (db.prepare('SELECT secrets_encrypted as s FROM accounts WHERE id=?').get(id) as any).s;
  const stored = input.secrets?.token ? encrypted(secrets) : secrets;
  db.prepare(
    `INSERT INTO accounts (id,name,provider,server,identifier,secrets_encrypted,created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,server=excluded.server,identifier=excluded.identifier,secrets_encrypted=excluded.secrets_encrypted`
  ).run(
    id,
    input.name,
    input.provider,
    input.server,
    input.identifier,
    stored,
    existing?.createdAt ?? Date.now()
  );
  return getAccount(db, id)!;
}
export function removeAccount(db: Database.Database, id: string) {
  return db.prepare('DELETE FROM accounts WHERE id=?').run(id).changes > 0;
}

/* ---------- Posts ---------- */
const postColumns =
  'id,account_id as accountId,segments_json as segmentsJson,status,scheduled_at as scheduledAt,published_at as publishedAt,remote_id as remoteId,remote_url as remoteUrl,error,attempts,created_at as createdAt,updated_at as updatedAt FROM posts';
const toPost = (row: any): Post => {
  const { segmentsJson, ...rest } = row;
  return { ...rest, segments: JSON.parse(segmentsJson) };
};

export function listPosts(db: Database.Database, status?: PostStatus): Post[] {
  return db
    .prepare(
      `SELECT ${postColumns}${status ? ' WHERE status=?' : ''} ORDER BY COALESCE(scheduled_at, created_at) DESC`
    )
    .all(...(status ? [status] : []))
    .map(toPost);
}
export interface PostInput {
  accountId: string;
  segments: string[];
  scheduledAt: number | null;
  status?: 'draft' | 'scheduled';
  media?: MediaAttachment[];
}

export function getPost(db: Database.Database, id: string): Post | undefined {
  const row = db.prepare(`SELECT ${postColumns} WHERE id=?`).get(id);
  return row ? toPost(row) : undefined;
}
export function createPost(db: Database.Database, input: PostInput): Post {
  const id = randomUUID();
  const now = Date.now();
  const status = input.status ?? (input.scheduledAt ? 'scheduled' : 'draft');
  db.prepare(
    'INSERT INTO posts (id,account_id,segments_json,status,scheduled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, input.accountId, JSON.stringify(input.segments), status, input.scheduledAt, now, now);
  attachMedia(db, id, input.media ?? []);
  addEvent(
    db,
    id,
    'created',
    status === 'scheduled' ? `Scheduled for ${new Date(input.scheduledAt!).toISOString()}` : 'Saved as draft'
  );
  return getPost(db, id)!;
}
export function updatePost(db: Database.Database, id: string, input: PostInput): Post {
  const current = getPost(db, id);
  if (!current) throw new Error('Post not found');
  if (current.status === 'published' || current.status === 'publishing')
    throw new Error('Published posts cannot be edited');
  const status = input.status ?? (input.scheduledAt ? 'scheduled' : 'draft');
  db.prepare(
    'UPDATE posts SET account_id=?,segments_json=?,status=?,scheduled_at=?,error=NULL,attempts=0,updated_at=? WHERE id=?'
  ).run(input.accountId, JSON.stringify(input.segments), status, input.scheduledAt, Date.now(), id);
  attachMedia(db, id, input.media ?? []);
  addEvent(
    db,
    id,
    'updated',
    status === 'scheduled' ? `Scheduled for ${new Date(input.scheduledAt!).toISOString()}` : 'Saved as draft'
  );
  return getPost(db, id)!;
}
/* ---------- Media ---------- */
const mediaColumns =
  'id,post_id as postId,segment,position,filename,mime,size,alt,created_at as createdAt FROM media';

export function storeMedia(
  db: Database.Database,
  input: { filename: string; mime: string; data: Buffer; alt?: string }
): MediaItem {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO media (id,post_id,segment,position,filename,mime,size,alt,data,created_at) VALUES (?,NULL,0,0,?,?,?,?,?,?)'
  ).run(id, input.filename, input.mime, input.data.length, input.alt ?? '', input.data, Date.now());
  return getMedia(db, id)!;
}
export function getMedia(db: Database.Database, id: string): MediaItem | undefined {
  return db.prepare(`SELECT ${mediaColumns} WHERE id=?`).get(id) as MediaItem | undefined;
}
export function mediaData(db: Database.Database, id: string): { mime: string; data: Buffer } | undefined {
  return db.prepare('SELECT mime,data FROM media WHERE id=?').get(id) as
    { mime: string; data: Buffer } | undefined;
}
export function postMedia(db: Database.Database, postId: string): MediaItem[] {
  return db
    .prepare(`SELECT ${mediaColumns} WHERE post_id=? ORDER BY segment,position`)
    .all(postId) as MediaItem[];
}
/** Links uploaded media to a post in the given order; media no longer listed is detached from the post. */
export function attachMedia(db: Database.Database, postId: string, attachments: MediaAttachment[]) {
  db.transaction(() => {
    db.prepare('UPDATE media SET post_id=NULL WHERE post_id=?').run(postId);
    const counters = new Map<number, number>();
    const link = db.prepare(
      'UPDATE media SET post_id=?,segment=?,position=?,alt=? WHERE id=? AND (post_id IS NULL OR post_id=?)'
    );
    for (const a of attachments) {
      const position = counters.get(a.segment) ?? 0;
      counters.set(a.segment, position + 1);
      if (!link.run(postId, a.segment, position, a.alt, a.id, postId).changes)
        throw new Error(`Unknown media ${a.id}`);
    }
  })();
}
export function removeMedia(db: Database.Database, id: string) {
  return db.prepare('DELETE FROM media WHERE id=? AND post_id IS NULL').run(id).changes > 0;
}
/** Deletes uploads that were never attached to a post. */
export function cleanupMedia(db: Database.Database, olderThanMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  return db.prepare('DELETE FROM media WHERE post_id IS NULL AND created_at < ?').run(now - olderThanMs)
    .changes;
}

export function setPostStatus(db: Database.Database, id: string, status: PostStatus, detail?: string) {
  db.prepare('UPDATE posts SET status=?,updated_at=? WHERE id=?').run(status, Date.now(), id);
  addEvent(db, id, status, detail ?? null);
  return getPost(db, id);
}
export function removePost(db: Database.Database, id: string) {
  return db.prepare('DELETE FROM posts WHERE id=?').run(id).changes > 0;
}
export function addEvent(
  db: Database.Database,
  postId: string,
  event: string,
  detail: string | null = null,
  at = Date.now()
) {
  db.prepare('INSERT INTO post_events (post_id,at,event,detail) VALUES (?,?,?,?)').run(
    postId,
    at,
    event,
    detail
  );
}
export function postEvents(db: Database.Database, postId: string): PostEvent[] {
  return db
    .prepare(
      'SELECT id,post_id as postId,at,event,detail FROM post_events WHERE post_id=? ORDER BY at DESC LIMIT 50'
    )
    .all(postId) as PostEvent[];
}

/* ---------- Scheduler helpers ---------- */
/** Atomically claims due posts so two ticks never publish the same post twice. */
export function claimDuePosts(db: Database.Database, now = Date.now()): Post[] {
  return db.transaction(() => {
    const due = db
      .prepare(
        `SELECT ${postColumns} WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at`
      )
      .all(now)
      .map(toPost);
    const claim = db.prepare(
      "UPDATE posts SET status='publishing',attempts=attempts+1,updated_at=? WHERE id=? AND status='scheduled'"
    );
    return due
      .filter((post) => claim.run(now, post.id).changes > 0)
      .map((post) => ({ ...post, status: 'publishing' as const, attempts: post.attempts + 1 }));
  })();
}
export function markPublished(
  db: Database.Database,
  id: string,
  remoteId: string,
  remoteUrl: string | null,
  at = Date.now()
) {
  db.prepare(
    "UPDATE posts SET status='published',published_at=?,remote_id=?,remote_url=?,error=NULL,updated_at=? WHERE id=?"
  ).run(at, remoteId, remoteUrl, at, id);
  addEvent(db, id, 'published', remoteUrl ?? remoteId, at);
}
/** Records a failure and either re-queues the post with a delay or marks it failed for good. */
export function markFailed(
  db: Database.Database,
  id: string,
  error: string,
  maxAttempts: number,
  retryDelayMs: number,
  at = Date.now()
) {
  const post = getPost(db, id);
  if (!post) return;
  const giveUp = post.attempts >= maxAttempts;
  db.prepare('UPDATE posts SET status=?,scheduled_at=?,error=?,updated_at=? WHERE id=?').run(
    giveUp ? 'failed' : 'scheduled',
    giveUp ? post.scheduledAt : at + retryDelayMs,
    error,
    at,
    id
  );
  addEvent(db, id, giveUp ? 'failed' : 'retry', `${error} (attempt ${post.attempts}/${maxAttempts})`, at);
}
export function retryPost(db: Database.Database, id: string, at = Date.now()) {
  db.prepare(
    "UPDATE posts SET status='scheduled',scheduled_at=?,attempts=0,error=NULL,updated_at=? WHERE id=? AND status IN ('failed','draft','cancelled')"
  ).run(at, at, id);
  addEvent(db, id, 'queued', 'Queued for immediate publishing', at);
  return getPost(db, id);
}

export function stats(db: Database.Database) {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM posts GROUP BY status').all() as {
    status: PostStatus;
    count: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Partial<Record<PostStatus, number>>;
}

/* ---------- Settings ---------- */
export function getSetting<T>(db: Database.Database, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}
export function setSetting(db: Database.Database, key: string, value: unknown) {
  db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, JSON.stringify(value));
}

/* ---------- Queue ---------- */
export const DEFAULT_QUEUE_SLOTS = ['09:00', '13:00', '18:00'];
const SLOT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function queueSlots(db: Database.Database): string[] {
  return getSetting<string[]>(db, 'queueSlots', DEFAULT_QUEUE_SLOTS);
}
/** Validates and stores the daily queue times (HH:MM, server local time). */
export function saveQueueSlots(db: Database.Database, slots: unknown): string[] {
  if (!Array.isArray(slots)) throw new Error('queueSlots must be a list of HH:MM times');
  const cleaned = [...new Set(slots.map((s) => String(s).trim()))].filter(Boolean).sort();
  if (!cleaned.length) throw new Error('Add at least one queue time');
  const bad = cleaned.find((s) => !SLOT_PATTERN.test(s));
  if (bad) throw new Error(`"${bad}" is not a valid HH:MM time`);
  setSetting(db, 'queueSlots', cleaned);
  return cleaned;
}
/**
 * Finds the next queue slot after `now` that has no scheduled post for the account.
 * Times are interpreted in the server's local time zone.
 */
export function nextQueueSlot(
  db: Database.Database,
  accountId: string,
  slots = queueSlots(db),
  now = Date.now()
): number {
  const taken = new Set(
    (
      db
        .prepare(
          "SELECT scheduled_at as at FROM posts WHERE account_id=? AND status='scheduled' AND scheduled_at>?"
        )
        .all(accountId, now) as { at: number }[]
    ).map((r) => r.at)
  );
  const start = new Date(now);
  for (let day = 0; day < 366; day++) {
    for (const slot of slots) {
      const [h, m] = slot.split(':').map(Number);
      const candidate = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + day,
        h,
        m,
        0,
        0
      ).getTime();
      if (candidate > now && !taken.has(candidate)) return candidate;
    }
  }
  throw new Error('No free queue slot found');
}

/** Duplicates an uploaded image so a cross-posted post gets its own attachment. */
export function copyMedia(db: Database.Database, id: string): MediaItem {
  const source = db.prepare('SELECT filename,mime,size,alt,data FROM media WHERE id=?').get(id) as any;
  if (!source) throw new Error(`Unknown media ${id}`);
  const copy = randomUUID();
  db.prepare(
    'INSERT INTO media (id,post_id,segment,position,filename,mime,size,alt,data,created_at) VALUES (?,NULL,0,0,?,?,?,?,?,?)'
  ).run(copy, source.filename, source.mime, source.size, source.alt, source.data, Date.now());
  return getMedia(db, copy)!;
}
