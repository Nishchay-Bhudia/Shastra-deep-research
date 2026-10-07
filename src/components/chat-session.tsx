"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { GlassPanel } from "@/components/glass-panel";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { PdfViewer } from "@/components/pdf-viewer";
import { ThinkingWord } from "@/components/thinking-word";
import { phaseFor } from "@/lib/research/thinking-words";
import { compactForStorage } from "@/lib/chat-store";
import { analyzeMessage, type MessageLike } from "@/lib/research/extract";
import { finalizeReport, pdfFileName } from "@/lib/research/report";

type Depth = "standard" | "deep" | "really-deep";
type Language = "English" | "Gujarati";
type Deliverables = { pdf: boolean; diagrams: boolean };
type PdfState =
  | { status: "working" }
  | { status: "ready"; url: string; fileName: string; stored: boolean }
  | { status: "error"; message: string };

export type StoredPdfs = Record<string, { fileName: string }>;

const pdfUrl = (chatId: string, messageId: string, fileName: string) =>
  `/api/pdfs/${chatId}/${messageId}?name=${encodeURIComponent(fileName)}`;

const depthOptions: { value: Depth; label: string; detail: string }[] = [
  { value: "standard", label: "Standard", detail: "Quick, focused answer" },
  { value: "deep", label: "Deep", detail: "Cross-references sources" },
  { value: "really-deep", label: "Really deep", detail: "No step limit · goes as deep as needed" },
];

const PREFS_KEY = "shastra.prefs.v1";

