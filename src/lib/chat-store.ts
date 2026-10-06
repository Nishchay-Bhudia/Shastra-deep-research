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
