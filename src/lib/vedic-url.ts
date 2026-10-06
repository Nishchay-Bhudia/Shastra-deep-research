// Client-safe URL helpers (no Playwright import).

const HOST = "vedic.study";
export const CANONICAL_ORIGIN = `https://www.${HOST}`;

export function isVedicHost(hostname: string): boolean {
  return hostname === HOST || hostname.endsWith(`.${HOST}`);
}

/**
 * Canonical form of a vedic.study link: HTTPS only, on `www.vedic.study`
 * (the bare `vedic.study` domain does not resolve), without a fragment.
 * Returns undefined for anything that is not a vedic.study page.
 */
export function normalizeVedicUrl(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!isVedicHost(url.hostname) || url.username || url.password) return undefined;
  url.protocol = "https:";
  if (url.hostname === HOST) url.hostname = `www.${HOST}`;
  url.hash = "";
  return url.href;
}

/** Comparison key: normalized and without a trailing slash. */
export function urlKey(candidate: string): string | undefined {
  const normalized = normalizeVedicUrl(candidate);
  return normalized?.replace(/\/$/, "");
}
