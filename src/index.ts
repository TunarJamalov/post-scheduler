import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true });
import { openDatabase } from './db.js';
import { startScheduler } from './scheduler.js';
import { createServer } from './server.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/posts.db');
const intervalMs = Math.max(5, Number(process.env.SCHEDULER_INTERVAL ?? 15) || 15) * 1000;
const maxAttempts = Math.max(1, Number(process.env.MAX_ATTEMPTS ?? 3) || 3);

const scheduler = startScheduler(db, {
  intervalMs,
  maxAttempts,
  retryDelayMs: 2 * 60 * 1000,
  log: (message) => console.log(`[scheduler] ${message}`),
});

// "Publish now" and newly due edits should not wait for the next interval.
const app = createServer(db, { onChanged: () => void scheduler.tick() });

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '0.0.0.0';
const server = app.listen(port, host, () =>
  console.log(`Post scheduler listening on http://${host}:${port}`)
);
server.on('error', (error) => {
  console.error(`Cannot listen on port ${port}: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
