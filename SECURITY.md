# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). You will get an acknowledgement within a few days and a fix or mitigation as soon as possible; the report is credited in the release notes unless you prefer otherwise.

## Scope

Post Scheduler is a single-process service meant to run behind your own reverse proxy. Reports about the following are especially welcome:

- Authentication, session, CSRF, or TOTP bypasses on the admin dashboard
- Data exposure through public endpoints
- Server-side request forgery through user-supplied URLs
- Injection in rendered pages

Vulnerabilities in third-party dependencies are handled through Dependabot and `npm audit` in CI; a report is still useful when a fix is urgent.

## Supported versions

Only the latest release on `main` receives fixes.
