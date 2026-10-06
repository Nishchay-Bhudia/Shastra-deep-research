import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authDirectory = path.join(projectRoot, ".auth");
const statePath = path.join(authDirectory, "vedic-study.json");

await mkdir(authDirectory, { recursive: true });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
const readline = createInterface({ input: stdin, output: stdout });

try {
  await page.goto("https://vedic.study", { waitUntil: "domcontentloaded" });
  console.log(
    "Sign in to vedic.study in the browser window using an account you are authorized to use.",
  );
  await readline.question("After sign-in is complete, press Enter here to save the session state: ");
  await context.storageState({ path: statePath });
  console.log(`Saved the private browser state to ${statePath}`);
  console.log("Keep this file private. Do not commit it or share it in chat.");
} finally {
  readline.close();
  await context.close();
  await browser.close();
}
