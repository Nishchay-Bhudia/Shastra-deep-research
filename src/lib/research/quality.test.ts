import { describe, expect, it } from "vitest";
import { checkReport } from "./quality";

const good = `## Bottom line
Dharma supports bhakti [1, 2].

## Key terms
The Vachanamrut says so [3].

## Analysis
${"The passage establishes the claim and explains why it matters for the question asked. ".repeat(110)} [4] [5]

## Tensions and limitations
Some sources qualify this [6].`;

const base = {
  depth: "standard" as const,
  noteCount: 6,
  noteSubQuestions: [1, 1, 2, 2, 3, 3],
  subQuestionCount: 3,
  relaxed: false,
};

describe("checkReport", () => {
  it("accepts a substantial, cited, chatter-free report", () => {
    const result = checkReport({ markdown: good, ...base });
    expect(result.style).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("rejects process chatter, short length, and missing citations", () => {
    const result = checkReport({ markdown: "Let me search for this. I will now read the pages.", ...base });
    expect(result.style.join(" ")).toMatch(/process talk/);
    expect(result.style.join(" ")).toMatch(/too short/);
    expect(result.style.join(" ")).toMatch(/headings/);
  });

  it("flags citations to notes that do not exist", () => {
    const result = checkReport({ markdown: `${good} [42]`, ...base });
    expect(result.style.join(" ")).toMatch(/do not exist \(42\)/);
  });

  it("asks for more research when too few notes exist, unless relaxed", () => {
    expect(checkReport({ markdown: good, ...base, noteCount: 3, noteSubQuestions: [1, 2, 3] }).evidence).toHaveLength(1);
    expect(checkReport({ markdown: good, ...base, noteCount: 3, noteSubQuestions: [1, 2, 3], relaxed: true }).evidence).toEqual([]);
  });
});
