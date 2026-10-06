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

- **Thinks first.** Its first action is always `plan_research` (a descriptive report title, sub-questions, and search terms in English, IAST, Devanagari and Gujarati). It cannot write the report until `check_coverage` confirms every sub-question has saved evidence (a second check accepts gaps, which the report must then state). The plan is shown in the UI.
- **Streams.** Progress and the report stream live; only the text written after the last tool call is shown, so tool-time chatter never leaks into the report.
- **Evidence ledger.** `save_note` keeps findings and quotations (tied to a sub-question) across the whole run while older page text is compacted, which lets deep runs continue without exhausting the model's context. There is no fixed step limit; search/read budgets (standard 8/10, deep 20/30, exhaustive unlimited) and runaway ceilings only stop a small model from searching forever. At a ceiling or time budget, tools are switched off for a last step so a run always ends in a written report.
- **Citations that work.** The model cites saved notes as `[3]`; the URL comes from the note, never from the model's memory. Every link is rewritten to its exact retrieved page as `https://www.vedic.study/...` (the bare `vedic.study` domain does not resolve); anything that cannot be matched to a retrieved page becomes plain text marked "unverified source", never a dead link. A numbered References list is generated from the pages actually cited.
- **Grounded diagrams.** The model never writes diagram syntax. `create_diagram` takes nodes and relationships, each relationship must cite a page that was retrieved, and the Mermaid code is generated server-side (so it always parses). Hand-written diagram blocks are discarded.
- **Deliverables.** Tick or untick *PDF report* and *Include diagrams* above the question box. With the PDF on, one is produced automatically at the end, named after the report title and date (for example `Dharma-and-Bhakti-in-Shikshapatri-and-Vachanamrut-2026-10-06.pdf`), with diagrams rendered in it.
- **Chats.** *+ New chat* starts a fresh conversation; past chats are listed in the sidebar and stored in your browser's local storage (page text is not stored, only titles, links, notes, and the reports).
- Search and page results are cached for ten minutes; one signed-in browser context is shared and at most three pages load at once.

## Research and source limitations

Reports are instructed to use retrieved `vedic.study` text as evidence and cite the exact pages returned by the scraper. Site search selectors and routes can change; the default search path is `https://www.vedic.study/search?q=...`, which can be overridden with `VEDIC_SEARCH_URL_TEMPLATE`. Results are extracted from same-site links and article text, so verify important quotations and translations against their source pages. No research result is guaranteed to be exhaustive or a substitute for scholarly review.