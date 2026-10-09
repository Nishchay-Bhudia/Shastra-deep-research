import { mistral } from "@/lib/mistral";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { normalizeScrapedText } from "@/lib/nlp/transliterate";
import {
  buildSystemPrompt,
  DEFAULT_MODEL,
  getStepCeiling,
  getStepGuidance,
  getTimeBudgetMs,
} from "@/lib/research/config";
import { compactToolResults } from "@/lib/research/context";
import { compileFallbackReport } from "@/lib/research/fallback";
import { deleteRun, isValidRunId, loadRun, newRunId, saveRun } from "@/lib/research/run-store";
import { checkReport, minNotesFor } from "@/lib/research/quality";
import { buildDiagram, type BuiltDiagram } from "@/lib/research/diagram";
import { normalizeVedicUrl, urlKey } from "@/lib/vedic-url";
import {
  hasVedicAccess,
  prewarmScraper,
  readVedicDocument,
  searchVedicKnowledgeBase,
} from "@/lib/scraper/browser";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  messages: z.array(z.unknown()).min(1).max(30),
  depth: z.enum(["standard", "deep", "really-deep"]).default("standard"),
  language: z.enum(["English", "Gujarati"]).default("English"),
  deliverables: z
    .object({ pdf: z.boolean().default(true), diagrams: z.boolean().default(true) })
    .default({ pdf: true, diagrams: true }),
  /** Set when the app is continuing a run that outgrew one request. */
  runId: z.string().optional(),
  resume: z.boolean().default(false),
});

/** The app sends this as a hidden message to continue a run; it is never shown or sent to the model. */
const CONTINUE_SENTINEL = "[[continue]]";
const MAX_SEGMENTS = 16;

const MAX_QUERY_LENGTH = 2_000;
const DOCUMENT_CHUNK_LENGTH = 22_000;
const BATCH_DOCUMENT_CHARS = 10_000;
const MAX_NOTES = 300;
const MAX_LEDGER_CHARS = 60_000;
const MAX_DIAGRAMS = 3;
const BOOTSTRAP_SEARCHES = 6;

// A Vercel function is killed at 300 s, so a long run is split into segments: each does as much as it
// safely can, saves its state, and the app resumes it with a fresh request. There is no overall limit
// beyond RESEARCH_MAX_MINUTES (a runaway guard) and MAX_SEGMENTS.
const SEGMENT_RESEARCH_MS = process.env.VERCEL ? 150_000 : Number.POSITIVE_INFINITY;
// Writing (analysis, diagrams, the report) needs ~150 s of room; if less is left, start it next segment.
const SEGMENT_WRITE_START_MS = process.env.VERCEL ? 120_000 : Number.POSITIVE_INFINITY;
const SEGMENT_HARD_MS = process.env.VERCEL ? 262_000 : Number.POSITIVE_INFINITY;

type Note = { url: string; title: string; note: string; quote?: string; subQuestion?: number };
type Plan = { reportTitle: string; subQuestions: string[]; searchTerms: string[] };

/** Everything one research run accumulates; lives only for the duration of the request. */
type RunState = {
  plan?: Plan;
  notes: Note[];
  /** Canonical keys (see urlKey) of every page the tools have returned. */
  retrieved: Set<string>;
  diagrams: BuiltDiagram[];
  coverageChecks: number;
  readyToWrite: boolean;
  searches: number;
  reads: number;
  diagramAttempts: number;
  analysis?: Analysis;
  analysisAttempts: number;
  /** When the run began (across segments); the overall time guard is measured from here. */
  runStartedAt: number;
  segments: number;
  segmentOver: boolean;
  /** Consecutive segments that made no progress; too many and the run falls back. */
  stalls: number;
  hits: { title: string; url: string; snippet: string }[];
  /** Every same-site link found on pages that were read, by canonical key. */
  linkPool: Map<string, { title: string; url: string }>;
  readKeys: Set<string>;
  readsAfterFirstCheck: number;
  reportAttempts: number;
  accepted: boolean;
  finalizing: boolean;
  qualityIssues: string[];
  /** Problems the tools hit (shown to the reader if no report can be written). */
  errors: string[];
  fallbackSent: boolean;
  /** The agent could not produce a usable report; stop and deliver the compiled fallback. */
  abandon: boolean;
};

type Analysis = {
  thesis: string;
  findings: { subQuestion: number; claim: string; reasoning: string; confidence: string; noteNumbers: number[] }[];
  relationships: { kind: string; description: string; noteNumbers: number[] }[];
  tensions: string[];
  gaps: string[];
  outline: string[];
};

/**
 * Searches allowed before the agent must read, note, and check coverage. A small model left alone
 * will happily search forever; reading pages is where the evidence is. Exhaustive runs are uncapped.
 */
function getSearchBudget(depth: "standard" | "deep" | "really-deep"): number {
  if (depth === "standard") return 12;
  if (depth === "deep") return 25;
  return Number.POSITIVE_INFINITY;
}

