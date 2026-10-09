import { urlKey } from "@/lib/vedic-url";

export type DiagramInput = {
  title: string;
  direction: "TD" | "LR";
  nodes: { id: string; label: string }[];
  edges: { from: string; to: string; label?: string; sourceUrl: string }[];
};

export type BuiltDiagram = {
  id: string;
  title: string;
  mermaid: string;
  /** Canonical URLs of the pages that support the diagram's relationships. */
  sources: string[];
};

const MIN_NODES = 4;
const MIN_EDGES = 4;
const MAX_NODES = 16;
const MAX_EDGES = 28;

function label(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "#quot;")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 80);
}

/**
 * Builds a Mermaid flowchart from structured data. The syntax is generated here
 * (never hand-written by the model), so it always parses, and every relationship
 * must cite a page that was actually retrieved, so it is grounded in the sources.
 */
export function buildDiagram(
  input: DiagramInput,
  retrieved: Set<string>,
  id: string,
): { diagram: BuiltDiagram } | { error: string } {
  const { nodes, edges } = input;
  if (nodes.length < MIN_NODES || nodes.length > MAX_NODES) {
    return { error: `A useful diagram has between ${MIN_NODES} and ${MAX_NODES} nodes; this one has ${nodes.length}. Include every key concept the sources connect.` };
  }
  if (edges.length < MIN_EDGES || edges.length > MAX_EDGES) {
    return { error: `A useful diagram has between ${MIN_EDGES} and ${MAX_EDGES} labelled relationships; this one has ${edges.length}. Show how the concepts connect, each citing the page that states it.` };
  }

  // Ids are whatever the caller chose; the Mermaid ids are generated here so they are always valid.
  const mermaidId = new Map<string, string>();
  for (const node of nodes) {
    const id = node.id.trim();
    if (!id) return { error: "Every node needs an id." };
    if (mermaidId.has(id)) return { error: `Duplicate node id "${node.id}".` };
    mermaidId.set(id, `n${mermaidId.size + 1}`);
  }

  const used = new Set<string>();
  const sources = new Set<string>();
  const lines: string[] = [];
  for (const edge of edges) {
    if (!mermaidId.has(edge.from.trim()) || !mermaidId.has(edge.to.trim())) {
      return { error: `Relationship ${edge.from} -> ${edge.to} refers to a node that does not exist.` };
    }
    const key = urlKey(edge.sourceUrl);
    if (!key || !retrieved.has(key)) {
      return {
        error: `Relationship ${edge.from} -> ${edge.to} cites ${edge.sourceUrl}, which was not returned by a search or page read. Cite a page you retrieved, or leave the relationship out.`,
      };
    }
    used.add(edge.from.trim());
    used.add(edge.to.trim());
    sources.add(key);
    const text = edge.label ? label(edge.label) : "";
    const from = mermaidId.get(edge.from.trim());
    const to = mermaidId.get(edge.to.trim());
    lines.push(text ? `  ${from} -->|"${text}"| ${to}` : `  ${from} --> ${to}`);
  }

  const unused = nodes.filter((node) => !used.has(node.id.trim()));
  if (unused.length > 0) {
    return { error: `Nodes with no relationship: ${unused.map((n) => n.id).join(", ")}. Remove them or connect them.` };
  }

  const mermaid = [
    `flowchart ${input.direction}`,
    ...nodes.map((node) => `  ${mermaidId.get(node.id.trim())}["${label(node.label)}"]`),
    ...lines,
  ].join("\n");

  return { diagram: { id, title: input.title.trim(), mermaid, sources: [...sources] } };
}
