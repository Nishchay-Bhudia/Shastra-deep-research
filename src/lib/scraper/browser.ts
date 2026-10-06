import { access } from "node:fs/promises";
import path from "node:path";
import { normalizeVedicUrl } from "@/lib/vedic-url";
import type { Browser, BrowserContext, Page, Response } from "playwright-core";
import { blobConfigured, readJson } from "@/lib/blob";
import { launchChromium } from "@/lib/chromium";

const TARGET_HOST = "vedic.study";
const MAX_RESULTS = 15;
const MAX_TEXT_LENGTH = 120_000;
const MAX_LINKS = 40;
const NAVIGATION_TIMEOUT_MS = 25_000;
const SETTLE_TIMEOUT_MS = 8_000;
const MAX_CONCURRENT_PAGES = 3;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 150;

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type SourceLink = {
  text: string;
  url: string;
};

export type SourceDocument = {
  title: string;
  url: string;
  content: string;
  links: SourceLink[];
};

/** The site's invite gate ("Not Yet Open") is an access control, not content. */
export function isGatePath(pathname: string): boolean {
  return /^\/gate(\/|$)/i.test(pathname);
}

class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const pageLimiter = new Semaphore(MAX_CONCURRENT_PAGES);

const cache = new Map<string, { expires: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

// Browser and session state live on globalThis: in `next dev`, every hot reload re-evaluates this
// module, and module-level variables would launch (and leak) a new Chromium each time.
type ScraperGlobals = {
  __shastraBrowser?: Promise<Browser>;
  __shastraContext?: Promise<BrowserContext>;
};
const scraperGlobals = globalThis as unknown as ScraperGlobals;

export function isAllowedVedicUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "https:" &&
      (url.hostname === TARGET_HOST || url.hostname.endsWith(`.${TARGET_HOST}`)) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function getSearchUrl(query: string): string {
  const template =
    process.env.VEDIC_SEARCH_URL_TEMPLATE ||
    "https://www.vedic.study/search?q={query}";
  const url = template.replace("{query}", encodeURIComponent(query));
  if (!isAllowedVedicUrl(url)) {
    throw new Error(
      "VEDIC_SEARCH_URL_TEMPLATE must point to an HTTPS page on vedic.study.",
    );
  }
  return url;
}

async function getBrowser() {
  if (!scraperGlobals.__shastraBrowser) {
    scraperGlobals.__shastraBrowser = launchChromium()
      .then((browser) => {
        // If Chromium dies, forget it (and the context that lived in it) so the next call relaunches.
        browser.on("disconnected", () => {
          scraperGlobals.__shastraBrowser = undefined;
          scraperGlobals.__shastraContext = undefined;
        });
        return browser;
      })
      .catch((error: unknown) => {
        scraperGlobals.__shastraBrowser = undefined;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Playwright could not start Chromium. Install it with "npx playwright install chromium". ${detail}`,
        );
      });
  }
  return scraperGlobals.__shastraBrowser;
}

const DEFAULT_STATE_PATH = ".auth/vedic-study.json";

/** Raised when the site sends us to its invite gate: the saved session is missing or no longer valid. */
class GateError extends Error {}

function getStatePath() {
  return path.resolve(process.cwd(), process.env.VEDIC_STUDY_STORAGE_STATE_PATH || DEFAULT_STATE_PATH);
}

const BLOB_SESSION_PATH = "vedic/session.json";

type StorageStateInput = NonNullable<Parameters<Browser["newContext"]>[0]>["storageState"];

/**
 * The signed-in session saved by `npm run login`: a local file in development, or the private
 * Vercel Blob `vedic/session.json` when deployed (uploaded by `npm run login:upload`).
 */
async function loadStorageState(): Promise<StorageStateInput | undefined> {
  try {
    await access(getStatePath());
    return getStatePath();
  } catch {
    /* no local file; try the blob store */
  }
  if (blobConfigured()) {
    return (await readJson<StorageStateInput & object>(BLOB_SESSION_PATH)) ?? undefined;
  }
  return undefined;
}

/** True when a saved vedic.study session is available. */
export async function hasVedicAccess(): Promise<boolean> {
  try {
    return Boolean(await loadStorageState());
  } catch {
    return false;
  }
}

// One signed-in context is shared by every search and page read. Restoring the saved session
// (cookies + IndexedDB) costs seconds, so it is done once; each call only opens its own page.

function getContext(): Promise<BrowserContext> {
  if (!scraperGlobals.__shastraContext) {
    scraperGlobals.__shastraContext = createContext().catch((error: unknown) => {
      scraperGlobals.__shastraContext = undefined;
      throw error;
    });
  }
  return scraperGlobals.__shastraContext;
}

/** Drops the shared context so the next call reloads the saved session file. */
async function resetContext() {
  const pending = scraperGlobals.__shastraContext;
  scraperGlobals.__shastraContext = undefined;
  await (await pending?.catch(() => undefined))?.close().catch(() => undefined);
}

/**
 * The saved session's short-lived id token is usually expired by the time it is reused. The site's
 * own script refreshes it (from the long-lived refresh token) when a page loads, so load one page
 * first and wait for the refreshed token before the real work starts in parallel.
 */
async function warmUpSession(context: BrowserContext) {
  const page = await context.newPage();
  try {
    await page.goto("https://www.vedic.study/", { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    for (let waited = 0; waited < 12_000; waited += 500) {
      const token = (await context.cookies()).find((cookie) => cookie.name === "firebase-token");
      if (token && token.expires * 1000 > Date.now() + 10 * 60_000) return;
      await page.waitForTimeout(500);
    }
  } catch {
    /* the real request reports any problem */
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function createContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const contextOptions: Parameters<Browser["newContext"]>[0] = {
    javaScriptEnabled: true,
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    viewport: { width: 1440, height: 900 },
  };

  const storageState = await loadStorageState();
  if (!storageState) {
    throw new Error(
      "No saved vedic.study session was found. Run `npm run login` once to sign in (and `npm run login:upload` for the deployed app); after that research runs on its own.",
    );
  }
  contextOptions.storageState = storageState;

  const context = await browser.newContext(contextOptions);
  context.on("close", () => {
    if (scraperGlobals.__shastraContext) scraperGlobals.__shastraContext = undefined;
  });
  await warmUpSession(context);
  const sessionStorageJson = process.env.VEDIC_STUDY_SESSION_STORAGE_JSON;
  if (sessionStorageJson) {
    let sessionStorage: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(sessionStorageJson);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length > 100 ||
        Object.values(parsed).some((value) => typeof value !== "string")
      ) {
        throw new Error("Expected a JSON object with string values.");
      }
      sessionStorage = parsed as Record<string, string>;
    } catch {
      await context.close();
      throw new Error(
        "VEDIC_STUDY_SESSION_STORAGE_JSON must be a JSON object whose values are strings.",
      );
    }

    await context.addInitScript((values) => {
      for (const [key, value] of Object.entries(values)) {
        window.sessionStorage.setItem(key, value);
      }
    }, sessionStorage);
  }

  return context;
}

/**
 * The site is a client-rendered app that never goes network-idle, so waiting for idle just burns
 * the timeout on every page. Wait for the content we need instead, and move on as soon as it is there.
 */
async function openAllowedPage(
  context: BrowserContext,
  url: string,
  contentReady: (page: Page) => Promise<unknown>,
) {
  if (!isAllowedVedicUrl(url)) {
    throw new Error("Only HTTPS pages on vedic.study can be opened.");
  }

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await page.route("**/*", async (route) => {
    if (isAllowedVedicUrl(route.request().url())) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  let response: Response | null;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    await page.close();
    const detail = error instanceof Error ? error.message : "Navigation failed.";
    throw new Error(
      `Could not load the vedic.study page. Check the URL, network access, and any authorized session state. ${detail}`,
    );
  }

  if (!isAllowedVedicUrl(page.url())) {
    await page.close();
    throw new Error(
      "vedic.study redirected outside its domain. The request was stopped for safety.",
    );
  }

  // The site is a client-rendered app: let it finish loading before reading.
  await contentReady(page).catch(() => undefined);

  if (isGatePath(new URL(page.url()).pathname)) {
    await page.close();
    throw new GateError(
      "vedic.study sent the saved session to its invite-only sign-in gate, so the session has expired or was revoked. Run `npm run login` to sign in again; this app does not bypass the gate.",
    );
  }

  const status = response?.status();
  if (status === 401 || status === 403 || status === 429) {
    await page.close();
    throw new Error(
      `vedic.study returned HTTP ${status}. This app will not bypass access controls; verify your authorized account session or try again later.`,
    );
  }

  return page;
}

/** One retry for a gate bounce (a refresh may still be landing); a second one means the session is dead. */
async function withGateRetry<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      return await task();
    } catch (retryError) {
      if (retryError instanceof GateError) await resetContext(); // next call reloads the saved session
      throw retryError;
    }
  }
}

export function searchVedicKnowledgeBase(query: string): Promise<SearchResult[]> {
  const key = `search:${query.trim().toLowerCase()}`;
  return cached(key, () => pageLimiter.run(() => withGateRetry(() => runSearch(query))));
}

async function runSearch(query: string): Promise<SearchResult[]> {
  const context = await getContext();
  try {
    const page = await openAllowedPage(context, getSearchUrl(query), (p) =>
      p.waitForSelector("article h3 a[href]", { timeout: SETTLE_TIMEOUT_MS }),
    );
    try {
      return await page.evaluate(
        (options) => {
          const body = document.body;
          const clean = (text: string | null | undefined) =>
            (text || "").replace(/\s+/g, " ").trim();
          const isAllowed = (target: URL) =>
            target.protocol === "https:" &&
            (target.hostname === options.allowedHost ||
              target.hostname.endsWith(`.${options.allowedHost}`));

          // vedic.study renders each hit as <article> with a breadcrumb, an <h3><a> title,
          // and a highlighted snippet. Prefer that structure; it gives meaningful titles.
          const cardResults: SearchResult[] = [];
          const cardSeen = new Set<string>();
          for (const card of Array.from(body.querySelectorAll("article"))) {
            const anchor = card.querySelector<HTMLAnchorElement>("h3 a[href]");
            if (!anchor) continue;
            let target: URL;
            try {
              target = new URL(anchor.href);
            } catch {
              continue;
            }
            if (!isAllowed(target) || cardSeen.has(target.href)) continue;
            const crumbs = Array.from(
              card.querySelectorAll('ol[aria-label="Location"] li span:not([aria-hidden])'),
            )
              .map((node) => clean(node.textContent))
              .filter(Boolean);
            const heading = clean(anchor.textContent);
            const kind = clean(card.querySelector("div.inline-flex")?.textContent);
            const title = [...crumbs, heading].filter(Boolean).join(" › ").slice(0, 240);
            const snippet = clean(card.querySelector("p")?.textContent).slice(0, 900);
            cardSeen.add(target.href);
            cardResults.push({
              title: kind ? `${title} (${kind})` : title,
              url: target.href,
              snippet: snippet || title,
            });
            if (cardResults.length >= options.maxResults) break;
          }
          if (cardResults.length > 0) return cardResults;

          // Fallback for pages that do not use the card layout.
          const links = Array.from(body.querySelectorAll<HTMLAnchorElement>("a[href]"));
          const seen = new Set<string>();
          const results: SearchResult[] = [];

          for (const anchor of links) {
            let target: URL;
            try {
              target = new URL(anchor.href);
            } catch {
              continue;
            }
            if (
              target.protocol !== "https:" ||
              !(target.hostname === options.allowedHost || target.hostname.endsWith(`.${options.allowedHost}`)) ||
              target.pathname === "/" ||
              seen.has(target.href)
            ) {
              continue;
            }

            const title =
              anchor.querySelector("h1, h2, h3, h4")?.textContent?.trim() ||
              anchor.getAttribute("aria-label")?.trim() ||
              anchor.textContent?.trim();
            if (!title || title.length < 3) continue;

            const container =
              anchor.closest(
                ".search-result-item, [data-search-result], article, li",
              ) || anchor.parentElement;
            const snippet = (container?.textContent || title)
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 900);

            seen.add(target.href);
            results.push({
              title: title.replace(/\s+/g, " ").slice(0, 240),
              url: target.href,
              snippet,
            });
            if (results.length >= options.maxResults) break;
          }

          // Avoid returning utility/navigation links when no result-like links were found.
          return results
            .filter((item) => {
              const pathname = new URL(item.url).pathname.toLowerCase();
              return !/\/(gate|login|logout|signup|register|search|account|profile)(\/|$)/.test(
                pathname,
              );
            })
            .slice(0, options.maxResults);
        },
        { allowedHost: TARGET_HOST, maxResults: MAX_RESULTS },
      );
    } finally {
      await page.close();
    }
  } finally {
    // The context is shared across calls; only each call's page is closed.
    void context;
  }
}

export function readVedicDocument(url: string): Promise<SourceDocument> {
  // Always https, and www.vedic.study (the bare domain does not resolve).
  const normalized = normalizeVedicUrl(url);
  if (!normalized) {
    return Promise.reject(new Error("Only HTTPS vedic.study URLs can be read."));
  }
  return cached(`doc:${normalized}`, () => pageLimiter.run(() => withGateRetry(() => runRead(normalized))));
}

async function runRead(url: string): Promise<SourceDocument> {
  const context = await getContext();
  try {
    const page = await openAllowedPage(context, url, (p) =>
      p.waitForFunction(
        () => ((document.querySelector("article, main") as HTMLElement | null)?.innerText.length ?? 0) > 200,
        undefined,
        { timeout: SETTLE_TIMEOUT_MS },
      ),
    );
    try {
      const loadedDocument = await page.evaluate((options) => {
        const { maxTextLength, maxLinks, allowedHost } = options;
        const removeSelectors = [
          "script",
          "style",
          "noscript",
          "svg",
          "nav",
          "header",
          "footer",
          "aside",
          "form",
          "button",
          "[role=navigation]",
          "[aria-hidden=true]",
        ];
        const main0 =
          document.querySelector("main article") ||
          document.querySelector("article") ||
          document.querySelector("main") ||
          document.querySelector('[role="main"]') ||
          document.body;
        const seenLinks = new Set<string>();
        const links: { text: string; url: string }[] = [];
        for (const anchor of Array.from(main0.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
          let target: URL;
          try {
            target = new URL(anchor.href);
          } catch {
            continue;
          }
          target.hash = "";
          const text = (anchor.textContent || "").replace(/\s+/g, " ").trim();
          if (
            target.protocol !== "https:" ||
            !(target.hostname === allowedHost || target.hostname.endsWith(`.${allowedHost}`)) ||
            target.pathname === "/" ||
            /^\/(gate|login|logout|signup|register|account|profile)(\/|$)/i.test(target.pathname) ||
            target.href === window.location.href ||
            text.length < 2 ||
            seenLinks.has(target.href)
          ) {
            continue;
          }
          seenLinks.add(target.href);
          links.push({ text: text.slice(0, 120), url: target.href });
          if (links.length >= maxLinks) break;
        }

        document.querySelectorAll(removeSelectors.join(",")).forEach((node) => node.remove());

        const main =
          document.querySelector("main article") ||
          document.querySelector("article") ||
          document.querySelector("main") ||
          document.querySelector('[role="main"]') ||
          document.body;
        const title =
          document.querySelector("h1")?.textContent?.trim() ||
          document.title ||
          window.location.pathname;
        const content = (main as HTMLElement).innerText
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, maxTextLength);

        return {
          title: title.replace(/\s+/g, " ").slice(0, 240),
          url: window.location.href,
          content,
          links,
        };
      }, { maxTextLength: MAX_TEXT_LENGTH, maxLinks: MAX_LINKS, allowedHost: TARGET_HOST });

      if (!isAllowedVedicUrl(loadedDocument.url)) {
        throw new Error("The page URL changed to a disallowed domain.");
      }
      if (loadedDocument.content.length < 30) {
        throw new Error(
          "The page did not contain readable article text. It may require an authorized session or a different page URL.",
        );
      }
      return loadedDocument;
    } finally {
      await page.close();
    }
  } finally {
    // The context is shared across calls; only each call's page is closed.
    void context;
  }
}
