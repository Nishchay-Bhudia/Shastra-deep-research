import { mistral } from "@ai-sdk/mistral";
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
import {
  hasVedicAccess,
  isAllowedVedicUrl,
  readVedicDocument,
  searchVedicKnowledgeBase,
} from "@/lib/scraper/browser";

export const runtime = "nodejs";
export const maxDuration = 800;

const requestSchema = z.object({
  messages: z.array(z.unknown()).min(1).max(30),
  depth: z.enum(["standard", "deep", "really-deep"]).default("standard"),
  language: z.enum(["English", "Gujarati"]).default("English"),
});

const MAX_QUERY_LENGTH = 2_000;
const DOCUMENT_CHUNK_LENGTH = 22_000;
const MAX_NOTES = 300;
const MAX_LEDGER_CHARS = 60_000;

type Note = { url: string; title: string; note: string; quote?: string };

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

function formatLedger(notes: Note[]): string {
  if (notes.length === 0) return "";
  const text = notes
    .map(
      (entry, index) =>
        `${index + 1}. [${entry.title}](${entry.url}) — ${entry.note}${
          entry.quote ? ` Quote: "${entry.quote}"` : ""
        }\n`,
    )
    .join("");
  // Keep the most recent notes if the ledger outgrows its budget.
  const trimmed = text.length > MAX_LEDGER_CHARS ? text.slice(-MAX_LEDGER_CHARS) : text;
  return `\n\nRESEARCH NOTES SAVED SO FAR (your evidence; cite these URLs):\n${trimmed}`;
}

function getTools(notes: Note[]) {
  return {
    search_knowledge_base: tool({
      description:
        "Search only vedic.study for relevant pages in English, Sanskrit, or Gujarati. Returns verified same-site URLs, titles, and excerpts.",
      inputSchema: z.object({
        query: z.string().min(1).max(MAX_QUERY_LENGTH),
      }),
      execute: async ({ query }) => {
        try {
          const results = await searchVedicKnowledgeBase(query);
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
        url: z.string().url(),
        offset: z.number().int().min(0).default(0),
      }),
      execute: async ({ url, offset }) => {
        try {
          const document = await readVedicDocument(url);
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
    save_note: tool({
      description:
        "Save a finding to your research notes. Notes persist for the whole run while older tool results are compacted. Record the page URL and title exactly as returned by a tool, a precise note, and the exact quotation when relevant.",
      inputSchema: z.object({
        url: z.string().url(),
        title: z.string().min(1).max(300),
        note: z.string().min(1).max(1_500),
        quote: z.string().max(1_500).optional(),
      }),
      execute: async (entry) => {
        if (!isAllowedVedicUrl(entry.url)) {
          return { error: "Notes must cite a vedic.study page you retrieved." };
        }
        if (notes.length >= MAX_NOTES) {
          return { error: "The notes are full. Write the report from what is saved." };
        }
        notes.push(entry);
        return { saved: true, totalNotes: notes.length };
      },
    }),
  };
}

export async function POST(request: NextRequest) {
  if (!process.env.MISTRAL_API_KEY) {
    return NextResponse.json(
      { error: "Set MISTRAL_API_KEY in the server environment to run research." },
      { status: 503 },
    );
  }
  if (!hasVedicAccess()) {
    return NextResponse.json(
      { error: "Connect your vedic.study account first.", code: "vedic_not_connected" },
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
  const notes: Note[] = [];
  const baseSystem = buildSystemPrompt(parsed.data.language, depth);
  const modelName = process.env.MISTRAL_MODEL || DEFAULT_MODEL;

  try {
    const result = streamText({
      model: mistral(modelName),
      system: baseSystem,
      messages: await convertToModelMessages(stripOldToolParts(messages)),
      tools: getTools(notes),
      stopWhen: stepCountIs(ceiling),
      maxOutputTokens: 16_000,
      abortSignal: request.signal,
      prepareStep: ({ stepNumber, messages: stepMessages }) => {
        const { note, finalize } = getStepGuidance(
          depth,
          stepNumber,
          Date.now() - startedAt,
          ceiling,
          getTimeBudgetMs(),
        );
        return {
          system: `${baseSystem}${formatLedger(notes)}${note ? `\n\n${note}` : ""}`,
          messages: compactToolResults(stepMessages),
          ...(finalize ? { activeTools: [] } : {}),
        };
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
