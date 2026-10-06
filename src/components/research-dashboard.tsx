"use client";

import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import { ChatSession } from "@/components/chat-session";
import {
  detectStorage,
  loadActiveChatId,
  newChatId,
  saveActiveChatId,
  type ChatMeta,
  type ChatStorage,
} from "@/lib/chat-store";

function titleFrom(messages: UIMessage[], fallback: string) {
  const first = messages.find((message) => message.role === "user");
  const text = (first?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  return text ? text.slice(0, 70) : fallback;
}

type Entry = ChatMeta & { messages: UIMessage[] | null };

export function ResearchDashboard() {
  const [storage, setStorage] = useState<ChatStorage | null>(null);
  const [chats, setChats] = useState<Entry[] | null>(null);
  const [activeId, setActiveId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveError, setSaveError] = useState("");

  const blank = (): Entry => ({ id: newChatId(), title: "New chat", updatedAt: Date.now(), messages: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const chosen = await detectStorage();
      const metas = await chosen.list().catch(() => [] as ChatMeta[]);
      if (cancelled) return;
      setStorage(chosen);
      const saved = loadActiveChatId();
      if (metas.length > 0) {
        setChats(metas.map((meta) => ({ ...meta, messages: null })));
        setActiveId(metas.some((meta) => meta.id === saved) ? saved! : metas[0].id);
      } else {
        const first = blank();
        setChats([first]);
        setActiveId(first.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeId) saveActiveChatId(activeId);
  }, [activeId]);

  // Chats from the server list arrive without messages; fetch the one being opened.
  useEffect(() => {
    if (!storage || !chats) return;
    const active = chats.find((chat) => chat.id === activeId);
    if (!active || active.messages !== null) return;
    let cancelled = false;
    storage.load(active.id).then((messages) => {
      if (cancelled) return;
      setChats((current) => current?.map((chat) => (chat.id === active.id ? { ...chat, messages } : chat)) ?? current);
    });
    return () => {
      cancelled = true;
    };
  }, [storage, chats, activeId]);

  function startNewChat() {
    if (!chats) return;
    // Reuse an empty chat instead of piling up blank ones.
    const empty = chats.find((chat) => chat.messages?.length === 0);
    if (empty) {
      setActiveId(empty.id);
    } else {
      const fresh = blank();
      setChats([fresh, ...chats]);
      setActiveId(fresh.id);
    }
    setMenuOpen(false);
  }

  function deleteChat(id: string) {
    if (!chats || !storage) return;
    void storage.remove(id).catch(() => setSaveError("Could not delete that chat."));
    let next = chats.filter((chat) => chat.id !== id);
    if (next.length === 0) next = [blank()];
    setChats(next);
    if (id === activeId) setActiveId(next[0].id);
  }

  function updateMessages(id: string, messages: UIMessage[]) {
    if (!storage) return;
    const existing = chats?.find((chat) => chat.id === id);
    const title = titleFrom(messages, existing?.title ?? "New chat");
    const updatedAt = Date.now();
    setChats((current) => current?.map((chat) => (chat.id === id ? { ...chat, messages, title, updatedAt } : chat)) ?? current);
    if (messages.length > 0) {
      setSaveError("");
      void storage.save({ id, title, updatedAt, messages }).catch(() => setSaveError("Could not save this chat; it will be lost on reload."));
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  if (!chats || !storage) return <main className="min-h-screen" aria-busy="true" />;
  const active = chats.find((chat) => chat.id === activeId) ?? chats[0];

  return (
    <main className="min-h-screen px-4 py-5 sm:px-8 sm:py-8">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-7xl flex-col">
        <header className="mb-5 flex items-center justify-between gap-4 px-1">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="Chats"
              aria-expanded={menuOpen}
              className="grid h-11 w-11 place-items-center rounded-2xl border border-white/80 bg-white/60 text-lg text-amber-900 shadow-sm lg:hidden"
            >
              ☰
            </button>
            <div className="hidden h-11 w-11 place-items-center rounded-2xl border border-white/80 bg-white/60 text-lg text-amber-900 shadow-sm lg:grid">
              श
            </div>
            <div>
              <p className="font-serif text-xl tracking-tight text-cream-900">Shastra</p>
              <p className="text-[11px] uppercase tracking-[0.2em] text-cream-700">Vedic deep research</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-white/70 bg-white/45 px-3 py-1.5 text-xs text-cream-700 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-700" />
              Source-bound to vedic.study
            </span>
            <button
              type="button"
              onClick={signOut}
              className="rounded-full px-3 py-2 text-xs text-cream-700 transition hover:bg-white/60"
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="flex flex-1 gap-4">
          <aside
            className={`${menuOpen ? "block" : "hidden"} w-full shrink-0 lg:block lg:w-64`}
            aria-label="Chats"
          >
            <div className="glass-surface rounded-[1.6rem] p-3 lg:sticky lg:top-6">
              <button
                type="button"
                onClick={startNewChat}
                className="w-full rounded-full bg-cream-900 px-4 py-2.5 text-xs font-medium text-cream-50 transition hover:bg-cream-700"
              >
                + New chat
              </button>
              <ul className="soft-scrollbar mt-3 max-h-[60vh] space-y-1 overflow-y-auto">
                {chats.map((chat) => (
                  <li key={chat.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(chat.id);
                        setMenuOpen(false);
                      }}
                      aria-current={chat.id === active.id}
                      className={`min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-xs transition ${
                        chat.id === active.id ? "bg-white/80 text-cream-900 shadow-sm" : "text-cream-700 hover:bg-white/55"
                      }`}
                    >
                      {chat.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteChat(chat.id)}
                      aria-label={`Delete chat: ${chat.title}`}
                      className="rounded-full px-2 py-1 text-xs text-cream-700 opacity-60 transition hover:bg-white/70 hover:opacity-100"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            {saveError && (
              <p role="alert" className="mb-3 rounded-2xl border border-red-300/70 bg-red-50/75 px-4 py-2 text-xs text-red-900">
                {saveError}
              </p>
            )}
            {active.messages === null ? (
              <div className="glass-surface grid min-h-[40vh] place-items-center rounded-[2rem] text-sm text-cream-700">Opening chat…</div>
            ) : (
              <ChatSession
                key={active.id}
                chatId={active.id}
                initialMessages={active.messages}
                onMessages={(messages) => updateMessages(active.id, messages)}
              />
            )}
          </div>
        </div>
        <footer className="px-2 pt-3 text-center text-[10px] leading-5 text-cream-700/80">
          Research is limited to retrieved vedic.study pages. Verify source passages and translations before relying on them.
        </footer>
      </div>
    </main>
  );
}
