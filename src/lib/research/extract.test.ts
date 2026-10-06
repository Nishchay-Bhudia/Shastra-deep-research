import { describe, expect, it } from "vitest";
import { analyzeMessage } from "./extract";

describe("analyzeMessage", () => {
  const message = {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "text", text: "Let me look into this." },
      { type: "tool-plan_research", state: "output-available", input: { reportTitle: "Dharma in the Shikshapatri", subQuestions: ["a", "b"] }, output: { planned: true } },
      { type: "tool-search_knowledge_base", state: "output-available", output: { results: [{ url: "https://vedic.study/scriptures/x/", title: "X", snippet: "s" }] } },
      { type: "tool-save_note", state: "output-available", output: { saved: true, noteNumber: 1, url: "https://www.vedic.study/scriptures/x", title: "X" } },
      { type: "tool-create_diagram", state: "output-available", output: { id: "D1", title: "T", mermaid: "flowchart TD\n a-->b", sources: [] } },
      { type: "tool-read_document", state: "input-streaming" },
      { type: "text", text: "Final " },
      { type: "text", text: "report [1]" },
    ],
  };

  it("keeps only the text after the last tool call, so tool-time chatter is never shown", () => {
    expect(analyzeMessage(message).text).toBe("Final report [1]");
  });

  it("collects plan, normalized sources, notes, diagrams, and counts", () => {
    const result = analyzeMessage(message);
    expect(result.plan?.reportTitle).toBe("Dharma in the Shikshapatri");
    expect([...result.sources.keys()]).toEqual(["https://www.vedic.study/scriptures/x"]);
    expect(result.notes.get(1)?.url).toBe("https://www.vedic.study/scriptures/x");
    expect(result.diagrams[0].id).toBe("D1");
    expect(result.counts).toEqual({ searches: 1, reads: 0, notes: 1 });
    expect(result.activity).toBe("Reading a source");
  });
});
