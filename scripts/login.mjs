import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One-time sign-in. Opens your own Chrome (a dedicated profile), waits while you sign in to
// vedic.study the way you normally do (Google works), then saves the session for the app.
// Google refuses sign-in inside Playwright's own browser, so we use real Chrome and attach to it.
//   npm run login

const CDP_URL = "http://127.0.0.1:9222";
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const profileDir = path.join(os.homedir(), ".shastra-chrome");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authDirectory = path.join(projectRoot, ".auth");
const statePath = path.join(authDirectory, "vedic-study.json");

const chromeCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chromeIsListening() {
  try {
    return (await fetch(`${CDP_URL}/json/version`)).ok;
  } catch {
    return false;
  }
}

await mkdir(authDirectory, { recursive: true });

let child;
if (!(await chromeIsListening())) {
  const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
  if (!chromePath) {
    console.error("Google Chrome was not found. Install Chrome, then run this again.");
    process.exit(1);
  }
  console.log("Opening Chrome. Sign in to vedic.study in that window (Google sign-in works).");
  child = spawn(
    chromePath,
    [
      "--remote-debugging-port=9222",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://www.vedic.study/auth/login",
    ],
    { stdio: "ignore", detached: false },
  );
  for (let i = 0; i < 40 && !(await chromeIsListening()); i += 1) await sleep(500);
}

// A Chrome that is running with every window closed cannot be attached to; make sure a tab exists.
try {
  const targets = await (await fetch(`${CDP_URL}/json/list`)).json();
  if (!targets.some((target) => target.type === "page")) {
    await fetch(`${CDP_URL}/json/new?https://www.vedic.study/`, { method: "PUT" });
    await sleep(1500);
  }
} catch {
  /* attaching below reports any real problem */
}

let browser;
try {
  browser = await chromium.connectOverCDP(CDP_URL);
} catch (error) {
  console.error(String(error?.message ?? error).split("\n")[0]);
  console.error(`Could not attach to Chrome on ${CDP_URL}. Close all Chrome windows that use the ${profileDir} profile and try again.`);
  child?.kill();
  process.exit(1);
}
const context = browser.contexts()[0];

/** Signed in = a vedic.study tab, past the gate and login pages, holding a Firebase auth user. */
async function findSignedInTab() {
  for (const tab of context.pages()) {
    let url;
    try {
      url = new URL(tab.url());
    } catch {
      continue;
    }
    if (!url.hostname.endsWith("vedic.study") || /^\/(gate|auth)(\/|$)/.test(url.pathname)) continue;
    const signedIn = await tab
      .evaluate(
        () =>
          new Promise((resolve) => {
            const open = indexedDB.open("firebaseLocalStorageDb");
            open.onerror = () => resolve(false);
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains("firebaseLocalStorage")) {
                db.close();
                return resolve(false);
              }
              const keys = db.transaction("firebaseLocalStorage").objectStore("firebaseLocalStorage").getAllKeys();
              keys.onsuccess = () => {
                db.close();
                resolve(keys.result.some((key) => String(key).startsWith("firebase:authUser")));
              };
              keys.onerror = () => {
                db.close();
                resolve(false);
              };
            };
          }),
      )
      .catch(() => false);
    if (signedIn) return tab;
  }
  return undefined;
}

let tab;
const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
while (!(tab = await findSignedInTab())) {
  if (Date.now() > deadline) {
    console.error("Timed out waiting for sign-in. Run `npm run login` again.");
    child?.kill();
    process.exit(1);
  }
  await sleep(2000);
}
console.log("Signed in. Saving the session...");
await sleep(2500); // let the site finish writing its auth state

// The site keeps its sign-in in IndexedDB (Firebase auth). Playwright cannot enumerate site
// storage for a Chrome it only attached to, so read it from the tab in Playwright's state format.
const state = await context.storageState();
const origin = new URL(tab.url()).origin;
const siteState = await tab.evaluate(async () => {
      const idb = async (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const databases = [];
      for (const info of await indexedDB.databases()) {
        if (!info.name || !info.version) continue;
        const db = await idb(indexedDB.open(info.name));
        try {
          const names = [...db.objectStoreNames];
          const tx = names.length ? db.transaction(names, "readonly") : null;
          const stores = [];
          for (const name of names) {
            const store = tx.objectStore(name);
            const keys = await idb(store.getAllKeys());
            const records = [];
            for (const key of keys) {
              const record = {};
              if (store.keyPath === null) record.key = key;
              record.value = await idb(store.get(key));
              records.push(record);
            }
            stores.push({
              name,
              records,
              indexes: [...store.indexNames].map((n) => {
                const index = store.index(n);
                return {
                  name: index.name,
                  keyPath: typeof index.keyPath === "string" ? index.keyPath : undefined,
                  keyPathArray: Array.isArray(index.keyPath) ? index.keyPath : undefined,
                  multiEntry: index.multiEntry,
                  unique: index.unique,
                };
              }),
              autoIncrement: store.autoIncrement,
              keyPath: typeof store.keyPath === "string" ? store.keyPath : undefined,
              keyPathArray: Array.isArray(store.keyPath) ? store.keyPath : undefined,
            });
          }
          databases.push({ name: info.name, version: info.version, stores });
        } finally {
          db.close();
        }
      }
      const localStorageItems = Object.keys(localStorage).map((name) => ({
        name,
        value: localStorage.getItem(name),
      }));
      return { localStorage: localStorageItems, indexedDB: databases };
    });
state.origins = [...(state.origins ?? []).filter((o) => o.origin !== origin), { origin, ...siteState }];

await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(`Saved the session to ${statePath}`);
console.log("Keep that file private; it is excluded from Git. Research now runs without signing in again.");

await browser.close().catch(() => undefined); // detaches from Chrome
child?.kill();
