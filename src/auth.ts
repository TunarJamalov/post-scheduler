import type Database from 'better-sqlite3';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  scryptSync,
} from 'node:crypto';

const b64 = (v: Buffer) => v.toString('base64url');
const key = () =>
  createHash('sha256')
    .update(process.env.AUTH_ENCRYPTION_KEY ?? '')
    .digest();
const digest = (v: string) => createHash('sha256').update(v).digest('hex');

export function initAuth(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_totp (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL, recovery_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);`);
}
export function validateAuthEncryptionKey(value = process.env.AUTH_ENCRYPTION_KEY) {
  if (!value || value.length < 32 || /^(change-me|replace-me|secret|password)/i.test(value)) {
    throw new Error('AUTH_ENCRYPTION_KEY must be at least 32 characters of high-entropy secret material');
  }
}
export function encrypted(value: string) {
  if (!process.env.AUTH_ENCRYPTION_KEY) throw new Error('AUTH_ENCRYPTION_KEY is required');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  return `${b64(iv)}.${b64(Buffer.concat([cipher.update(value), cipher.final()]))}.${b64(cipher.getAuthTag())}`;
}
export function decrypted(value: string) {
  const [iv, body, tag] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString();
}
function recoveryHash(code: string) {
  const salt = randomBytes(16);
  return `${b64(salt)}.${b64(scryptSync(code, salt, 32))}`;
}
function recoveryMatches(code: string, stored: string) {
  const [salt, hash] = stored.split('.');
  const actual = scryptSync(code, Buffer.from(salt, 'base64url'), 32);
  const expected = Buffer.from(hash, 'base64url');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function hasTotp(db: Database.Database) {
  return Boolean(db.prepare('SELECT id FROM auth_totp WHERE id=1').get());
}
export function saveTotp(db: Database.Database, secret: string, codes: string[]) {
  db.prepare(
    'INSERT INTO auth_totp(id,secret,recovery_json,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,recovery_json=excluded.recovery_json,updated_at=excluded.updated_at'
  ).run(encrypted(secret), JSON.stringify(codes.map(recoveryHash)), Date.now());
}
export function deleteTotp(db: Database.Database) {
  db.prepare('DELETE FROM auth_totp WHERE id=1').run();
}
export function verifyTotp(db: Database.Database, value: string) {
  const row = db.prepare('SELECT secret,recovery_json as recovery FROM auth_totp WHERE id=1').get() as
    { secret: string; recovery: string } | undefined;
  if (!row) return false;
  let secret: string;
  try {
    secret = decrypted(row.secret);
  } catch {
    return false;
  }
  if (/^\d{6}$/.test(value)) {
    const counter = Math.floor(Date.now() / 30000);
    for (let offset = -1; offset <= 1; offset++) if (totp(secret, counter + offset) === value) return true;
  }
  const codes = JSON.parse(row.recovery) as string[];
  const index = codes.findIndex((code) => recoveryMatches(value.toUpperCase(), code));
  if (index < 0) return false;
  codes.splice(index, 1);
  db.prepare('UPDATE auth_totp SET recovery_json=?,updated_at=? WHERE id=1').run(
    JSON.stringify(codes),
    Date.now()
  );
  return true;
}
function totp(secret: string, counter: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const n = alphabet.indexOf(c);
    if (n >= 0) bits += n.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  bytes.writeUInt32BE(counter >>> 0, 4);
  const hash = createHmac('sha1', Buffer.from(bits.match(/.{8}/g)?.map((x) => parseInt(x, 2)) ?? []))
    .update(bytes)
    .digest();
  const at = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(at) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function createSession(db: Database.Database) {
  const token = b64(randomBytes(32)),
    csrf = b64(randomBytes(32)),
    now = Date.now();
  db.prepare(
    'INSERT INTO auth_sessions(token_hash,csrf_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)'
  ).run(digest(token), digest(csrf), now, now + 8 * 60 * 60 * 1000, now);
  return { token, csrf };
}
export function session(db: Database.Database, token: string | undefined) {
  if (!token) return undefined;
  const row = db
    .prepare(
      'SELECT token_hash as tokenHash,csrf_hash as csrfHash,expires_at as expiresAt FROM auth_sessions WHERE token_hash=?'
    )
    .get(digest(token)) as any;
  if (!row || row.expiresAt < Date.now()) {
    if (row) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest(token));
    return undefined;
  }
  db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=?').run(Date.now(), row.tokenHash);
  return row;
}
export function destroySession(db: Database.Database, token: string | undefined) {
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest(token));
}
export function validCsrf(row: any, token: string | undefined) {
  return Boolean(
    token &&
    row &&
    (() => {
      const a = Buffer.from(digest(token));
      const b = Buffer.from(row.csrfHash);
      return a.length === b.length && timingSafeEqual(a, b);
    })()
  );
}
export function basicCredentials(req: { headers: { authorization?: string } }) {
  const value = req.headers.authorization;
  if (!value?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(value.slice(6), 'base64').toString();
  const i = decoded.indexOf(':');
  return i < 0 ? undefined : { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}
export function randomTotpSetup() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  for (let i = 0; i < 32; i++) secret += alphabet[randomBytes(1)[0] % alphabet.length];
  const codes = Array.from({ length: 10 }, () => b64(randomBytes(6)).slice(0, 10).toUpperCase());
  return { secret, codes };
}
