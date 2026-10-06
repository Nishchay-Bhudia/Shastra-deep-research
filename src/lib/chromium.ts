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
    return chromium.launch({
      args: serverless.args,
      executablePath: await serverless.executablePath(),
      headless: true,
    });
  }
  const { chromium } = await import("playwright-core");
  return chromium.launch({ headless: true });
}
