import type { Browser } from "playwright-core";

/**
 * Starts headless Chromium. Locally that is Playwright's own browser (`npx playwright install
 * chromium`); on Vercel, where nothing is installed, it is the serverless build from
 * @sparticuz/chromium.
 */
export async function launchChromium(): Promise<Browser> {
  if (process.env.VERCEL) {
    const [{ default: serverless }, { chromium }] = await Promise.all([
      import("@sparticuz/chromium"),
      import("playwright-core"),
    ]);
    // The bundled flags include --disable-web-security, which strips the Origin/Referer headers the
    // site's Firebase API key is restricted by (its token lookup then fails with 403). Drop the
    // flags that weaken web security; the rest are needed to run inside a serverless sandbox.
    const args = serverless.args.filter(
      (arg) => arg !== "--disable-web-security" && arg !== "--allow-running-insecure-content",
    );
    return chromium.launch({
      args,
      executablePath: await serverless.executablePath(),
      headless: true,
    });
  }
  const { chromium } = await import("playwright-core");
  return chromium.launch({ headless: true });
}
