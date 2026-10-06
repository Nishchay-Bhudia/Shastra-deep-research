import { put } from "@vercel/blob";
import { blobConfigured, listPaths, readJson, removeBlob, writeJson } from "@/lib/blob";

export type ChatMeta = { id: string; title: string; updatedAt: number };
export type PdfInfo = { fileName: string };
export type ChatRecord = ChatMeta & { messages: unknown[]; pdfs?: Record<string, PdfInfo> };

const INDEX = "chats/index.json";
const MAX_CHATS = 100;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidChatId = (id: string) => ID.test(id);
export const chatPath = (id: string) => `chats/${id}.json`;
export const pdfPath = (chatId: string, messageId: string) => `pdfs/${chatId}/${messageId}.pdf`;
export { blobConfigured };

export async function listChats(): Promise<ChatMeta[]> {
  const index = (await readJson<ChatMeta[]>(INDEX)) ?? [];
  return index.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(id: string): Promise<ChatRecord | undefined> {
  return readJson<ChatRecord>(chatPath(id));
}

export async function saveChat(chat: ChatRecord) {
  await writeJson(chatPath(chat.id), chat);
  const index = (await readJson<ChatMeta[]>(INDEX)) ?? [];
  const next = [
    { id: chat.id, title: chat.title, updatedAt: chat.updatedAt },
    ...index.filter((entry) => entry.id !== chat.id),
  ].slice(0, MAX_CHATS);
  await writeJson(INDEX, next);
  // Chats pushed out of the index are deleted so storage does not grow without bound.
  for (const dropped of index.filter((entry) => !next.some((kept) => kept.id === entry.id))) {
    await removeBlob(chatPath(dropped.id)).catch(() => undefined);
  }
}

export async function savePdf(chatId: string, messageId: string, pdf: Buffer) {
  await put(pdfPath(chatId, messageId), pdf, {
    access: "private",
    contentType: "application/pdf",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function deleteChat(id: string) {
  // The chat's PDFs go with it.
  for (const path of await listPaths(`pdfs/${id}/`).catch(() => [] as string[])) {
    await removeBlob(path).catch(() => undefined);
  }
  const index = (await readJson<ChatMeta[]>(INDEX)) ?? [];
  await writeJson(INDEX, index.filter((entry) => entry.id !== id));
  await removeBlob(chatPath(id)).catch(() => undefined);
}