function getReadBudget(depth: "standard" | "deep" | "really-deep"): number {
  if (depth === "standard") return 16;
  if (depth === "deep") return 40;
  return Number.POSITIVE_INFINITY;
}

/** Nudges that keep a research run moving from searching to reading to noting to checking. */
function progressNote(state: RunState, depth: "standard" | "deep" | "really-deep"): string | undefined {
  const planned = state.plan?.subQuestions.length ?? 0;
  if (state.reads >= getReadBudget(depth)) {
    return "Your reading budget is used up. Save notes for what you have read and call check_coverage.";
  }
  if (state.searches >= getSearchBudget(depth)) {
    return "Your search budget is used up. Read the most relevant pages, save notes, and call check_coverage.";
  }
  if (state.searches >= 3 && state.reads === 0) {
    return "You have searched enough to choose sources. Now read the 4-8 most relevant pages with read_documents (up to 5 per call), then save notes. Searching again without reading finds nothing new.";
  }
  if (state.reads > 0 && state.notes.length === 0) {
    return "You have read pages but saved no notes. Call save_note now for each important finding, with its sub-question number.";
  }
  if (planned > 0 && state.coverageChecks === 0 && state.notes.length >= planned * 2) {
    return "You have substantial notes. If every sub-question is answered, call check_coverage now.";
  }
  return undefined;
}

/**
 * Earlier turns keep their text (and its citations) but drop raw tool output,
 * which would otherwise re-send tens of thousands of tokens on every follow-up.
 */
function stripOldToolParts(messages: UIMessage[]): UIMessage[] {
  const lastIndex = messages.length - 1;
  return messages.map((message, index) => {
    if (index === lastIndex) return message;
    const parts = (message.parts as { type: string; state?: string; input?: { markdown?: unknown }; output?: { accepted?: boolean } }[])
      .map((part) =>
        // A delivered report lives in a submit_report call; keep its text so follow-up questions have it.
        part.type === "tool-submit_report" && part.output?.accepted === true && typeof part.input?.markdown === "string"
          ? { type: "text" as const, text: part.input.markdown }
          : part,
      )
      .filter((part) => !part.type.startsWith("tool-"));
    return { ...message, parts } as UIMessage;
  });
}

function formatLedger(state: RunState): string {
  let text = "";
  if (state.plan) {
    text += `\n\nRESEARCH PLAN (report title: "${state.plan.reportTitle}")\n${state.plan.subQuestions
      .map((question, index) => `Q${index + 1}. ${question}`)
      .join("\n")}\nSearch terms: ${state.plan.searchTerms.join("; ")}`;
  }
  if (state.analysis) {
    const a = state.analysis;
    const refs = (numbers: number[]) => (numbers.length ? ` [${numbers.join(", ")}]` : "");
    text += `\n\nYOUR ANALYSIS (write the report from this; cite the note numbers shown)\nThesis: ${a.thesis}\n${a.findings
      .map((f) => `- Q${f.subQuestion} (${f.confidence}): ${f.claim} — ${f.reasoning}${refs(f.noteNumbers)}`)
      .join("\n")}${
      a.relationships.length ? `\nHow the sources relate:\n${a.relationships.map((r) => `- ${r.kind}: ${r.description}${refs(r.noteNumbers)}`).join("\n")}` : ""
    }${a.tensions.length ? `\nTensions: ${a.tensions.join(" | ")}` : ""}${a.gaps.length ? `\nGaps: ${a.gaps.join(" | ")}` : ""}${
      a.outline.length ? `\nReport outline: ${a.outline.join(" → ")}` : ""
    }`;
  }
  if (state.notes.length > 0) {
    const lines = state.notes
      .map(
        (entry, index) =>
          `${index + 1}.${entry.subQuestion ? ` [Q${entry.subQuestion}]` : ""} [${entry.title}](${entry.url}) — ${entry.note}${
            entry.quote ? ` Quote: "${entry.quote}"` : ""
          }\n`,
      )
      .join("");
    // Keep the most recent notes if the ledger outgrows its budget.
    const trimmed = lines.length > MAX_LEDGER_CHARS ? lines.slice(-MAX_LEDGER_CHARS) : lines;
    text += `\n\nRESEARCH NOTES SAVED SO FAR (your evidence; cite these URLs):\n${trimmed}`;
  }
  return text;
}

type SavedRun = Omit<RunState, "retrieved" | "linkPool" | "readKeys"> & {
  retrieved: string[];
  linkPool: [string, { title: string; url: string }][];
  readKeys: string[];
};

function freshState(now: number): RunState {
  return {
    notes: [],
    retrieved: new Set(),
    diagrams: [],
    coverageChecks: 0,
    readyToWrite: false,
    searches: 0,
    reads: 0,
    diagramAttempts: 0,
    analysisAttempts: 0,
    runStartedAt: now,
    segments: 1,
    segmentOver: false,
    stalls: 0,
    hits: [],
    linkPool: new Map(),
    readKeys: new Set(),
    readsAfterFirstCheck: 0,
    reportAttempts: 0,
    accepted: false,
    finalizing: false,
    qualityIssues: [],
    errors: [],
    fallbackSent: false,
    abandon: false,
  };
}

