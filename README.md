# Post Scheduler

A small, self-hosted alternative to hosted post schedulers such as Typefully. Write posts and threads, schedule them, and let a single Node.js process publish them to **Mastodon** and **Bluesky** at the right time. Data lives in one SQLite file. No Redis, PostgreSQL, Docker, or external account is required.

> Status: early development. Mastodon and Bluesky publishing work. X/Twitter is not supported.

## Features

- Compose posts with a live character counter per provider (500 for Mastodon, 300 for Bluesky)
- Threads: separate parts with a line containing only `---`; each part is published as a reply to the previous one
- Schedule for a date and time, save as draft, or publish immediately
- Automatic retries with a delay, then a `failed` state with the provider's error message
- Per-post history (created, scheduled, retried, published, failed)
- Multiple accounts per provider; tokens are stored encrypted
- Up to 4 images per thread part with alt text (JPEG, PNG, GIF, WebP)
- Links in Bluesky posts become clickable (rich text facets)
- Admin sign-in with password plus optional TOTP two-factor authentication
- systemd unit for production

## Requirements

Node.js 22 or newer and npm.

## Quick start

```sh
git clone https://github.com/TunarJamalov/post-scheduler.git
cd post-scheduler
npm install
cp .env.example .env
# set AUTH_ENCRYPTION_KEY, for example: openssl rand -base64 48
npm run dev
```

Open `http://localhost:3100/dashboard/accounts`, add an account, then write the first post on `/dashboard`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run from TypeScript sources |
| `npm run build` / `npm start` | Compile to `dist/` and run the build |
| `npm test` | Run the test suite |
| `npm run lint` | Type-check and verify formatting |
| `npm run format` | Format sources with Prettier |

## Connecting accounts

**Mastodon**: on your instance open *Preferences → Development → New application*, grant the `read:accounts` and `write:statuses` scopes, and copy the access token. Enter the instance URL (for example `https://mastodon.social`) and the token.

**Bluesky**: open *Settings → Privacy and security → App passwords* and create one. Enter your handle (for example `you.bsky.social`) and the app password. Never use your main password. The server defaults to `https://bsky.social`; set it to your PDS if you self-host.

Saving an account verifies the credentials against the provider immediately. Tokens are encrypted with `AUTH_ENCRYPTION_KEY` and are never returned by the API.

## How publishing works

The scheduler wakes up every `SCHEDULER_INTERVAL` seconds (default 15) and claims posts whose time has come. Claiming is atomic, so a post is never published twice even if two checks overlap. Each thread part is published in order; the next part replies to the previous one. Images are uploaded to the provider right before the part they belong to. Bluesky accepts images up to 1 MB; the dashboard rejects larger files for Bluesky accounts when the post is saved. Uploads that are never attached to a post are deleted after 24 hours. On an error the post is re-queued two minutes later, up to `MAX_ATTEMPTS` times (default 3), and then marked `failed` with the error shown in the dashboard. *Publish now* on a draft, failed, or cancelled post queues it immediately.

If a thread fails halfway, the parts that were already published stay online and the post is retried from the first part. Check the provider before retrying a partially published thread.

## Admin authentication

`AUTH_ENCRYPTION_KEY` is always required because it protects stored account tokens. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to require sign-in for `/dashboard` and `/api/admin/*`. Sessions last 8 hours, state-changing requests need the CSRF token the dashboard sends automatically, and failed sign-ins are rate limited. Enable TOTP on `/dashboard/security` and keep the recovery codes offline.

Without admin credentials the dashboard is open. Only run it that way on a private network.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3100` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `loopback` | Express `trust proxy` setting; `true` behind a remote reverse proxy |
| `DATABASE_PATH` | `./data/posts.db` | SQLite database file |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | empty | Admin credentials; both required to enable sign-in |
| `AUTH_ENCRYPTION_KEY` | empty | Required. Encrypts account tokens and the TOTP secret; at least 32 random characters |
| `SCHEDULER_INTERVAL` | `15` | Seconds between scheduler passes |
| `MAX_ATTEMPTS` | `3` | Publish attempts before a post is marked failed |

## API

All admin endpoints are under `/api/admin` and return JSON.

| Method and path | Description |
| --- | --- |
| `GET /accounts`, `POST /accounts`, `PUT /accounts/:id`, `DELETE /accounts/:id` | Manage accounts. `POST`/`PUT` take `name`, `provider`, `server`, `identifier`, `token` and verify the credentials |
| `POST /accounts/:id/verify` | Re-check stored credentials |
| `GET /posts`, `GET /posts/:id`, `GET /posts/stats` | List posts with their history |
| `POST /posts`, `PUT /posts/:id` | Take `accountId`, `text` (or `segments`), `scheduledAt` (ms timestamp or null), optional `status: "draft"` |
| `POST /posts/:id/cancel`, `POST /posts/:id/publish`, `DELETE /posts/:id` | Cancel a scheduled post, queue a post now, delete a post |
| `POST /media?filename=a.png` (raw image body), `GET /media/:id`, `DELETE /media/:id` | Upload an image, fetch it, delete an unattached upload. Attach uploads to a post with `media: [{ id, segment, alt }]` |

## Production deployment

```sh
sudo useradd --system --home /opt/post-scheduler scheduler
sudo git clone https://github.com/TunarJamalov/post-scheduler.git /opt/post-scheduler
cd /opt/post-scheduler
sudo -u scheduler npm ci && sudo -u scheduler npm run build
sudo cp .env.example .env   # then edit .env
sudo cp systemd/post-scheduler.service /etc/systemd/system/
sudo systemctl enable --now post-scheduler
```

Put a reverse proxy with TLS in front of the service and set `NODE_ENV=production` so session cookies are marked `Secure`.

## Limitations

- Images only; no video or audio uploads.
- No X/Twitter, LinkedIn, or Threads support.
- No preview of how a post renders on each network.
- The scheduler runs inside the web process; if the process is down at the scheduled time the post is published as soon as it starts again.

## License

MIT. See `LICENSE`.
