import { del, get, list, put } from "@vercel/blob";

/**
 * Vercel Blob is this app's database: chat history and the saved vedic.study session live in a
 * private store. Without BLOB_READ_WRITE_TOKEN (local dev) callers fall back to local files/storage.
 */
export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function readJson<T>(pathname: string): Promise<T | undefined> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return undefined;
  return JSON.parse(await new Response(result.stream).text()) as T;
}

export async function writeJson(pathname: string, value: unknown) {
  await put(pathname, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function removeBlob(pathname: string) {
  await del(pathname);
}

export async function listPaths(prefix: string): Promise<string[]> {
  const result = await list({ prefix });
  return result.blobs.map((blob) => blob.pathname);
}
