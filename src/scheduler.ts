import type Database from 'better-sqlite3';
import {
  SEGMENT_LIMITS,
  claimDuePosts,
  getAccount,
  getAccountSecrets,
  markFailed,
  markPublished,
  type Post,
  type Provider,
} from './db.js';
import { clientFor, type PublishClient, type PublishedItem } from './providers.js';

export const THREAD_SEPARATOR = /\n\s*---\s*\n/;

/** Splits composer text into thread segments on lines containing only "---". */
export function splitThread(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(THREAD_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Returns the first validation problem of the given segments for a provider, or undefined. */
export function validateSegments(segments: string[], provider: Provider): string | undefined {
  if (!segments.length) return 'Post text is empty';
  const limit = SEGMENT_LIMITS[provider];
  const index = segments.findIndex((s) => [...s].length > limit);
  if (index >= 0)
    return `Part ${index + 1} has ${[...segments[index]].length} characters; ${provider} allows ${limit}`;
  return undefined;
}

export interface SchedulerOptions {
  maxAttempts: number;
  retryDelayMs: number;
  clients?: Partial<Record<Provider, PublishClient>>;
  log?: (message: string) => void;
}

/** Publishes one post (all of its thread segments in order). Returns the first published item. */
export async function publishPost(
  db: Database.Database,
  post: Post,
  options: SchedulerOptions
): Promise<PublishedItem> {
  const account = getAccount(db, post.accountId);
  const secrets = account && getAccountSecrets(db, account.id);
  if (!account || !secrets) throw new Error('Account no longer exists');
  const client = options.clients?.[account.provider] ?? clientFor(account.provider);
  let previous: PublishedItem | undefined;
  let first: PublishedItem | undefined;
  for (const segment of post.segments) {
    previous = await client.publish(account, secrets, segment, previous);
    first ??= previous;
  }
  return first!;
}

/** One scheduler pass: claims due posts and publishes them. Safe to call concurrently. */
export async function runDuePosts(db: Database.Database, options: SchedulerOptions, now = Date.now()) {
  const log = options.log ?? (() => {});
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const post of claimDuePosts(db, now)) {
    try {
      const item = await publishPost(db, post, options);
      markPublished(db, post.id, item.id, item.url, now);
      log(`Published ${post.id} -> ${item.url ?? item.id}`);
      results.push({ id: post.id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markFailed(db, post.id, message, options.maxAttempts, options.retryDelayMs, now);
      log(`Publishing ${post.id} failed: ${message}`);
      results.push({ id: post.id, ok: false, error: message });
    }
  }
  return results;
}

export function startScheduler(db: Database.Database, options: SchedulerOptions & { intervalMs: number }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDuePosts(db, options);
    } catch (error) {
      (options.log ?? console.error)(`Scheduler error: ${error instanceof Error ? error.message : error}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs);
  return { stop: () => clearInterval(timer), tick };
}
