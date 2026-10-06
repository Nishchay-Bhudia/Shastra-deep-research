import type { UIMessage } from "ai";

export type StoredChat = {
  id: string;
  title: string;
  updatedAt: number;
  messages: UIMessage[];
};

const CHATS_KEY = "shastra.chats.v1";
const ACTIVE_KEY = "shastra.activeChat.v1";
const MAX_CHATS = 40;

type AnyPart = { type: string; output?: Record<string, unknown>; [key: string]: unknown };

/** Drops bulky page text before saving; titles, urls, notes, plans, and diagrams are kept. */
export function compactForStorage(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: (message.parts as AnyPart[]).map((part) => {
      const output = part.output;
      if (!part.type.startsWith("tool-") || !output || typeof output !== "object") return part;
      if (part.type === "tool-read_document" && "content" in output) {
        const { content: _content, ...rest } = output;
        void _content;
        return { ...part, output: rest };
      }
      if (part.type === "tool-search_knowledge_base" && Array.isArray(output.results)) {
        return {
          ...part,
          output: {
            ...output,
            results: output.results.map((r) => {
              const { snippet: _snippet, ...rest } = r as Record<string, unknown>;
              void _snippet;
              return rest;
            }),
          },
        };
      }
      return part;
    }),
  })) as UIMessage[];
}

export function loadChats(): StoredChat[] {
  try {
    const raw = window.localStorage.getItem(CHATS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredChat[]) : [];
  } catch {
    return [];
  }
}

export function saveChats(chats: StoredChat[]) {
  let list = [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
  // Browsers cap localStorage; shed the oldest chats until the rest fit.
  while (list.length > 0) {
    try {
      window.localStorage.setItem(CHATS_KEY, JSON.stringify(list));
      return;
    } catch {
      list = list.slice(0, -1);
    }
  }
}

export function loadActiveChatId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveChatId(id: string) {
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function newChatId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type ChatMeta = { id: string; title: string; updatedAt: number };

/** Where chats live: the server's Vercel Blob store when configured, otherwise this browser. */
export interface ChatStorage {
  kind: "server" | "browser";
  list(): Promise<ChatMeta[]>;
  load(id: string): Promise<UIMessage[]>;
  save(chat: StoredChat): Promise<void>;
  remove(id: string): Promise<void>;
}

const browserStorage: ChatStorage = {
  kind: "browser",
  async list() {
    return loadChats().map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  },
  async load(id) {
    return loadChats().find((chat) => chat.id === id)?.messages ?? [];
  },
  async save(chat) {
    saveChats([chat, ...loadChats().filter((existing) => existing.id !== chat.id)]);
  },
  async remove(id) {
    saveChats(loadChats().filter((chat) => chat.id !== id));
  },
};

const serverStorage: ChatStorage = {
  kind: "server",
  async list() {
    const response = await fetch("/api/chats");
    if (!response.ok) throw new Error("Could not load chats.");
    return ((await response.json()) as { chats: ChatMeta[] }).chats;
  },
  async load(id) {
    const response = await fetch(`/api/chats/${id}`);
    if (!response.ok) return [];
    return ((await response.json()) as { messages: UIMessage[] }).messages;
  },
  async save(chat) {
    const response = await fetch(`/api/chats/${chat.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: chat.title, messages: chat.messages }),
    });
    if (!response.ok) throw new Error("Could not save the chat.");
  },
  async remove(id) {
    await fetch(`/api/chats/${id}`, { method: "DELETE" });
  },
};

/** Server storage when the deployment has it (HTTP 200 from /api/chats), else this browser. */
export async function detectStorage(): Promise<ChatStorage> {
  try {
    const response = await fetch("/api/chats");
    if (response.ok) return serverStorage;
  } catch {
    /* fall through */
  }
  return browserStorage;
}
