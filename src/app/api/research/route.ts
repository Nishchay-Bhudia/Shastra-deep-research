import { mistral } from "@/lib/mistral";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
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
import { buildDiagram, type BuiltDiagram } from "@/lib/research/diagram";
import { normalizeVedicUrl, urlKey } from "@/lib/vedic-url";
import {
  hasVedicAccess,
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
});

const MAX_QUERY_LENGTH = 2_000;
const DOCUMENT_CHUNK_LENGTH = 22_000;
const BATCH_DOCUMENT_CHARS = 10_000;
const MAX_NOTES = 300;
const MAX_LEDGER_CHARS = 60_000;
const MAX_DIAGRAMS = 3;
const BOOTSTRAP_SEARCHES = 6;

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
  return messages.map((message, index) =>
    index === lastIndex
      ? message
      : { ...message, parts: message.parts.filter((part) => !part.type.startsWith("tool-")) },
  );
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

function remember(state: RunState, url: unknown) {
  if (typeof url !== "string") return;
  const key = urlKey(url);
  if (key) state.retrieved.add(key);
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
          return { error: error instanceof Error ? error.message : "Search failed." };
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
          return { error: error instanceof Error ? error.message : "Could not read the page." };
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
        "Call when you believe the research is complete. Reports which planned sub-questions still have no saved notes. You cannot write the report until this confirms you are ready.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!state.plan) return { error: "Plan the research first." };
        if (state.readyToWrite) return { ready: true, message: "Coverage is already confirmed. Write the report now." };
        state.coverageChecks += 1;
        const coverage = state.plan.subQuestions.map((text, index) => ({
          id: index + 1,
          text,
          notes: state.notes.filter((entry) => entry.subQuestion === index + 1).length,
        }));
        const gaps = coverage.filter((item) => item.notes === 0);
        // A second check accepts remaining gaps, which the report must then state honestly.
        state.readyToWrite = gaps.length === 0 || state.coverageChecks >= 2;
        return {
          coverage,
          ready: state.readyToWrite,
          message: state.readyToWrite
            ? gaps.length === 0
              ? "Every sub-question has evidence. You may now write the report."
              : `Proceeding with gaps in Q${gaps.map((g) => g.id).join(", Q")}: state them plainly under limitations. You may now write the report.`
            : `No notes yet for Q${gaps.map((g) => g.id).join(", Q")}. Research them (or call check_coverage again to accept the gap), then continue.`,
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

  const messages = parsed.data.messages as UIMessage[];
  const depth = parsed.data.depth;
  const ceiling = getStepCeiling(depth);
  const startedAt = Date.now();
  const deliverables = parsed.data.deliverables;
  const state: RunState = {
    notes: [],
    retrieved: new Set(),
    diagrams: [],
    coverageChecks: 0,
    readyToWrite: false,
    searches: 0,
    reads: 0,
    diagramAttempts: 0,
    analysisAttempts: 0,
  };
  const baseSystem = buildSystemPrompt(parsed.data.language, depth, deliverables);
  const modelName = process.env.MISTRAL_MODEL || DEFAULT_MODEL;

  try {
    const result = streamText({
      model: mistral(modelName),
      system: baseSystem,
      messages: await convertToModelMessages(stripOldToolParts(messages)),
      tools: getTools(state, depth),
      stopWhen: stepCountIs(ceiling),
      maxOutputTokens: 16_000,
      // Low-cost API tiers rate-limit; retry with backoff instead of failing a long run.
      maxRetries: 6,
      abortSignal: request.signal,
      onStepFinish: (step) => {
        const calls = step.toolCalls.map((call) => call.toolName).join(",") || "text";
        console.info(
          `[research] ${Math.round((Date.now() - startedAt) / 1000)}s step ${step.response.messages.length ? "done" : ""} tools=${calls} tokens=${step.usage.totalTokens}`,
        );
      },
      prepareStep: ({ stepNumber, messages: stepMessages }) => {
        const { note, finalize } = getStepGuidance(
          depth,
          stepNumber,
          Date.now() - startedAt,
          ceiling,
          getTimeBudgetMs(),
        );
        const steer = [note, progressNote(state, depth)].filter(Boolean).join("\n");
        const system = `${baseSystem}${formatLedger(state)}${steer ? `\n\n${steer}` : ""}`;
        const messages = compactToolResults(stepMessages);

        // Tools stay defined at every step (a model that emits a call to a "removed" tool crashes the
        // run); steering is by toolChoice, and each tool guards itself against being used out of turn.
        // Think first: the very first action is the research plan.
        if (!state.plan && !finalize) {
          return { system, messages, toolChoice: { type: "tool" as const, toolName: "plan_research" as const } };
        }
        // Out of budget: write the report now.
        if (finalize) return { system, messages, toolChoice: "none" as const };
        // Coverage confirmed: optionally draw grounded diagrams, then write.
        if (state.readyToWrite) {
          // Reason over the evidence before writing (a few tries if the first is rejected).
          if (!state.analysis && state.analysisAttempts < 3) {
            return { system, messages, toolChoice: { type: "tool" as const, toolName: "analyze_evidence" as const } };
          }
          const canDraw = deliverables.diagrams && state.diagrams.length < MAX_DIAGRAMS;
          if (!canDraw) return { system, messages, toolChoice: "none" as const };
          // The reader asked for diagrams: make sure at least one real one exists (a few tries if the
          // first is rejected for citing a page that was never retrieved), then let the model write.
          if (state.diagrams.length === 0 && state.diagramAttempts < 3) {
            return { system, messages, toolChoice: { type: "tool" as const, toolName: "create_diagram" as const } };
          }
          return { system, messages };
        }
        // Still researching: the model must keep using tools until check_coverage clears it.
        return { system, messages, toolChoice: "required" as const };
      },
    });

    return result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error("Research stream error:", error);
        return "The research stream encountered an error. Check the server logs and try again.";
      },
    });
  } catch (error) {
    console.error("Unable to start research:", error);
    return NextResponse.json(
      { error: "Could not start the research run. Check the server configuration." },
      { status: 500 },
    );
  }
}
