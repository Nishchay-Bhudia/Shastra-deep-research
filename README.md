# Shastra — Vedic Deep Research

A private, source-grounded research workspace for investigating Vedic texts in English, Sanskrit, and Gujarati. The app searches and reads pages on `vedic.study`, streams a cited report, and can render Mermaid diagrams inline.

## What is included

- Next.js App Router app with a responsive cream-and-glass research dashboard.
- Standard, Deep, and Really deep research modes. There is no fixed step limit: the agent keeps researching until its sub-questions are covered (runaway ceilings only, see `RESEARCH_MAX_STEPS` / `RESEARCH_MAX_MINUTES`).
- One-click PDF download of any report (Devanagari, Gujarati, tables and diagrams included), rendered server-side with Chromium.
- English and Gujarati report-language selection.
- Mistral model integration (default `ministral-14b-latest`, chosen for low cost) through the Vercel AI SDK. API keys remain on the server.
- Playwright search and article extraction, restricted to HTTPS URLs on `vedic.study` and its subdomains.
- One-time `npm run login` that saves your own signed-in session; the app then researches without further sign-in.
- Devanagari and Gujarati script normalization with original text preserved beside a Latin transliteration.
- Markdown reports with sanitized rendering, inline source links, and Mermaid diagrams.
- Shared-password app access with signed, HTTP-only, 12-hour session cookies.
- Unit tests for transliteration and the source-domain boundary.

## Requirements

- Node.js 20 or newer.
- A Mistral API key.
- An app password and a random session-signing secret.
- Chromium for Playwright. Install it with the command below.
- An invited `vedic.study` account and Google Chrome (for the one-time `npm run login`).

## Local setup

```bash
npm install
npx playwright install chromium
cp .env.example .env.local
```

Set these values in `.env.local`:

```dotenv
MISTRAL_API_KEY=your-server-side-key
APP_ACCESS_PASSWORD=choose-a-long-private-password
SESSION_SECRET=generate-a-random-secret-at-least-32-characters-long
```

Keep `.env.local` private; it is ignored by Git. For example, generate a session secret with:

```bash
openssl rand -base64 48
```

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
| `MISTRAL_API_KEY` | Yes for research | Server-side model API key |
| `MISTRAL_MODEL` | No | Model name; defaults to `ministral-14b-latest` (low cost, 262k context) |
| `APP_ACCESS_PASSWORD` | Yes | Shared sign-in password for this private instance |
| `SESSION_SECRET` | Yes | Random secret of at least 32 characters for signed sessions |
| `RESEARCH_MAX_STEPS` / `RESEARCH_MAX_MINUTES` | No | Runaway ceilings (defaults: 40/150/500 steps by depth, 60 minutes) |
| `VEDIC_STUDY_STORAGE_STATE_PATH` | No | Session file written by `npm run login`; defaults to `.auth/vedic-study.json` |
| `VEDIC_STUDY_SESSION_STORAGE_JSON` | No | Server-side JSON object for session storage values, if the site needs them |
| `VEDIC_SEARCH_URL_TEMPLATE` | No | HTTPS search page template; `{query}` is URL-encoded |

The app is designed as a single private instance with one shared password, not as a multi-user identity system. Use HTTPS when deploying it and keep API keys and browser-session data in the deployment's secret manager or private file storage.

## Access to vedic.study

The site is invite-only: unauthenticated requests are redirected to a "Not Yet Open" sign-in gate (and the bare `vedic.study` domain does not resolve; use `www.vedic.study`). The app never tries to get around the gate. Instead you sign in once, yourself, and it reuses that session.

```bash
npm run login
```

This opens your own Google Chrome with a dedicated profile (`~/.shastra-chrome`). Sign in to vedic.study there the way you normally do, Google included. Google blocks sign-in inside automated browsers, which is why the script attaches to real Chrome instead. As soon as it sees you are signed in, it saves the session (cookies plus the site's Firebase sign-in from IndexedDB) to `.auth/vedic-study.json` and exits. After that, research runs on its own with no further sign-in; there is no password prompt in the app.

Sessions normally last a long time, but if the site revokes yours (for example after a password change) research reports that the session expired; run `npm run login` again. `.auth/` is excluded from Git; never commit or share that file. For a deployed server, transfer it through a private secrets mechanism and set `VEDIC_STUDY_STORAGE_STATE_PATH`.

## How the agent works

- Parallel searches and full-page reads, with long pages paged through an `offset`, and same-site links returned from each page so the agent can follow commentary and parallel passages.
- A `save_note` tool keeps findings and quotations across the whole run while older page text is compacted, which is what lets very deep runs continue without exhausting the model's context.
- When the safety ceiling or time budget is reached, tools are switched off for one last step so a run always ends in a written report.
- Citations are checked in the UI: links that no tool returned are tagged "unverified".
- Search and page results are cached for ten minutes and browser use is limited to three concurrent pages.

## Research and source limitations

Reports are instructed to use retrieved `vedic.study` text as evidence and cite the exact pages returned by the scraper. Site search selectors and routes can change; the default search path is `https://www.vedic.study/search?q=...`, which can be overridden with `VEDIC_SEARCH_URL_TEMPLATE`. Results are extracted from same-site links and article text, so verify important quotations and translations against their source pages. No research result is guaranteed to be exhaustive or a substitute for scholarly review.