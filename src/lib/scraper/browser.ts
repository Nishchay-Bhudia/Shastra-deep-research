import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Response } from "playwright";

const TARGET_HOST = "vedic.study";
const MAX_RESULTS = 12;
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

async function withFreshSignIn<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof GateError && hasLoginCredentials()) {
      loginPromise = undefined; // session expired or was never accepted: sign in again once
      return task();
    }
    throw error;
  }
}

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

let browserPromise: Promise<Browser> | undefined;

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
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: true })
      .catch((error: unknown) => {
        browserPromise = undefined;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Playwright could not start Chromium. Install it with "npx playwright install chromium". ${detail}`,
        );
      });
  }
  return browserPromise;
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const LOGIN_URL = "https://www.vedic.study/auth/login";
const LOGIN_TIMEOUT_MS = 30_000;

/** Raised when the site sends us to its invite gate; a fresh sign-in may fix it. */
class GateError extends Error {}

let loginPromise: Promise<StorageState> | undefined;

function hasLoginCredentials() {
  return Boolean(process.env.VEDIC_STUDY_EMAIL && process.env.VEDIC_STUDY_PASSWORD);
}

// Held on globalThis so every route bundle in this server process shares it.
const CONNECTION_TTL_MS = 12 * 60 * 60_000;
type Connection = { state: StorageState; expires: number };
const globalStore = globalThis as unknown as { __vedicConnection?: Connection };

function getConnection(): Connection | undefined {
  const connection = globalStore.__vedicConnection;
  if (connection && connection.expires <= Date.now()) {
    globalStore.__vedicConnection = undefined;
    return undefined;
  }
  return connection;
}

/** True when a signed-in session, configured credentials, or a state file is available. */
export function hasVedicAccess(): boolean {
  return Boolean(
    getConnection() ||
      hasLoginCredentials() ||
      process.env.VEDIC_STUDY_STORAGE_STATE_PATH,
  );
}

export function isVedicConnected(): boolean {
  return hasVedicAccess();
}

export function disconnectVedic() {
  globalStore.__vedicConnection = undefined;
  loginPromise = undefined;
  cache.clear();
}

/**
 * Signs in with credentials typed into the app. Only the resulting browser
 * state is kept (in memory); the password is discarded.
 */
export async function connectVedic(email: string, password: string) {
  const state = await signIn(email, password);
  globalStore.__vedicConnection = { state, expires: Date.now() + CONNECTION_TTL_MS };
  cache.clear();
}

/**
 * Signs in through the site's normal email form and returns the browser state
 * (cookies, local storage, IndexedDB) to reuse for research pages.
 */
async function signIn(email: string, password: string): Promise<StorageState> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(LOGIN_TIMEOUT_MS);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.locator("input#email").fill(email);
    await page.locator("input#password").fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    try {
      await page.waitForURL((url) => !/^\/auth\//.test(url.pathname), {
        timeout: LOGIN_TIMEOUT_MS,
      });
    } catch {
      // The site shows failures as an "Error" heading followed by the reason.
      const pageText = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
      const message = /\bError\s*\n+([^\n]{3,200})/.exec(pageText)?.[1] ?? "";
      throw new Error(
        `Signing in to vedic.study did not complete. ${
          message ? `The site said: "${message.trim().slice(0, 200)}". ` : ""
        }Check the email and password. Accounts that only use "Continue with Google/Apple" have no password; use the manual session capture instead.`,
      );
    }
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);

    // A valid sign-in can still be an account that is not on the invite list.
    await page.goto("https://www.vedic.study/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
    if (isGatePath(new URL(page.url()).pathname)) {
      throw new Error(
        "You signed in, but vedic.study still shows its invite-only gate for this account. Use the email address that was invited.",
      );
    }
    return await context.storageState({ indexedDB: true });
  } finally {
    await context.close();
  }
}

function getLoginState(): Promise<StorageState> {
  if (!loginPromise) {
    loginPromise = signIn(
      process.env.VEDIC_STUDY_EMAIL!,
      process.env.VEDIC_STUDY_PASSWORD!,
    ).catch((error: unknown) => {
      loginPromise = undefined;
      throw error;
    });
  }
  return loginPromise;
}

async function getContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const contextOptions: Parameters<Browser["newContext"]>[0] = {
    javaScriptEnabled: true,
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    viewport: { width: 1440, height: 900 },
  };

  const statePath = process.env.VEDIC_STUDY_STORAGE_STATE_PATH;
  const connection = getConnection();
  if (connection) {
    contextOptions.storageState = connection.state;
  } else if (hasLoginCredentials()) {
    contextOptions.storageState = await getLoginState();
  } else if (statePath) {
    const resolvedPath = path.resolve(process.cwd(), statePath);
    try {
      await access(resolvedPath);
      contextOptions.storageState = resolvedPath;
    } catch {
      throw new Error(
        `The configured Playwright storage-state file was not found at ${resolvedPath}. Add an authorized state file or clear VEDIC_STUDY_STORAGE_STATE_PATH.`,
      );
    }
  }

  const context = await browser.newContext(contextOptions);
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

async function openAllowedPage(context: BrowserContext, url: string) {
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
  await page
    .waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS })
    .catch(() => undefined);

  if (isGatePath(new URL(page.url()).pathname)) {
    await page.close();
    throw new GateError(
      "vedic.study is invite-only and redirected to its sign-in gate. Reconnect your invited vedic.study account in the app (or capture a session with `npm run capture:vedic-session`); this app will not bypass the gate.",
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

export function searchVedicKnowledgeBase(query: string): Promise<SearchResult[]> {
  const key = `search:${query.trim().toLowerCase()}`;
  return cached(key, () => pageLimiter.run(() => withFreshSignIn(() => runSearch(query))));
}

async function runSearch(query: string): Promise<SearchResult[]> {
  const context = await getContext();
  try {
    const page = await openAllowedPage(context, getSearchUrl(query));
    try {
      return await page.locator("body").evaluate(
        (body, options) => {
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
    await context.close();
  }
}

export function readVedicDocument(url: string): Promise<SourceDocument> {
  if (!isAllowedVedicUrl(url)) {
    return Promise.reject(new Error("Only HTTPS vedic.study URLs can be read."));
  }
  return cached(`doc:${url}`, () => pageLimiter.run(() => withFreshSignIn(() => runRead(url))));
}

async function runRead(url: string): Promise<SourceDocument> {
  const context = await getContext();
  try {
    const page = await openAllowedPage(context, url);
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
    await context.close();
  }
}
