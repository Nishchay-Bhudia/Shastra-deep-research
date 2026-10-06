import { describe, expect, it } from "vitest";
import type { BuiltDiagram } from "./diagram";
import { finalizeReport, pdfFileName, type SourceMap } from "./report";

const sources: SourceMap = new Map([
  [
    "https://www.vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1",
    { url: "https://www.vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1", title: "Shikshapatri › Shlok 73" },
  ],
]);
const diagram: BuiltDiagram = {
  id: "D1",
  title: "Dharma map",
  mermaid: 'flowchart TD\n  a["A"] --> b["B"]',
  sources: ["https://www.vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1"],
};

const finalize = (markdown: string, includeDiagrams = true, diagrams = [diagram]) =>
  finalizeReport({ markdown, sources, diagrams, includeDiagrams });

describe("finalizeReport", () => {
  it("rewrites a bare-domain or http citation to the exact retrieved https www URL", () => {
    const out = finalize("See [Shlok 73](http://vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1/).");
    expect(out).toContain("](https://www.vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1)");
    expect(out).not.toContain("http://");
  });

  it("repairs a mangled URL by its unique final segment", () => {
    const out = finalize("[x](https://www.vedic.study/scriptures/shikshapatri/shlok-73/paragraph-1)");
    expect(out).toContain("https://www.vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1");
  });

  it("turns unmatched and off-site links into plain text, never dead links", () => {
    const out = finalize("[a](https://www.vedic.study/invented/page-that-never-existed) and [b](https://example.com/x)");
    expect(out).toContain("a (unverified source)");
    expect(out).toContain("and b");
    expect(out).not.toContain("invented");
    expect(out).not.toContain("example.com");
  });

  it("appends a References list of cited, verified pages only", () => {
    const out = finalize("Claim [Shlok 73](https://www.vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1).");
    expect(out).toMatch(/## References\n\n1\. \[Shikshapatri › Shlok 73\]\(https:\/\/www\.vedic\.study\//);
  });

  it("replaces diagram markers with the grounded diagram and drops hand-written mermaid", () => {
    const out = finalize("Intro\n\n[[diagram:D1]]\n\n```mermaid\ngraph TD; X-->Y\n```\n");
    expect(out).toContain('flowchart TD\n  a["A"] --> b["B"]');
    expect(out).not.toContain("X-->Y");
    expect(out).toContain("a synthesis of the cited pages");
  });

  it("appends created diagrams that the report forgot to place, and omits all when disabled", () => {
    expect(finalize("No marker here.")).toContain("## Diagrams");
    const off = finalize("Text [[diagram:D1]]", false);
    expect(off).not.toContain("flowchart");
    expect(off).not.toContain("[[diagram");
  });
});

describe("numeric note citations", () => {
  const url = "https://www.vedic.study/scriptures/shikshapatri/en/shlok-73/shlok-73-commentary-3/paragraph-1";
  const notes = new Map([[3, { url, title: "Shikshapatri › Shlok 73" }]]);

  it("turns [3] into a link built from the saved note, and numbers references by first use", () => {
    const out = finalizeReport({ markdown: "Dharma matters [3]. Again [3].", sources, notes, diagrams: [], includeDiagrams: true });
    expect(out).toContain(`[\\[1\\]](${url})`);
    expect(out).toContain(`1. [Shikshapatri › Shlok 73](${url})`);
    expect(out.match(/## References/g)).toHaveLength(1);
  });

  it("drops a numeric citation that matches no note", () => {
    const out = finalizeReport({ markdown: "Claim [9].", sources, notes, diagrams: [], includeDiagrams: true });
    expect(out).toBe("Claim .");
  });
});

describe("pdfFileName", () => {
  it("makes a readable, dated, filesystem-safe name and keeps non-Latin letters", () => {
    const date = new Date("2026-10-06T10:00:00Z");
    expect(pdfFileName("Dharma in the Shikshapatri: what does it say?", date)).toBe("Dharma-in-the-Shikshapatri-what-does-it-say-2026-10-06.pdf");
    expect(pdfFileName("ધર્મ / Dharma", date)).toBe("ધર્મ-Dharma-2026-10-06.pdf");
    expect(pdfFileName("???", date)).toBe("Shastra-research-2026-10-06.pdf");
  });
});