function serializeState(state: RunState): SavedRun {
  return { ...state, retrieved: [...state.retrieved], linkPool: [...state.linkPool], readKeys: [...state.readKeys] };
}

function hydrateState(saved: SavedRun): RunState {
  return {
    ...freshState(saved.runStartedAt),
    ...saved,
    retrieved: new Set(saved.retrieved),
    linkPool: new Map(saved.linkPool),
    readKeys: new Set(saved.readKeys),
    segmentOver: false,
    finalizing: false,
    fallbackSent: false,
  };
}

/** A number that grows whenever a segment gets somewhere; equal before and after means it stalled. */
function progressOf(state: RunState): number {
  return state.notes.length * 3 + state.searches + state.reads + state.coverageChecks + state.diagrams.length * 2 +
    (state.analysis ? 5 : 0) + state.reportAttempts * 4 + (state.plan ? 1 : 0);
}

function recordError(state: RunState, message: string) {
  const short = message.split("\n")[0].slice(0, 240);
  if (!state.errors.includes(short) && state.errors.length < 8) state.errors.push(short);
}

function addHits(state: RunState, results: { title: string; url: string; snippet: string }[]) {
  for (const result of results) {
    if (state.hits.length >= 40) return;
    const key = urlKey(result.url);
    if (key && !state.hits.some((hit) => urlKey(hit.url) === key)) {
      state.hits.push({ title: result.title, url: result.url, snippet: normalizeScrapedText(result.snippet).slice(0, 320) });
    }
  }
}

function remember(state: RunState, url: unknown) {
  if (typeof url !== "string") return;
  const key = urlKey(url);
  if (key) state.retrieved.add(key);
}

/** Records a page as read and collects the pages it links to, so the agent can follow where the text points. */
function noteRead(state: RunState, document: { url: string; links: { text: string; url: string }[] }) {
  const key = urlKey(document.url);
  if (key) {
    state.readKeys.add(key);
    state.linkPool.delete(key);
  }
  if (state.coverageChecks >= 1) state.readsAfterFirstCheck += 1;
  for (const link of document.links) {
    const linkKey = urlKey(link.url);
    if (linkKey && !state.readKeys.has(linkKey) && !state.linkPool.has(linkKey)) {
      state.linkPool.set(linkKey, { title: link.text, url: link.url });
    }
  }
}

/** Unread pages linked from pages already read, nearest the saved evidence first (same text or chapter). */
function pickLeads(state: RunState, limit: number) {
  const prefix = (url: string) => new URL(url).pathname.split("/").filter(Boolean).slice(0, 3).join("/");
  const noteDocs = new Set(state.notes.map((note) => prefix(note.url)));
  return [...state.linkPool.values()]
    .map((lead) => ({ lead, near: noteDocs.has(prefix(lead.url)) ? 0 : 1 }))
    .sort((a, b) => a.near - b.near)
    .slice(0, limit)
    .map(({ lead }) => ({ title: lead.title, url: lead.url }));
}

