# Shastra — Vedic Deep Research

A private, source-grounded research workspace for investigating Vedic texts in English, Sanskrit, and Gujarati. The app searches and reads pages on `vedic.study`, streams a cited report, and can render Mermaid diagrams inline.

## What is included

- Next.js App Router app with a responsive cream-and-glass research dashboard.
- Standard, Deep, and Really deep research modes (5 / 15 / 30 maximum model steps).
- English and Gujarati report-language selection.
- Anthropic model integration through the Vercel AI SDK. API keys remain on the server.
- Playwright search and article extraction, restricted to HTTPS URLs on `vedic.study` and its subdomains.
- Optional Playwright storage state for a site account you are authorized to use.
- Devanagari and Gujarati script normalization with original text preserved beside a Latin transliteration.
- Markdown reports with sanitized rendering, inline source links, and Mermaid diagrams.
- Shared-password app access with signed, HTTP-only, 12-hour session cookies.
- Unit tests for transliteration and the source-domain boundary.

## Requirements

- Node.js 20 or newer.
- An Anthropic API key.
- An app password and a random session-signing secret.
- Chromium for Playwright. Install it with the command below.
- An authorized `vedic.study` account only if the pages you need are gated.

## Local setup

```bash
npm install
npx playwright install chromium
cp .env.example .env.local
```

Set these values in `.env.local`:

```dotenv
ANTHROPIC_API_KEY=your-server-side-key
APP_ACCESS_PASSWORD=choose-a-long-private-password
SESSION_SECRET=generate-a-random-secret-at-least-32-characters-long
```

Keep `.env.local` private; it is ignored by Git. For example, generate a session secret with:

```bash
openssl rand -base64 48
```

If `vedic.study` requires a signed-in session, capture it locally using an account you are permitted to use:

```bash
npm run capture:vedic-session
```

The helper opens a normal browser, lets you sign in yourself, and saves Playwright's cookies and local storage to `.auth/vedic-study.json`. This file contains sensitive session data: it is excluded from Git, must not be committed or shared, and must be transferred to the server only through a private file/secrets mechanism. Then set:

```dotenv
VEDIC_STUDY_STORAGE_STATE_PATH=.auth/vedic-study.json
```

If the site relies on session storage, configure the needed string-valued storage map using `VEDIC_STUDY_SESSION_STORAGE_JSON` in the deployment's secret manager. Do not place account credentials in source code. The scraper does not disguise automation, defeat a WAF, or circumvent an access denial; it reports access errors and expects valid authorization.

Run the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in with `APP_ACCESS_PASSWORD`, and start a research conversation.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes for research | Server-side model API key |
| `ANTHROPIC_MODEL` | No | Model name; defaults to `claude-sonnet-5-5` |
| `APP_ACCESS_PASSWORD` | Yes | Shared sign-in password for this private instance |
| `SESSION_SECRET` | Yes | Random secret of at least 32 characters for signed sessions |
| `VEDIC_STUDY_STORAGE_STATE_PATH` | No | Server-side path to an authorized Playwright storage-state file |
| `VEDIC_STUDY_SESSION_STORAGE_JSON` | No | Server-side JSON object for session storage values, if the site needs them |
| `VEDIC_SEARCH_URL_TEMPLATE` | No | HTTPS search page template; `{query}` is URL-encoded |

The app is designed as a single private instance with one shared password, not as a multi-user identity system. Use HTTPS when deploying it and keep API keys and browser-session data in the deployment's secret manager or private file storage.

## Access to vedic.study

As of October 2026 the site is invite-only: unauthenticated requests are redirected to a "Not Yet Open" sign-in gate, and the bare `vedic.study` domain does not resolve (use `www.vedic.study`). The app detects the gate and reports it rather than trying to get around it. You need an invited account: run `npm run capture:vedic-session`, sign in yourself, and the saved state (including IndexedDB, where the site keeps its sign-in) is used for research. The search selectors have not been verified against signed-in pages, so check a first search result before relying on the agent.

## How the agent works

- Parallel searches and full-page reads, with long pages paged through an `offset`, and same-site links returned from each page so the agent can follow commentary and parallel passages.
- The last allowed step always has tools disabled, so a run always ends in a written report; earlier steps get phase guidance (explore, deepen, close gaps).
- Citations are checked in the UI: links that no tool returned are tagged "unverified".
- Search and page results are cached for ten minutes and browser use is limited to three concurrent pages.

## Research and source limitations

Reports are instructed to use retrieved `vedic.study` text as evidence and cite the exact pages returned by the scraper. Site search selectors and routes can change; the default search path is `https://www.vedic.study/search?q=...`, which can be overridden with `VEDIC_SEARCH_URL_TEMPLATE`. Results are extracted from same-site links and article text, so verify important quotations and translations against their source pages. No research result is guaranteed to be exhaustive or a substitute for scholarly review.