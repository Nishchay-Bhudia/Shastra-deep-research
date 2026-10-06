"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo, useState, type FormEvent } from "react";
import { GlassPanel } from "@/components/glass-panel";
import { MarkdownRenderer } from "@/components/markdown-renderer";

type Depth = "standard" | "deep" | "really-deep";
type Language = "English" | "Gujarati";

const depthOptions: { value: Depth; label: string; detail: string }[] = [
  { value: "standard", label: "Standard", detail: "Quick overview · up to 5 steps" },
  { value: "deep", label: "Deep", detail: "Cross-reference · up to 15 steps" },
  { value: "really-deep", label: "Really deep", detail: "Exhaustive inquiry · up to 30 steps" },
];

function messageText(message: { parts?: Array<{ type: string; text?: string }> }) {
  return (message.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

type ToolPart = { type: string; state?: string; output?: unknown };

/** URLs the tools actually returned, used to verify the report's citations. */
function retrievedSources(message: { parts?: ToolPart[] }) {
  const sources = new Map<string, string>();
  const add = (url: unknown, title: unknown) => {
    if (typeof url !== "string") return;
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      sources.set(parsed.href.replace(/\/$/, ""), typeof title === "string" ? title : url);
    } catch {
      /* ignore malformed URLs */
    }
  };
  for (const part of message.parts || []) {
    if (part.state !== "output-available" || !part.output) continue;
    const output = part.output as {
      url?: string;
      title?: string;
      links?: { url: string; text: string }[];
      results?: { url: string; title: string }[];
    };
    add(output.url, output.title);
    output.results?.forEach((result) => add(result.url, result.title));
    output.links?.forEach((link) => add(link.url, link.text));
  }
  return sources;
}

function toolStatus(message: {
  parts?: Array<{ type: string; state?: string; input?: unknown }>;
}) {
  return (message.parts || [])
    .filter((part) => part.type.startsWith("tool-"))
    .map((part, index) => {
      const label =
        part.type === "tool-search_knowledge_base"
          ? "Searching vedic.study"
          : part.type === "tool-read_document"
            ? "Reading a source"
            : "Researching";
      const done = part.state === "output-available" || part.state === "output-error";
      return (
        <div
          key={`${part.type}-${index}`}
          className="flex items-center gap-2 text-xs text-cream-700"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              done ? "bg-cream-500" : "animate-pulse bg-amber-600"
            }`}
          />
          {label}
          {!done && <span className="animate-pulse">…</span>}
        </div>
      );
    });
}

export function ResearchDashboard() {
  const [draft, setDraft] = useState("");
  const [depth, setDepth] = useState<Depth>("deep");
  const [language, setLanguage] = useState<Language>("English");
  const [authError, setAuthError] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/research" }),
    [],
  );
  const { messages, sendMessage, status, stop, error } = useChat({ transport });
  const isBusy = status === "submitted" || status === "streaming";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isBusy) return;
    setDraft("");
    setAuthError("");
    try {
      await sendMessage({ text }, { body: { depth, language } });
    } catch (sendError) {
      setAuthError(
        sendError instanceof Error ? sendError.message : "The request could not be sent.",
      );
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  return (
    <main className="min-h-screen px-4 py-5 sm:px-8 sm:py-8">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-6xl flex-col">
        <header className="mb-5 flex items-center justify-between gap-4 px-1">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl border border-white/80 bg-white/60 text-lg text-amber-900 shadow-sm">
              श
            </div>
            <div>
              <p className="font-serif text-xl tracking-tight text-cream-900">Shastra</p>
              <p className="text-[11px] uppercase tracking-[0.2em] text-cream-700">
                Vedic deep research
              </p>
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

        <GlassPanel className="flex min-h-[calc(100vh-7.5rem)] flex-1 flex-col overflow-hidden">
          <div className="border-b border-cream-400/55 px-5 py-5 sm:px-8">
            <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.19em] text-cream-700">
                  Research workspace
                </p>
                <h1 className="font-serif text-2xl tracking-tight text-cream-900 sm:text-3xl">
                  Follow the source. Build the argument.
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-cream-700">
                  Ask in English or Gujarati. Every report is grounded in retrieved
                  vedic.study pages and links back to its sources.
                </p>
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Output language">
                {(["English", "Gujarati"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setLanguage(option)}
                    aria-pressed={language === option}
                    className={`rounded-full border px-3.5 py-2 text-xs transition ${
                      language === option
                        ? "border-cream-700/50 bg-cream-900 text-cream-50"
                        : "border-cream-400/70 bg-white/45 text-cream-700 hover:bg-white/80"
                    }`}
                  >
                    {option === "Gujarati" ? "ગુજરાતી" : option}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-3" aria-label="Research depth">
              {depthOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setDepth(option.value)}
                  aria-pressed={depth === option.value}
                  className={`rounded-2xl border px-4 py-3 text-left transition ${
                    depth === option.value
                      ? "border-cream-500 bg-white/80 shadow-sm"
                      : "border-white/65 bg-white/30 hover:bg-white/60"
                  }`}
                >
                  <span className="block text-sm font-medium text-cream-900">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-cream-700">
                    {option.detail}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <section
            aria-live="polite"
            aria-label="Research conversation"
            className="soft-scrollbar flex-1 space-y-7 overflow-y-auto px-5 py-6 sm:px-8"
          >
            {messages.length === 0 ? (
              <div className="grid min-h-[360px] place-items-center py-10 text-center">
                <div className="gentle-float max-w-lg">
                  <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-[1.4rem] border border-white/80 bg-white/55 font-serif text-2xl text-amber-900 shadow-sm">
                    ॐ
                  </div>
                  <h2 className="font-serif text-2xl text-cream-900">
                    Start with a question
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-cream-700">
                    Trace a concept across texts, compare interpretations, or find
                    the context for a verse. The research agent searches and reads
                    vedic.study before it draws conclusions.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft("How does the concept of dharma develop across the sources?")
                    }
                    className="mt-5 rounded-full border border-cream-400/75 bg-white/50 px-4 py-2 text-xs text-cream-700 transition hover:bg-white/85"
                  >
                    Try a sample question
                  </button>
                </div>
              </div>
            ) : (
              messages.map((message) => {
                const text = messageText(message);
                const statuses = toolStatus(message);
                const sources = retrievedSources(message as { parts?: ToolPart[] });
                const readCount = (message.parts || []).filter(
                  (part) => part.type === "tool-read_document",
                ).length;
                if (message.role === "user") {
                  return (
                    <div key={message.id} className="ml-auto max-w-3xl">
                      <div className="rounded-3xl rounded-br-md border border-cream-400/60 bg-white/65 px-5 py-4 text-sm leading-7 text-cream-900 shadow-sm">
                        {text}
                      </div>
                    </div>
                  );
                }
                return (
                  <article key={message.id} className="max-w-4xl">
                    {(statuses.length > 0 || (!text && isBusy)) && (
                      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2">
                        {statuses}
                        {statuses.length === 0 && (
                          <div className="flex items-center gap-2 text-xs text-cream-700">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-600" />
                            Preparing research
                          </div>
                        )}
                      </div>
                    )}
                    {text ? (
                      <MarkdownRenderer content={text} verifiedUrls={new Set(sources.keys())} />
                    ) : (
                      <span className="sr-only">Research in progress</span>
                    )}
                    {text && readCount > 0 && (
                      <details className="mt-4 rounded-2xl border border-cream-300 bg-white/40 px-4 py-3 text-xs text-cream-700">
                        <summary className="cursor-pointer">
                          {readCount} page{readCount === 1 ? "" : "s"} read · {sources.size} sources surfaced
                        </summary>
                        <ul className="mt-2 space-y-1">
                          {Array.from(sources).slice(0, 60).map(([url, title]) => (
                            <li key={url}>
                              <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
                                {title}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </article>
                );
              })
            )}
            {error && (
              <div
                role="alert"
                className="rounded-2xl border border-red-300/70 bg-red-50/75 px-4 py-3 text-sm text-red-900"
              >
                {error.message}
              </div>
            )}
            {authError && (
              <div
                role="alert"
                className="rounded-2xl border border-red-300/70 bg-red-50/75 px-4 py-3 text-sm text-red-900"
              >
                {authError}
              </div>
            )}
          </section>

          <form
            onSubmit={handleSubmit}
            className="border-t border-cream-400/55 bg-white/20 p-4 sm:px-8 sm:py-5"
          >
            <label className="sr-only" htmlFor="research-question">
              Research question
            </label>
            <div className="flex items-end gap-3 rounded-[1.6rem] border border-white/80 bg-white/65 p-2 shadow-[inset_0_1px_2px_rgba(92,74,41,.04)]">
              <textarea
                id="research-question"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                maxLength={2_000}
                rows={2}
                placeholder="Ask a question about a text, concept, or interpretation…"
                className="max-h-40 min-h-[54px] flex-1 resize-y bg-transparent px-3 py-3 text-sm leading-6 text-cream-900 outline-none placeholder:text-cream-700/70"
              />
              {isBusy ? (
                <button
                  type="button"
                  onClick={stop}
                  className="mb-0.5 rounded-full border border-cream-400 bg-cream-100 px-4 py-2.5 text-xs font-medium text-cream-900 transition hover:bg-cream-200"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!draft.trim()}
                  className="mb-0.5 rounded-full bg-cream-900 px-5 py-2.5 text-xs font-medium text-cream-50 transition hover:bg-cream-700 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Research
                </button>
              )}
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 px-2 text-[10px] text-cream-700">
              <span>Enter to send · Shift + Enter for a new line</span>
              <span>
                {language} · {depthOptions.find((item) => item.value === depth)?.label} depth
              </span>
            </div>
          </form>
        </GlassPanel>
        <footer className="px-2 pt-3 text-center text-[10px] leading-5 text-cream-700/80">
          Research is limited to retrieved vedic.study pages. Verify source passages
          and translations before relying on them.
        </footer>
      </div>
    </main>
  );
}
