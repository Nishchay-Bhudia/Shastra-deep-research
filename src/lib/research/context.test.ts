import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactToolResults } from "./context";

function toolMessage(toolName: string, value: unknown): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "1", toolName, output: { type: "json", value } }],
  } as ModelMessage;
}

const big = "x".repeat(5_000);

describe("compactToolResults", () => {
  it("shrinks old page reads but keeps title and url", () => {
    const old = toolMessage("read_document", { title: "T", url: "https://www.vedic.study/a", content: big });
    const recent = toolMessage("read_document", { title: "R", url: "https://www.vedic.study/b", content: big });
    const [first, last] = compactToolResults([old, recent], 1);
    const firstValue = (first as any).content[0].output.value;
    expect(firstValue.url).toBe("https://www.vedic.study/a");
    expect(firstValue.content.length).toBeLessThan(500);
    expect((last as any).content[0].output.value.content).toBe(big);
  });

  it("reduces old search results to titles and urls", () => {
    const old = toolMessage("search_knowledge_base", {
      query: "dharma",
      results: [{ title: "A", url: "https://www.vedic.study/a", snippet: big }],
    });
    const [compacted] = compactToolResults([old], 0);
    expect((compacted as any).content[0].output.value.results[0]).toEqual({
      title: "A",
      url: "https://www.vedic.study/a",
    });
  });
});
