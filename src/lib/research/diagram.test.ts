import { describe, expect, it } from "vitest";
import { buildDiagram, type DiagramInput } from "./diagram";

const retrieved = new Set(["https://www.vedic.study/scriptures/a"]);
const base: DiagramInput = {
  title: "Dharma and bhakti",
  direction: "TD",
  nodes: [
    { id: "d", label: 'Dharma "root"' },
    { id: "b", label: "Bhakti" },
  ],
  edges: [{ from: "d", to: "b", label: "supports", sourceUrl: "https://vedic.study/scriptures/a/" }],
};

describe("buildDiagram", () => {
  it("builds valid mermaid and normalizes the source url", () => {
    const result = buildDiagram(base, retrieved, "D1");
    if (!("diagram" in result)) throw new Error(result.error);
    expect(result.diagram.mermaid).toContain('flowchart TD');
    expect(result.diagram.mermaid).toContain('n1["Dharma #quot;root#quot;"]');
    expect(result.diagram.mermaid).toContain('n1 -->|"supports"| n2');
    expect(result.diagram.sources).toEqual(["https://www.vedic.study/scriptures/a"]);
  });

  it("rejects relationships citing pages that were never retrieved", () => {
    const result = buildDiagram(
      { ...base, edges: [{ ...base.edges[0], sourceUrl: "https://www.vedic.study/made-up" }] },
      retrieved,
      "D1",
    );
    expect(result).toHaveProperty("error");
  });

  it("accepts any id the model picks and still emits valid mermaid ids", () => {
    const result = buildDiagram(
      {
        ...base,
        nodes: [
          { id: "Shikshapatri_Dharma", label: "A" },
          { id: "vachanamrut dharma", label: "B" },
        ],
        edges: [{ ...base.edges[0], from: "Shikshapatri_Dharma", to: "vachanamrut dharma" }],
      },
      retrieved,
      "D1",
    );
    if (!("diagram" in result)) throw new Error(result.error);
    expect(result.diagram.mermaid).toContain("n1 -->|\"supports\"| n2");
  });

  it("rejects dangling edges and unused nodes", () => {
    expect(buildDiagram({ ...base, edges: [{ ...base.edges[0], to: "zzz" }] }, retrieved, "D1")).toHaveProperty("error");
    expect(
      buildDiagram({ ...base, nodes: [...base.nodes, { id: "x", label: "Lonely" }] }, retrieved, "D1"),
    ).toHaveProperty("error");
  });
});