function loadPrefs(): { depth: Depth; language: Language; deliverables: Deliverables } {
  const fallback = { depth: "deep" as Depth, language: "English" as Language, deliverables: { pdf: true, diagrams: true } };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function plainText(message: MessageLike) {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function ChatSession({
  chatId,
  initialMessages,
  initialPdfs,
  onChange,
}: {
  chatId: string;
  initialMessages: UIMessage[];
  /** Reports whose PDF was stored on the server in an earlier visit; shown again after a reload. */
  initialPdfs: StoredPdfs;
  onChange: (state: { messages: UIMessage[]; pdfs: StoredPdfs }) => void;
}) {
  const [draft, setDraft] = useState("");
  const [depth, setDepth] = useState<Depth>("deep");
  const [language, setLanguage] = useState<Language>("English");
  const [deliverables, setDeliverables] = useState<Deliverables>({ pdf: true, diagrams: true });
  const [pdfs, setPdfs] = useState<Record<string, PdfState>>(() =>
    Object.fromEntries(
      Object.entries(initialPdfs).map(([messageId, info]) => [
        messageId,
        { status: "ready", url: pdfUrl(chatId, messageId, info.fileName), fileName: info.fileName, stored: true } as PdfState,
      ]),
    ),
  );
  const [notice, setNotice] = useState("");
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [viewing, setViewing] = useState<{ url: string; fileName: string } | null>(null);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/research" }), []);
  const { messages, sendMessage, status, stop, error } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
  });
  const isBusy = status === "submitted" || status === "streaming";

  // Remembered choices (depth, language, deliverables).
  useEffect(() => {
    const prefs = loadPrefs();
    setDepth(prefs.depth);
    setLanguage(prefs.language);
    setDeliverables(prefs.deliverables);
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ depth, language, deliverables }));
    } catch {
      /* ignore */
    }
  }, [depth, language, deliverables, prefsLoaded]);

  // Persist the conversation (and which reports have a stored PDF) once a response has finished,
  // not on every streamed token.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const storedPdfs = (current: Record<string, PdfState>): StoredPdfs =>
    Object.fromEntries(
      Object.entries(current)
        .filter((entry): entry is [string, Extract<PdfState, { status: "ready" }>] => entry[1].status === "ready" && entry[1].stored)
        .map(([messageId, pdf]) => [messageId, { fileName: pdf.fileName }]),
    );
  function persist(current: Record<string, PdfState>) {
    if (messagesRef.current.length > 0) {
      onChange({ messages: compactForStorage(messagesRef.current), pdfs: storedPdfs(current) });
    }
  }
  useEffect(() => {
    if (status === "ready") persist(pdfsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Leaving this chat (new chat / switching) cancels a run in progress and frees PDF blobs.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const pdfsRef = useRef(pdfs);
  pdfsRef.current = pdfs;
  useEffect(
    () => () => {
      stopRef.current();
      Object.values(pdfsRef.current).forEach((pdf) => pdf.status === "ready" && !pdf.stored && URL.revokeObjectURL(pdf.url));
    },
    [],
  );

  function reportFor(message: UIMessage) {
    const analysis = analyzeMessage(message as MessageLike);
    const markdown = finalizeReport({
      markdown: analysis.text,
      sources: analysis.sources,
      notes: analysis.notes,
      diagrams: analysis.diagrams,
      includeDiagrams: deliverables.diagrams,
    });
    return { analysis, markdown };
  }

  async function createPdf(message: UIMessage, index: number) {
    const { analysis, markdown } = reportFor(message);
    const question = [...messages.slice(0, index)].reverse().find((m) => m.role === "user");
    const questionText = question ? plainText(question as MessageLike) : "";
    const title = analysis.plan?.reportTitle || questionText.slice(0, 120) || "Research report";
    setPdfs((current) => ({ ...current, [message.id]: { status: "working" } }));

    let lastError = "Could not create the PDF.";
    // One automatic retry: PDF rendering occasionally fails on a cold server.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch("/api/export/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ markdown, title, subtitle: questionText.slice(0, 400), chatId, messageId: message.id }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "Could not create the PDF.");
        }
        const ready: PdfState = (response.headers.get("content-type") || "").includes("application/json")
          ? await response.json().then((data: { fileName: string; url: string }) => ({
              status: "ready" as const,
              url: data.url,
              fileName: data.fileName,
              stored: true,
            }))
          : { status: "ready", url: URL.createObjectURL(await response.blob()), fileName: pdfFileName(title), stored: false };
        const next = { ...pdfsRef.current, [message.id]: ready };
        pdfsRef.current = next;
        setPdfs(next);
        persist(next);
        return;
      } catch (pdfError) {
        lastError = pdfError instanceof Error ? pdfError.message : lastError;
      }
    }
    setPdfs((current) => ({ ...current, [message.id]: { status: "error", message: lastError } }));
  }

  // At the end of a run, produce the PDF automatically when that deliverable is selected.
  const previousStatus = useRef(status);
  useEffect(() => {
    const finishedRun = previousStatus.current !== "ready" && status === "ready";
    previousStatus.current = status;
    if (!finishedRun || !deliverables.pdf) return;
    const index = messages.length - 1;
    const last = messages[index];
    if (last?.role === "assistant" && analyzeMessage(last as MessageLike).text.trim().length > 200) {
      void createPdf(last, index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isBusy) return;
    setDraft("");
    setNotice("");
    try {
      await sendMessage({ text }, { body: { depth, language, deliverables } });
    } catch (sendError) {
      setNotice(sendError instanceof Error ? sendError.message : "The request could not be sent.");
    }
  }

  return (
    <GlassPanel className="flex min-h-[calc(100vh-7.5rem)] flex-1 flex-col overflow-hidden">
      <div className="border-b border-cream-400/55 px-5 py-5 sm:px-8">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-[0.19em] text-cream-700">Research workspace</p>
            <h1 className="font-serif text-2xl tracking-tight text-cream-900 sm:text-3xl">Follow the source. Build the argument.</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-cream-700">
              Ask in English or Gujarati. Every report is grounded in retrieved vedic.study pages and links back to its sources.
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
                depth === option.value ? "border-cream-500 bg-white/80 shadow-sm" : "border-white/65 bg-white/30 hover:bg-white/60"
              }`}
            >
              <span className="block text-sm font-medium text-cream-900">{option.label}</span>
              <span className="mt-0.5 block text-[11px] text-cream-700">{option.detail}</span>
            </button>
          ))}
        </div>

        <fieldset className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <legend className="sr-only">Deliverables</legend>
          <span className="text-xs font-medium uppercase tracking-[0.16em] text-cream-700">Deliverables</span>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-cream-900">
            <input
              type="checkbox"
              checked={deliverables.pdf}
              onChange={(event) => setDeliverables((d) => ({ ...d, pdf: event.target.checked }))}
              className="h-4 w-4 accent-[#5c4a29]"
            />
            PDF report
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-cream-900">
            <input
              type="checkbox"
              checked={deliverables.diagrams}
              onChange={(event) => setDeliverables((d) => ({ ...d, diagrams: event.target.checked }))}
              className="h-4 w-4 accent-[#5c4a29]"
            />
            Include diagrams
          </label>
        </fieldset>
      </div>

      <section aria-live="polite" aria-label="Research conversation" className="soft-scrollbar flex-1 space-y-7 overflow-y-auto px-5 py-6 sm:px-8">
        {messages.length === 0 ? (
          <div className="grid min-h-[320px] place-items-center py-10 text-center">
            <div className="gentle-float max-w-lg">
              <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-[1.4rem] border border-white/80 bg-white/55 font-serif text-2xl text-amber-900 shadow-sm">
                ॐ
              </div>
              <h2 className="font-serif text-2xl text-cream-900">Start with a question</h2>
              <p className="mt-3 text-sm leading-6 text-cream-700">
                Trace a concept across texts, compare interpretations, or find the context for a verse. The agent plans its
                research, reads vedic.study, checks its own coverage, and only then writes.
              </p>
              <button
                type="button"
                onClick={() => setDraft("How does the concept of dharma develop across the sources?")}
                className="mt-5 rounded-full border border-cream-400/75 bg-white/50 px-4 py-2 text-xs text-cream-700 transition hover:bg-white/85"
              >
                Try a sample question
              </button>
            </div>
          </div>
        ) : (
          messages.map((message, index) => {
            if (message.role === "user") {
              return (
                <div key={message.id} className="ml-auto max-w-3xl">
                  <div className="rounded-3xl rounded-br-md border border-cream-400/60 bg-white/65 px-5 py-4 text-sm leading-7 text-cream-900 shadow-sm">
                    {plainText(message as MessageLike)}
                  </div>
                </div>
              );
            }
            const isLast = index === messages.length - 1;
            const live = isBusy && isLast;
            const { analysis, markdown } = reportFor(message);
            const hasReport = analysis.text.trim().length > 0;
            const pdf = pdfs[message.id];
            return (
              <article key={message.id} className="max-w-4xl">
                {analysis.plan && (
                  <details open={!hasReport} className="mb-4 rounded-2xl border border-cream-300 bg-white/45 px-4 py-3 text-sm text-cream-900">
                    <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.14em] text-cream-700">
                      Research plan · {analysis.plan.reportTitle}
                    </summary>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-cream-800">
                      {analysis.plan.subQuestions.map((question) => (
                        <li key={question}>{question}</li>
                      ))}
                    </ol>
                  </details>
                )}
                {(live || analysis.counts.searches + analysis.counts.reads > 0) && (
                  <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-cream-700">
                    {live && (
                      <ThinkingWord phase={phaseFor(analysis.activity, Boolean(analysis.plan), hasReport)} />
                    )}
                    <span>
                      {analysis.counts.searches} searches · {analysis.counts.reads} pages read · {analysis.counts.notes} notes
                      {analysis.diagrams.length > 0 && ` · ${analysis.diagrams.length} diagram${analysis.diagrams.length === 1 ? "" : "s"}`}
                    </span>
                  </p>
                )}
                {hasReport ? <MarkdownRenderer content={markdown} /> : <span className="sr-only">Research in progress</span>}

                {hasReport && !live && pdf && (
                  <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-cream-300 bg-white/45 px-4 py-3 text-sm">
                    {pdf.status === "working" && (
                      <span className="flex items-center gap-2 text-cream-700">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-600" />
                        Creating your PDF…
                      </span>
                    )}
                    {pdf.status === "ready" && (
                      <>
                        <span className="min-w-0 truncate text-cream-900">{pdf.fileName}</span>
                        <button
                          type="button"
                          onClick={() => setViewing({ url: pdf.url, fileName: pdf.fileName })}
                          className="rounded-full border border-cream-400 bg-white/60 px-4 py-2 text-xs font-medium text-cream-900 transition hover:bg-white"
                        >
                          View PDF
                        </button>
                        <a
                          href={pdf.url}
                          download={pdf.fileName}
                          className="rounded-full bg-cream-900 px-4 py-2 text-xs font-medium text-cream-50 transition hover:bg-cream-700"
                        >
                          Download PDF
                        </a>
                      </>
                    )}
                    {pdf.status === "error" && <span className="text-red-900">{pdf.message}</span>}
                  </div>
                )}
              </article>
            );
          })
        )}
        {error && (
          <div role="alert" className="rounded-2xl border border-red-300/70 bg-red-50/75 px-4 py-3 text-sm text-red-900">
            {error.message}
          </div>
        )}
        {notice && (
          <div role="alert" className="rounded-2xl border border-red-300/70 bg-red-50/75 px-4 py-3 text-sm text-red-900">
            {notice}
          </div>
        )}
      </section>

      <form onSubmit={handleSubmit} className="border-t border-cream-400/55 bg-white/20 p-4 sm:px-8 sm:py-5">
        {isBusy && (
          <p
            role="status"
            className="mb-3 rounded-2xl border border-amber-400/60 bg-amber-50/80 px-4 py-2.5 text-xs leading-5 text-amber-950"
          >
            <strong>Please stay on this tab and keep your device awake while the research runs.</strong> If the screen turns
            off or you switch away, the research stops.
          </p>
        )}
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
            {language} · {depthOptions.find((item) => item.value === depth)?.label} depth ·{" "}
            {[deliverables.pdf && "PDF", deliverables.diagrams && "diagrams"].filter(Boolean).join(" + ") || "text only"}
          </span>
        </div>
      </form>
      {viewing && <PdfViewer url={viewing.url} fileName={viewing.fileName} onClose={() => setViewing(null)} />}
    </GlassPanel>
  );
}
