import { blobConfigured, readJson, removeBlob, writeJson } from "@/lib/blob";

/**
 * A research run can outlive one serverless request (Vercel stops a function after 5 minutes), so its
 * state (plan, notes, analysis, counters) is saved between segments and the app resumes it with a
 * fresh request. Saved in the private Blob store when deployed, in memory otherwise.
 */
const memory = ((globalThis as unknown as { __shastraRuns?: Map<string, unknown> }).__shastraRuns ??= new Map());
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidRunId = (id: string) => RUN_ID.test(id);
export const newRunId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const path = (id: string) => `runs/${id}.json`;

export async function saveRun(id: string, state: unknown) {
  if (blobConfigured()) await writeJson(path(id), state);
  else memory.set(id, state);
}

export async function loadRun<T>(id: string): Promise<T | undefined> {
  if (!isValidRunId(id)) return undefined;
  if (blobConfigured()) return (await readJson<T>(path(id)).catch(() => undefined)) ?? undefined;
  return memory.get(id) as T | undefined;
}

export async function deleteRun(id: string) {
  memory.delete(id);
  if (blobConfigured()) await removeBlob(path(id)).catch(() => undefined);
}
