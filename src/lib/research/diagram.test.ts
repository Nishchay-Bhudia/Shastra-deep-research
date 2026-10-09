import { describe, expect, it } from "vitest";
import { buildDiagram, type DiagramInput } from "./diagram";

const retrieved = new Set(["https://www.vedic.study/scriptures/a"]);
const src = "https://vedic.study/scriptures/a/";
const base: DiagramInput = {
  title: "Dharma and bhakti",
  direction: "TD",
  nodes: [
    { id: "d", label: 'Dharma "root"' },
    { id: "b", label: "Bhakti" },
    { id: "g", label: "Gnan" },
    { id: "v", label: "Vairagya" },
  ],
  edges: [
    { from: "d", to: "b", label: "supports", sourceUrl: src },
    { from: "g", to: "b", label: "deepens", sourceUrl: src },
    { from: "v", to: "b", label: "protects", sourceUrl: src },
    { from: "d", to: "v", label: "grounds", sourceUrl: src },
  ],
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
    const ids = ["Shikshapatri_Dharma", "vachanamrut dharma", "Bhakti-1", "x.y"];
    const result = buildDiagram(
      {
        ...base,
        nodes: ids.map((id, index) => ({ id, label: `Concept ${index}` })),
        edges: [
          { ...base.edges[0], from: ids[0], to: ids[1] },
          { ...base.edges[0], from: ids[1], to: ids[2] },
          { ...base.edges[0], from: ids[2], to: ids[3] },
          { ...base.edges[0], from: ids[3], to: ids[0] },
        ],
      },
      retrieved,
      "D1",
    );
    if (!("diagram" in result)) throw new Error(result.error);
    expect(result.diagram.mermaid).toContain('n1 -->|"supports"| n2');
  });

  it("rejects a diagram too thin to be useful", () => {
    expect(buildDiagram({ ...base, nodes: base.nodes.slice(0, 2), edges: base.edges.slice(0, 1) }, retrieved, "D1")).toHaveProperty("error");
  });

  it("rejects dangling edges and unused nodes", () => {
    expect(buildDiagram({ ...base, edges: [{ ...base.edges[0], to: "zzz" }] }, retrieved, "D1")).toHaveProperty("error");
    expect(
      buildDiagram({ ...base, nodes: [...base.nodes, { id: "x", label: "Lonely" }] }, retrieved, "D1"),
    ).toHaveProperty("error");
  });
});
