import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";

// Usage:
//   npm run capture:vedic-session            opens a Playwright browser to sign in with email/password
//   npm run capture:vedic-session -- --cdp   attaches to your own Chrome (needed for "Continue with
//                                            Google", which refuses to sign in inside automated browsers)
const useCdp = argv.includes("--cdp");
const cdpUrl = "http://127.0.0.1:9222";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authDirectory = path.join(projectRoot, ".auth");
const statePath = path.join(authDirectory, "vedic-study.json");

await mkdir(authDirectory, { recursive: true });
const readline = createInterface({ input: stdin, output: stdout });
let browser;
let context;

try {
  if (useCdp) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch {
      console.error(
        `Could not reach Chrome on ${cdpUrl}. Start it first with:\n\n` +
          `  open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.shastra-chrome"\n`,
      );
      process.exit(1);
    }
    context = browser.contexts()[0];
    console.log(
      "Attached to your Chrome. In that Chrome window, open https://www.vedic.study and sign in as you normally would (Google works).",
    );
  } else {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://www.vedic.study/auth/login", { waitUntil: "domcontentloaded" });
    console.log(
      "Sign in to vedic.study in the browser window with an account you are authorized to use.",
    );
  }

  await readline.question("After sign-in is complete, press Enter here to save the session state: ");
  // The site keeps its sign-in in IndexedDB (Firebase auth), so it must be included.
  await context.storageState({ path: statePath, indexedDB: true });
  console.log(`Saved the private browser state to ${statePath}`);
  console.log("Keep this file private. Do not commit it or share it in chat.");
} finally {
  readline.close();
  // Leave the user's own Chrome open; only close a browser we launched ourselves.
  if (!useCdp) {
    await context?.close();
    await browser?.close();
  } else {
    await browser?.close().catch(() => undefined); // disconnects from CDP without quitting Chrome
  }
}
