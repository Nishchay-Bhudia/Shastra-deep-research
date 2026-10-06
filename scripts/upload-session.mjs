import { put } from "@vercel/blob";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Uploads the session saved by `npm run login` to the private Blob store, where the deployed app
// reads it. Needs BLOB_READ_WRITE_TOKEN (from `vercel env pull .env.local`).
//   npm run login:upload

const statePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".auth", "vedic-study.json");

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run `vercel env pull .env.local` first.");
  process.exit(1);
}

let body;
try {
  body = await readFile(statePath, "utf8");
  JSON.parse(body);
} catch {
  console.error(`No valid session at ${statePath}. Run \`npm run login\` first.`);
  process.exit(1);
}

await put("vedic/session.json", body, {
  access: "private",
  contentType: "application/json",
  addRandomSuffix: false,
  allowOverwrite: true,
});
console.log("Uploaded the vedic.study session to the private Blob store (vedic/session.json).");
