# Contributing

Thanks for helping improve Post Scheduler.

## Development

```sh
npm install
cp .env.example .env
npm run dev     # run from sources
npm test        # run the test suite
npm run lint    # type-check and formatting
npm run format  # format with Prettier
```

The project is intentionally small: TypeScript, Express, SQLite through better-sqlite3, server-rendered HTML with plain client scripts, no bundler. Keep it that way; a pull request that adds a framework or a build pipeline needs a strong reason.

## Pull requests

- Open an issue first for larger changes so the direction can be agreed.
- Add or update tests for behaviour you change. CI runs lint, tests, build, and an audit.
- Keep the README accurate; it documents what the code actually does.
- Do not include secrets, real credentials, or production databases in commits.

## Reporting bugs

Include the version or commit, your Node.js version, the relevant `.env` keys (without values), and what you expected to happen. Security issues go through [SECURITY.md](SECURITY.md), not the issue tracker.

This project is part of the [open-source SaaS alternatives](https://github.com/TunarJamalov/open-source-saas-alternatives) catalog.