function getTools(state: RunState, depth: "standard" | "deep" | "really-deep") {
  const tools = {
    plan_research: tool({
      description:
        "Your required first action. Plan the research before searching: a descriptive report title, the sub-questions to answer, and search terms in several scripts.",
      // Limits are enforced in execute, not by the schema: a model that writes one item too many
      // should be trimmed, not fail validation and derail the run.
      inputSchema: z.object({
        reportTitle: z
          .string()
          .min(1)
          .describe('Short descriptive title (under 90 characters) that names the subject, e.g. "Dharma in the Shikshapatri". Used as the PDF filename.'),
        subQuestions: z.array(z.string().min(1)).min(1).describe("2-6 sub-questions the report must answer."),
        searchTerms: z
          .array(z.string().min(1))
          .min(1)
          .describe("Up to 20 terms in English, IAST transliteration, Devanagari, and Gujarati worth searching."),
      }),
      execute: async (input) => {
        const plan = {
          reportTitle: input.reportTitle.trim().slice(0, 90),
          subQuestions: input.subQuestions.slice(0, 8).map((q) => q.trim().slice(0, 300)),
          searchTerms: input.searchTerms.slice(0, 40).map((t) => t.trim().slice(0, 120)),
        };
        state.plan = plan;

        // Run the opening searches right here, in parallel, instead of spending several slow model
        // round trips on them: the model's next step starts with candidate pages already in hand.
        const started = Date.now();
        const budget = Math.min(BOOTSTRAP_SEARCHES, getSearchBudget(depth));
        const terms = [...new Set(plan.searchTerms)].slice(0, budget);
        state.searches += terms.length;
        const settled = await Promise.allSettled(terms.map((term) => searchVedicKnowledgeBase(term)));
        const seen = new Set<string>();
        const initialResults: { title: string; url: string; snippet: string }[] = [];
        for (const outcome of settled) {
          if (outcome.status !== "fulfilled") continue;
          addHits(state, outcome.value);
          for (const result of outcome.value) {
            remember(state, result.url);
            const key = urlKey(result.url);
            if (!key || seen.has(key) || initialResults.length >= 30) continue;
            seen.add(key);
            initialResults.push({
              title: result.title,
              url: result.url,
              snippet: normalizeScrapedText(result.snippet).slice(0, 260),
            });
          }
        }
        const failures = settled.filter((outcome) => outcome.status === "rejected") as PromiseRejectedResult[];
        failures.forEach((failure) => recordError(state, String(failure.reason?.message ?? failure.reason)));
        console.info(`[research] bootstrap ${terms.length} searches in ${Date.now() - started}ms, ${initialResults.length} pages, ${failures.length} failed`);
        return {
          planned: true,
          subQuestions: plan.subQuestions.map((text, index) => ({ id: index + 1, text })),
          searchesRun: terms.length,
          initialResults,
          note:
            initialResults.length > 0
              ? "Opening searches are done; these are candidate pages. Read the most relevant ones next with read_documents."
              : `The opening searches found nothing${failures[0] ? ` (${String(failures[0].reason?.message ?? failures[0].reason).slice(0, 200)})` : ""}. Try search_knowledge_base with simpler or transliterated terms.`,
        };
      },
    }),
    search_knowledge_base: tool({
      description:
        "Search only vedic.study for relevant pages in English, Sanskrit, or Gujarati. Returns verified same-site URLs, titles, and excerpts.",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
      execute: async ({ query: rawQuery }) => {
        if (state.readyToWrite) return { error: "Research is complete. Write the report now." };
        if (state.searches >= getSearchBudget(depth)) {
          return { error: "Search budget used up. Read pages, save notes, and call check_coverage." };
        }
        const query = rawQuery.slice(0, MAX_QUERY_LENGTH);
        state.searches += 1;
        const started = Date.now();
        try {
          const results = await searchVedicKnowledgeBase(query);
          console.info(`[research] search "${query.slice(0, 40)}" ${Date.now() - started}ms -> ${results.length}`);
          results.forEach((result) => remember(state, result.url));
          addHits(state, results);
          return {
            query,
            results: results.map((result) => ({
              ...result,
              snippet: normalizeScrapedText(result.snippet).slice(0, 1_600),
            })),
            note:
              results.length === 0
                ? "No matching same-site pages were extracted. Try a simpler or transliterated query."
                : undefined,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Search failed.";
          recordError(state, message);
          return { error: message };
        }
      },
    }),
    read_document: tool({
      description:
        "Read a source page found through search_knowledge_base or a link returned by a previous read_document. The URL must be an exact vedic.study URL. Long pages are returned in sections: use offset to continue where nextOffset left off. Also returns same-site links to follow.",
      inputSchema: z.object({
        url: z.string().min(1),
        offset: z.number().int().min(0).default(0),
      }),
      execute: async ({ url, offset }) => {
        if (state.readyToWrite) return { error: "Research is complete. Write the report now." };
        if (state.reads >= getReadBudget(depth)) {
          return { error: "Reading budget used up. Save notes for what you read and call check_coverage." };
        }
        state.reads += 1;
        try {
          const document = await readVedicDocument(url);
          remember(state, document.url);
          document.links.forEach((link) => remember(state, link.url));
          noteRead(state, document);
          const normalized = normalizeScrapedText(document.content);
          const end = offset + DOCUMENT_CHUNK_LENGTH;
          return {
            title: document.title,
            url: document.url,
            content: normalized.slice(offset, end),
            offset,
            totalLength: normalized.length,
            nextOffset: end < normalized.length ? end : null,
            links: document.links,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not read the page.";
          recordError(state, message);
          return { error: message };
        }
      },
    }),
    read_documents: tool({
      description:
        "Read up to 5 vedic.study pages at once (in parallel). Use this to read the pages you chose from search results; it is much faster than one page per step. Each page is returned up to 10,000 characters; for a long page (nextOffset is set) continue it with read_document and an offset.",
      inputSchema: z.object({
        urls: z.array(z.string().min(1)).min(1).describe("1-5 exact vedic.study URLs from search results or links."),
      }),
      execute: async ({ urls }) => {
        if (state.readyToWrite) return { error: "Research is complete. Write the report now." };
        const remaining = getReadBudget(depth) - state.reads;
        if (remaining <= 0) {
          return { error: "Reading budget used up. Save notes for what you read and call check_coverage." };
        }
        const batch = [...new Set(urls)].slice(0, Math.min(5, remaining));
        state.reads += batch.length;
        const started = Date.now();
        const documents = await Promise.all(
          batch.map(async (url) => {
            try {
              const document = await readVedicDocument(url);
              remember(state, document.url);
              document.links.forEach((link) => remember(state, link.url));
              noteRead(state, document);
              const normalized = normalizeScrapedText(document.content);
              return {
                title: document.title,
                url: document.url,
                content: normalized.slice(0, BATCH_DOCUMENT_CHARS),
                totalLength: normalized.length,
                nextOffset: normalized.length > BATCH_DOCUMENT_CHARS ? BATCH_DOCUMENT_CHARS : null,
                links: document.links.slice(0, 12),
              };
            } catch (error) {
              return { url, error: error instanceof Error ? error.message : "Could not read the page." };
            }
          }),
        );
        console.info(`[research] read_documents ${batch.length} pages in ${Date.now() - started}ms`);
        return { documents };
      },
    }),
    save_note: tool({
      description:
        "Save a finding to your research notes. Notes persist for the whole run while older tool results are compacted. Give the page URL and title exactly as a tool returned them, the number of the sub-question it answers, a precise note, and the exact quotation when relevant.",
      inputSchema: z.object({
        url: z.string().min(1),
        title: z.string().min(1),
        subQuestion: z.number().int().min(1).describe("Which planned sub-question this finding answers (1-based)."),
        note: z.string().min(1),
        quote: z.string().optional(),
      }),
      execute: async (entry) => {
        const canonical = normalizeVedicUrl(entry.url);
        if (state.plan && entry.subQuestion > state.plan.subQuestions.length) {
          return { error: `There is no sub-question ${entry.subQuestion}; the plan has ${state.plan.subQuestions.length}.` };
        }
        if (!canonical || !state.retrieved.has(urlKey(canonical)!)) {
          return {
            error:
              "That URL was not returned by a search or page read. Copy the exact URL from a tool result.",
          };
        }
        if (state.notes.length >= MAX_NOTES) {
          return { error: "The notes are full. Write the report from what is saved." };
        }
        state.notes.push({
          url: canonical,
          title: entry.title.slice(0, 300),
          subQuestion: entry.subQuestion,
          note: entry.note.slice(0, 2_000),
          quote: entry.quote?.slice(0, 2_500),
        });
        // The number is what the report cites, e.g. [3]; the system turns it into a verified link.
        return {
          saved: true,
          noteNumber: state.notes.length,
          url: canonical,
          title: entry.title.slice(0, 300),
          subQuestion: entry.subQuestion,
        };
      },
    }),
    check_coverage: tool({
      description:
        "Call when you believe the research is complete. Checks that every planned sub-question has saved notes, that you have enough well-sourced notes, and (for deep research) that you have followed the pages your sources point to. You cannot write the report until this confirms you are ready.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.plan) return { error: "Plan the research first." };
        if (state.readyToWrite) return { ready: true, message: "Coverage is already confirmed. Continue to your analysis." };
        state.coverageChecks += 1;
        const coverage = state.plan.subQuestions.map((text, index) => ({
          id: index + 1,
          text,
          notes: state.notes.filter((entry) => entry.subQuestion === index + 1).length,
        }));
        const gaps = coverage.filter((item) => item.notes === 0);
        const minNotes = minNotesFor(depth);
        const thin = state.notes.length < minNotes;
        const leads = pickLeads(state, 8);
        const leadTarget = depth === "standard" ? 0 : depth === "deep" ? 3 : 6;
        const leadsPending = state.readsAfterFirstCheck < leadTarget && leads.length > 0;
        // Out of time (or checked repeatedly): proceed with what exists; the report must say what is missing.
        const outOfTime = Date.now() - state.runStartedAt >= getTimeBudgetMs() * 0.8 || state.coverageChecks >= 4;
        state.readyToWrite = outOfTime || (gaps.length === 0 && !thin && !leadsPending);

        const problems = [
          gaps.length > 0 ? `no notes yet for Q${gaps.map((g) => g.id).join(", Q")}` : "",
          thin ? `only ${state.notes.length} notes saved; at least ${minNotes} are needed` : "",
          leadsPending ? `follow where your sources point: read at least ${leadTarget - state.readsAfterFirstCheck} more of the linked pages below` : "",
        ].filter(Boolean);
        return {
          coverage,
          notes: state.notes.length,
          ready: state.readyToWrite,
          leads,
          message: state.readyToWrite
            ? problems.length > 0
              ? `Out of time, so proceeding with gaps (${problems.join("; ")}): state them plainly under limitations. Continue to your analysis.`
              : "The evidence is sufficient. Continue to your analysis."
            : `Not ready: ${problems.join("; ")}. ${
                leads.length > 0 ? "Pages your sources link to (chapters, commentary, parallel passages) are listed under leads: read the relevant ones with read_documents. " : ""
              }Then save notes and call check_coverage again.`,
        };
      },
    }),
    analyze_evidence: tool({
      description:
        "After check_coverage confirms readiness and before writing: state your thesis, what the evidence for each sub-question shows (with the supporting note numbers), how the sources relate, the tensions you found, what is still unanswered, and an outline for the report.",
      inputSchema: z.object({
        thesis: z.string().min(1).describe("The single most important, specific answer your evidence supports."),
        findings: z
          .array(
            z.object({
              subQuestion: z.number().int().min(1),
              claim: z.string().min(1),
              reasoning: z.string().min(1).describe("Why the cited notes support the claim and what follows from it."),
              confidence: z.string().default("medium").describe('"high", "medium" or "low".'),
              noteNumbers: z.array(z.number().int()).default([]),
            }),
          )
          .min(1),
        relationships: z
          .array(
            z.object({
              kind: z.string().min(1).describe("agrees, qualifies, contradicts, develops, or a short label of your own."),
              description: z.string().min(1),
              noteNumbers: z.array(z.number().int()).default([]),
            }),
          )
          .default([]),
        tensions: z.array(z.string()).default([]),
        gaps: z.array(z.string()).default([]),
        outline: z.array(z.string()).default([]).describe("Headings of the report, in order."),
      }),
      execute: async (input) => {
        if (!state.readyToWrite) return { error: "Finish the research and call check_coverage before analysing." };
        state.analysisAttempts += 1;
        const cited = [...input.findings.flatMap((f) => f.noteNumbers), ...input.relationships.flatMap((r) => r.noteNumbers)];
        const missing = [...new Set(cited.filter((n) => n < 1 || n > state.notes.length))];
        if (missing.length > 0 && state.analysisAttempts < 3) {
          return { error: `Note numbers ${missing.join(", ")} do not exist (there are ${state.notes.length} notes). Cite only saved notes.` };
        }
        const valid = (numbers: number[]) => numbers.filter((n) => n >= 1 && n <= state.notes.length);
        state.analysis = {
          thesis: input.thesis.slice(0, 1_200),
          findings: input.findings.slice(0, 12).map((f) => ({
            subQuestion: f.subQuestion,
            claim: f.claim.slice(0, 700),
            reasoning: f.reasoning.slice(0, 1_000),
            confidence: f.confidence.slice(0, 20),
            noteNumbers: valid(f.noteNumbers),
          })),
          relationships: input.relationships.slice(0, 12).map((r) => ({
            kind: r.kind.slice(0, 40),
            description: r.description.slice(0, 700),
            noteNumbers: valid(r.noteNumbers),
          })),
          tensions: input.tensions.slice(0, 8).map((t) => t.slice(0, 500)),
          gaps: input.gaps.slice(0, 8).map((g) => g.slice(0, 400)),
          outline: input.outline.slice(0, 14).map((o) => o.slice(0, 120)),
        };
        return { analysed: true, findings: state.analysis.findings.length, tensions: state.analysis.tensions.length };
      },
    }),
    submit_report: tool({
      description:
        "Deliver the finished report. Pass the complete report as Markdown. The report is checked before it is accepted: if it is too thin, opens with process talk, cites notes that do not exist, or ignores your evidence, it is rejected with the reasons and you must fix it and submit again (or research more if told to).",
      inputSchema: z.object({
        markdown: z
          .string()
          .min(1)
          .describe("The complete report in Markdown: no preamble, no process talk, no sources list; begin with the bottom line."),
      }),
      execute: async ({ markdown }) => {
        if (!state.readyToWrite && !state.finalizing) {
          return { error: "Research is not complete yet. Continue researching and call check_coverage first." };
        }
        state.reportAttempts += 1;
        const result = checkReport({
          markdown,
          depth,
          noteCount: state.notes.length,
          noteSubQuestions: state.notes.map((note) => note.subQuestion),
          subQuestionCount: state.plan?.subQuestions.length ?? 0,
          relaxed: state.finalizing,
        });
        // Late in the run there is no time for another rewrite: deliver what exists, with its issues noted.
        const late = Date.now() - state.runStartedAt > getTimeBudgetMs();
        const final = state.finalizing || late || state.reportAttempts >= 4;
        const wordCount = markdown.trim().split(/\s+/).filter(Boolean).length;
        if (final && wordCount < 150) {
          // Not a report at all: deliver the digest compiled from the notes instead of this.
          state.abandon = true;
          return { error: "The report was unusable, so a digest compiled from the saved notes will be delivered instead." };
        }
        if (result.evidence.length > 0 && !final) {
          // The evidence is not good enough to write from: go back to the sources.
          state.readyToWrite = false;
          state.analysis = undefined;
          state.analysisAttempts = 0;
          console.info(`[research] report rejected (evidence): ${result.evidence.join("; ")}`);
          return {
            error: `Rejected: ${result.evidence.join("; ")}. Go back and research more: read further pages (follow the links in pages you read), save more notes, then call check_coverage, analyze_evidence, and submit the report again.`,
          };
        }
        if (result.style.length > 0 && !final) {
          console.info(`[research] report rejected (style): ${result.style.join("; ")}`);
          return { error: `Rejected: ${result.style.join("; ")}. Rewrite the whole report fixing these and call submit_report again.` };
        }
        state.accepted = true;
        state.qualityIssues = [...result.style, ...result.evidence];
        console.info(`[research] report accepted after ${state.reportAttempts} attempt(s), ${state.qualityIssues.length} issues`);
        return { accepted: true, issues: state.qualityIssues };
      },
    }),
    create_diagram: tool({
      description:
        "Build one diagram of relationships that the retrieved pages explicitly state. Returns an id; place [[diagram:ID]] in the report. Every relationship must cite a retrieved page.",
      inputSchema: z.object({
        title: z.string().min(1),
        direction: z.string().default("TD").describe('"TD" (top-down) or "LR" (left-right).'),
        nodes: z.array(z.object({ id: z.string(), label: z.string().min(1) })).min(1).describe("2-14 concepts."),
        edges: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              label: z.string().optional(),
              sourceUrl: z.string().min(1).describe("The retrieved page that states this relationship."),
            }),
          )
          .min(1)
          .describe("1-24 relationships."),
      }),
      execute: async (input) => {
        if (!state.readyToWrite) return { error: "Finish the research and call check_coverage before drawing diagrams." };
        if (state.diagrams.length >= MAX_DIAGRAMS) {
          return { error: `At most ${MAX_DIAGRAMS} diagrams per report.` };
        }
        state.diagramAttempts += 1;
        const result = buildDiagram(
          { ...input, title: input.title.slice(0, 120), direction: input.direction === "LR" ? "LR" : "TD" },
          state.retrieved,
          `D${state.diagrams.length + 1}`,
        );
        if ("error" in result) return { error: result.error };
        state.diagrams.push(result.diagram);
        return { ...result.diagram, usage: `Place the line [[diagram:${result.diagram.id}]] in the report.` };
      },
    }),
  };
  return tools;
}

