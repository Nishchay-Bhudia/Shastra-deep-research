import type { ModelMessage } from "ai";

const KEEP_RECENT_MESSAGES = 10;
const STUB_CHARS = 300;

type ToolResultLike = {
  type: "tool-result";
  toolName?: string;
  output?: { type?: string; value?: unknown };
  [key: string]: unknown;
};

function compactValue(toolName: string | undefined, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const data = value as Record<string, unknown>;
  if (toolName === "read_document" && typeof data.content === "string") {
    return {
      title: data.title,
      url: data.url,
      offset: data.offset,
      nextOffset: data.nextOffset,
      content: `${data.content.slice(0, STUB_CHARS)} […older page text removed to save space; re-read the URL if needed]`,
    };
  }
  if (toolName === "search_knowledge_base" && Array.isArray(data.results)) {
    return {
      query: data.query,
      results: data.results.map((item) => {
        const result = item as { title?: string; url?: string };
        return { title: result.title, url: result.url };
      }),
    };
  }
  return value;
}

/**
 * Long research runs would otherwise carry every page ever read. Tool results
 * older than the most recent messages are shrunk to titles and URLs; what the
 * agent needs to keep lives in its saved notes.
 */
export function compactToolResults(
  messages: ModelMessage[],
  keepRecent = KEEP_RECENT_MESSAGES,
): ModelMessage[] {
  const cutoff = messages.length - keepRecent;
  return messages.map((message, index) => {
    if (index >= cutoff || message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    const content = message.content.map((part) => {
      const result = part as unknown as ToolResultLike;
      if (result.type !== "tool-result" || result.output?.type !== "json") return part;
      return {
        ...result,
        output: { type: "json", value: compactValue(result.toolName, result.output.value) },
      } as unknown as typeof part;
    });
    return { ...message, content } as ModelMessage;
  });
}
