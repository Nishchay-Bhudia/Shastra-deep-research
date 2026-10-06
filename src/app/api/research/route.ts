import { anthropic } from "@ai-sdk/anthropic";
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
  readVedicDocument,
  searchVedicKnowledgeBase,
} from "@/lib/scraper/browser";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  messages: z.array(z.unknown()).min(1).max(30),
  depth: z.enum(["standard", "deep", "really-deep"]).default("standard"),
  language: z.enum(["English", "Gujarati"]).default("English"),
});

const MAX_QUERY_LENGTH = 2_000;
const MAX_DOCUMENT_LENGTH = 22_000;

function getMaxSteps(depth: "standard" | "deep" | "really-deep") {
  if (depth === "deep") return 15;
  if (depth === "really-deep") return 30;
  return 5;
}

function buildSystemPrompt(language: "English" | "Gujarati") {
  return `You are Shastra, a careful Vedic research assistant. Write the final research response in ${language}.

SOURCE BOUNDARY
- Treat retrieved material from vedic.study as the only evidence for factual claims about the texts.
- Never fill gaps from prior knowledge. If the site did not provide evidence, say so plainly.
- Search the knowledge base before making substantive claims. Read source pages before relying on them.
- Cite each substantive factual claim with a Markdown link using the exact title and URL returned by a tool. Never invent a citation, URL, quotation, verse, translation, or attribution.
- Use direct Sanskrit or Gujarati quotations only when the exact text was retrieved. Preserve the original script and clearly distinguish a source translation from your own explanation.
- Tell the reader when the available pages do not establish a conclusion or when interpretations conflict.

RESEARCH METHOD
- Begin with broad searches that cover the user's question and its key terms; use additional targeted searches to close important gaps.
- For comparative questions, search each named text or tradition and report differences without flattening them into one view.
- Structure substantial reports with an executive summary, source-grounded analysis, limitations, and a short source list.
- For complex conceptual relationships, include a Mermaid diagram in a fenced \`mermaid\` block. Label it as a synthesis of the cited sources, not as a quotation.
- Keep source excerpts and tool results private from the report unless quoting or summarizing them with citations.`;
}

function getTools() {
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
        "Read a full source page found through search_knowledge_base. The URL must be an exact vedic.study URL returned by search.",
      inputSchema: z.object({
        url: z.string().url(),
      }),
      execute: async ({ url }) => {
        try {
          const document = await readVedicDocument(url);
          return {
            title: document.title,
            url: document.url,
            content: normalizeScrapedText(document.content).slice(0, MAX_DOCUMENT_LENGTH),
            truncated: document.content.length > MAX_DOCUMENT_LENGTH,
          };
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Could not read the page." };
        }
      },
    }),
  };
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Set ANTHROPIC_API_KEY in the server environment to run research." },
      { status: 503 },
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
  const maxSteps = getMaxSteps(parsed.data.depth);
  const baseSystem = buildSystemPrompt(parsed.data.language);
  const modelName = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

  try {
    const result = streamText({
      model: anthropic(modelName),
      system: baseSystem,
      messages: await convertToModelMessages(messages),
      tools: getTools(),
      stopWhen: stepCountIs(maxSteps),
      maxOutputTokens: 12_000,
      prepareStep: ({ stepNumber }) => {
        const completedSteps = stepNumber + 1;
        let checkpoint = "";

        if (parsed.data.depth === "deep" && completedSteps === 5) {
          checkpoint =
            "The initial search phase is complete. Search specifically for alternative interpretations, commentary, or textual context before synthesizing.";
        } else if (parsed.data.depth === "really-deep" && completedSteps === 10) {
          checkpoint =
            "Move beyond broad coverage: look for textual chronology, commentary, and differing interpretations in additional sources.";
        } else if (parsed.data.depth === "really-deep" && completedSteps === 20) {
          checkpoint =
            "Check whether the evidence covers each important part of the question. Search for counterexamples or conflicting accounts before drawing conclusions.";
        } else if (
          parsed.data.depth === "really-deep" &&
          completedSteps === 27
        ) {
          checkpoint =
            "Stop expanding the search and synthesize the retrieved evidence now. Cite every substantive factual claim and state remaining gaps.";
        }

        return checkpoint ? { system: `${baseSystem}\n\n${checkpoint}` } : undefined;
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