export async function POST(request: NextRequest) {
  if (!process.env.MISTRAL_API_KEY) {
    return NextResponse.json(
      { error: "Set MISTRAL_API_KEY in the server environment to run research." },
      { status: 503 },
    );
  }
  if (!(await hasVedicAccess())) {
    return NextResponse.json(
      { error: "No saved vedic.study session. Run `npm run login` once in the project folder, then try again." },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "The request needs a message, valid research depth, and output language." },
      { status: 400 },
    );
  }

  prewarmScraper();
  const allMessages = parsed.data.messages as UIMessage[];
  const isContinue = (message: UIMessage) =>
    message.role === "user" && message.parts.some((part) => part.type === "text" && part.text === CONTINUE_SENTINEL);
  // The model sees the conversation up to the real question. A run's earlier segments are not replayed:
  // their plan, notes and analysis come back through the saved state and the notes in the system prompt.
  let lastReal = -1;
  allMessages.forEach((message, index) => {
    if (message.role === "user" && !isContinue(message)) lastReal = index;
  });
  if (lastReal < 0) return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  const messages = allMessages.slice(0, lastReal + 1);

  const depth = parsed.data.depth;
  const ceiling = getStepCeiling(depth);
  const segmentStart = Date.now();
  const deliverables = parsed.data.deliverables;

  const requestedRun = parsed.data.runId && isValidRunId(parsed.data.runId) ? parsed.data.runId : undefined;
  const saved = parsed.data.resume && requestedRun ? await loadRun<SavedRun>(requestedRun) : undefined;
  const runId = saved ? requestedRun! : newRunId();
  const state = saved ? hydrateState(saved) : freshState(segmentStart);
  if (saved) state.segments += 1;
  const progressAtStart = progressOf(state);
  console.info(`[research] ${saved ? `resuming ${runId} (segment ${state.segments})` : `new run ${runId}`}`);

  const baseSystem = buildSystemPrompt(parsed.data.language, depth, deliverables);
  const modelName = process.env.MISTRAL_MODEL || DEFAULT_MODEL;

  try {
    const modelMessages = await convertToModelMessages(stripOldToolParts(messages));
    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort());

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: "data-run", data: { runId } });

        // The safety net: if the run cannot continue, the reader still gets a report compiled from the
        // saved notes (and so a PDF), never a blank screen.
        const deliverFallback = (reason: string) => {
          if (state.accepted || state.fallbackSent) return;
          state.fallbackSent = true;
          const fallback = compileFallbackReport({
            plan: state.plan,
            notes: state.notes,
            hits: state.hits,
            analysis: state.analysis,
            errors: state.errors,
            reason,
          });
          console.info(`[research] fallback report delivered: ${reason}`);
          writer.write({ type: "data-report", data: fallback });
        };

        // A function killed at its time limit sends nothing at all, so end the segment a little earlier.
        // This is not a failure: the state is saved and the app continues the run in a new request.
        const watchdog = Number.isFinite(SEGMENT_HARD_MS)
          ? setTimeout(() => {
              state.segmentOver = true;
              controller.abort();
            }, SEGMENT_HARD_MS)
          : undefined;

        try {
          const result = streamText({
            model: mistral(modelName),
            system: baseSystem,
            messages: modelMessages,
            tools: getTools(state, depth),
            stopWhen: [stepCountIs(ceiling), () => state.accepted || state.abandon || state.segmentOver],
            maxOutputTokens: 16_000,
            // Low-cost API tiers rate-limit; retry with backoff instead of failing a long run.
            maxRetries: 6,
            abortSignal: controller.signal,
            onStepFinish: (step) => {
              const calls = step.toolCalls.map((call) => call.toolName).join(",") || "text";
              const elapsed = Date.now() - segmentStart;
              console.info(
                `[research] seg${state.segments} ${Math.round(elapsed / 1000)}s tools=${calls} tokens=${step.usage.totalTokens}`,
              );
              // End the segment at a step boundary once its time is used: research stops early enough to
              // save state, and the writing phase only starts when there is room to finish it.
              if (!state.accepted && !state.abandon) {
                const writing = state.readyToWrite || state.finalizing;
                if (writing ? elapsed > SEGMENT_WRITE_START_MS : elapsed > SEGMENT_RESEARCH_MS) state.segmentOver = true;
              }
            },
            prepareStep: ({ stepNumber, messages: stepMessages }) => {
              const { note, finalize } = getStepGuidance(
                depth,
                stepNumber,
                Date.now() - state.runStartedAt,
                ceiling,
                getTimeBudgetMs(),
              );
              const steer = [note, progressNote(state, depth)].filter(Boolean).join("\n");
              const system = `${baseSystem}${formatLedger(state)}${steer ? `\n\n${steer}` : ""}`;
              const stepMessagesCompact = compactToolResults(stepMessages);

              // Tools stay defined at every step (a model that emits a call to a "removed" tool crashes
              // the run); steering is by toolChoice, and each tool guards itself against misuse.
              // Think first: the very first action is the research plan.
              if (!state.plan && !finalize) {
                return { system, messages: stepMessagesCompact, toolChoice: { type: "tool" as const, toolName: "plan_research" as const } };
              }
              if (state.accepted) return { system, messages: stepMessagesCompact, toolChoice: "none" as const };
              // The run's overall guard was reached: deliver the best honest report from what exists.
              if (finalize) {
                state.finalizing = true;
                return { system, messages: stepMessagesCompact, toolChoice: { type: "tool" as const, toolName: "submit_report" as const } };
              }
              // Coverage confirmed: analyse, draw grounded diagrams, then submit the report.
              if (state.readyToWrite) {
                if (!state.analysis && state.analysisAttempts < 3) {
                  return { system, messages: stepMessagesCompact, toolChoice: { type: "tool" as const, toolName: "analyze_evidence" as const } };
                }
                if (deliverables.diagrams && state.diagrams.length === 0 && state.diagramAttempts < 3) {
                  return { system, messages: stepMessagesCompact, toolChoice: { type: "tool" as const, toolName: "create_diagram" as const } };
                }
                return { system, messages: stepMessagesCompact, toolChoice: { type: "tool" as const, toolName: "submit_report" as const } };
              }
              // Still researching: the model must keep using tools until check_coverage clears it.
              return { system, messages: stepMessagesCompact, toolChoice: "required" as const };
            },
          });

          // Provider hiccups must not blank the screen: drop stream errors (they are logged and handled
          // below) instead of forwarding them to the client.
          writer.merge(
            result
              .toUIMessageStream({
                onError: (error) => {
                  console.error("Research stream error:", error);
                  return "error";
                },
              })
              .pipeThrough(
                new TransformStream({
                  transform(chunk, streamController) {
                    if (chunk.type === "error") {
                      recordError(state, "The model provider reported an error.");
                      return;
                    }
                    streamController.enqueue(chunk);
                  },
                }),
              ),
          );
          await result.steps.catch(() => undefined);
        } catch (error) {
          console.error("Research run failed:", error);
          recordError(state, error instanceof Error ? error.message : "The research run failed.");
        } finally {
          if (watchdog) clearTimeout(watchdog);
        }

        // Decide what happens next: finished, continue in a new request, or give up with the fallback.
        // The client may have disconnected (a sleeping phone): the state is still saved so the run can be resumed.
        try {
          if (state.accepted) {
            await deleteRun(runId);
            return;
          }
          if (state.abandon) {
            await deleteRun(runId);
            deliverFallback("the report could not be written to the required standard");
            return;
          }
          const overBudget = Date.now() - state.runStartedAt > getTimeBudgetMs() * 1.15;
          const stalled = progressOf(state) === progressAtStart;
          state.stalls = stalled ? state.stalls + 1 : 0;
          if (state.segments >= MAX_SEGMENTS || overBudget || state.stalls >= 3) {
            await deleteRun(runId);
            deliverFallback(
              state.notes.length > 0
                ? "the run could not be completed within its limits"
                : "the run ended before any evidence could be gathered",
            );
            return;
          }
          state.segmentOver = false;
          await saveRun(runId, serializeState(state));
          writer.write({ type: "data-continue", data: { runId, segment: state.segments } });
        } catch (error) {
          console.error("Could not finish the segment cleanly:", error);
          await saveRun(runId, serializeState(state)).catch(() => undefined);
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    console.error("Unable to start research:", error);
    return NextResponse.json(
      { error: "Could not start the research run. Check the server configuration." },
      { status: 500 },
    );
  }
}
