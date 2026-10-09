import type { BuiltDiagram } from "./diagram";
import type { SourceMap } from "./report";
import { normalizeVedicUrl, urlKey } from "@/lib/vedic-url";

type Part = { type: string; state?: string; text?: string; input?: unknown; output?: unknown };
export type MessageLike = { id: string; role: string; parts?: Part[] };

export type Plan = { reportTitle: string; subQuestions: string[] };

export type Analysis = {
  /** The report text: only what the model wrote after its last tool call. */
  text: string;
  plan?: Plan;
  sources: SourceMap;
  notes: Map<number, { url: string; title: string }>;
  diagrams: BuiltDiagram[];
  counts: { searches: number; reads: number; notes: number };
  /** Label for the tool call still in flight, if any. */
  activity?: string;
  /** Why the delivered report fell short of the quality bar, if it did (e.g. the run ran out of time). */
  qualityIssues: string[];
  /** A report (accepted or compiled by the server) exists: nothing more will happen for this question. */
  finished: boolean;
  /** Set when the server saved the run to continue it in another request; the app resumes it. */
  continueRunId?: string;
};

const ACTIVITY: Record<string, string> = {
  plan_research: "Planning the research",
  search_knowledge_base: "Searching vedic.study",
  read_document: "Reading a source",
  read_documents: "Reading a source",
  save_note: "Taking notes",
  check_coverage: "Checking coverage",
  analyze_evidence: "Analysing the evidence",
  create_diagram: "Drawing a diagram",
  submit_report: "Writing the report",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads what a research run produced out of a chat message's parts. */
export function analyzeMessage(message: MessageLike): Analysis {
  const parts = message.parts ?? [];
  const sources: SourceMap = new Map();
  const notes = new Map<number, { url: string; title: string }>();
  const diagrams: BuiltDiagram[] = [];
  const counts = { searches: 0, reads: 0, notes: 0 };
  let plan: Plan | undefined;
  let activity: string | undefined;
  let reportMarkdown: string | undefined;
  let reportAccepted = false;
  let qualityIssues: string[] = [];
  let continueRunId: string | undefined;
  let fallbackMarkdown: string | undefined;
  let fallbackIssues: string[] = [];

  const addSource = (url: unknown, title: unknown, overwrite = false) => {
    if (typeof url !== "string") return;
    const key = urlKey(url);
    const canonical = normalizeVedicUrl(url);
    if (!key || !canonical) return;
    const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : canonical;
    if (overwrite || !sources.has(key)) sources.set(key, { url: canonical, title: name });
  };

  let lastToolIndex = -1;
  parts.forEach((part, index) => {
    if (part.type === "data-continue") {
      const data = (part as unknown as { data?: { runId?: unknown } }).data;
      if (data && typeof data.runId === "string") continueRunId = data.runId;
      return;
    }
    if (part.type === "data-report" && isObject((part as { data?: unknown }).data)) {
      // Compiled by the server from the saved notes when no normal report could be delivered.
      const data = (part as unknown as { data: Record<string, unknown> }).data;
      if (typeof data.markdown === "string") fallbackMarkdown = data.markdown;
      if (Array.isArray(data.issues)) fallbackIssues = data.issues.filter((i): i is string => typeof i === "string");
      return;
    }
    if (!part.type.startsWith("tool-")) return;
    lastToolIndex = index;
    const name = part.type.slice("tool-".length);
    const done = part.state === "output-available" || part.state === "output-error";
    if (!done) activity = ACTIVITY[name] ?? "Researching";

    if (name === "plan_research" && isObject(part.input)) {
      const input = part.input;
      if (typeof input.reportTitle === "string" && Array.isArray(input.subQuestions)) {
        plan = {
          reportTitle: input.reportTitle,
          subQuestions: input.subQuestions.filter((q): q is string => typeof q === "string"),
        };
      }
    }
    if (name === "submit_report" && isObject(part.input) && typeof part.input.markdown === "string") {
      // Rejected submissions are drafts that the agent rewrites; only an accepted one is the report.
      const accepted = part.state === "output-available" && isObject(part.output) && part.output.accepted === true;
      if (accepted) {
        reportMarkdown = part.input.markdown;
        reportAccepted = true;
        qualityIssues = Array.isArray((part.output as Record<string, unknown>).issues)
          ? ((part.output as { issues: unknown[] }).issues.filter((i): i is string => typeof i === "string"))
          : [];
      } else if (!reportAccepted && (part.state === "input-streaming" || part.state === "input-available")) {
        reportMarkdown = part.input.markdown; // being written right now
      }
    }
    if (part.state !== "output-available" || !isObject(part.output) || "error" in part.output) return;
    const output = part.output;

    if (name === "plan_research") {
      if (typeof output.searchesRun === "number") counts.searches += output.searchesRun;
      if (Array.isArray(output.initialResults)) {
        for (const result of output.initialResults) {
          if (isObject(result)) addSource(result.url, result.title, true);
        }
      }
    } else if (name === "read_documents" && Array.isArray(output.documents)) {
      for (const doc of output.documents) {
        if (!isObject(doc) || "error" in doc) continue;
        counts.reads += 1;
        if (Array.isArray(doc.links)) {
          for (const link of doc.links) if (isObject(link)) addSource(link.url, link.text);
        }
        addSource(doc.url, doc.title, true);
      }
    } else if (name === "search_knowledge_base") {
      counts.searches += 1;
      if (Array.isArray(output.results)) {
        for (const result of output.results) {
          if (isObject(result)) addSource(result.url, result.title, true);
        }
      }
    } else if (name === "read_document") {
      counts.reads += 1;
      if (Array.isArray(output.links)) {
        for (const link of output.links) if (isObject(link)) addSource(link.url, link.text);
      }
      addSource(output.url, output.title, true);
    } else if (name === "save_note" && output.saved === true) {
      counts.notes += 1;
      addSource(output.url, output.title);
      if (typeof output.noteNumber === "number" && typeof output.url === "string") {
        notes.set(output.noteNumber, {
          url: output.url,
          title: typeof output.title === "string" ? output.title : output.url,
        });
      }
    } else if (name === "create_diagram" && typeof output.mermaid === "string" && typeof output.id === "string") {
      diagrams.push({
        id: output.id,
        title: typeof output.title === "string" ? output.title : "Diagram",
        mermaid: output.mermaid,
        sources: Array.isArray(output.sources) ? output.sources.filter((s): s is string => typeof s === "string") : [],
      });
    }
  });

  // Older chats (before reports were delivered through submit_report) kept the report as plain text.
  const legacyText = parts
    .slice(lastToolIndex + 1)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");

  // An accepted report wins; then a server-compiled fallback; then (older chats) plain text.
  const delivered = reportAccepted ? reportMarkdown : undefined;
  const text =
    delivered ??
    fallbackMarkdown ??
    reportMarkdown ??
    (parts.some((part) => part.type === "tool-submit_report") ? "" : legacyText);
  if (!delivered && fallbackMarkdown) qualityIssues = fallbackIssues;
  const finished = reportAccepted || fallbackMarkdown !== undefined;
  return { text, plan, sources, notes, diagrams, counts, activity, qualityIssues, finished, continueRunId: finished ? undefined : continueRunId };
}
