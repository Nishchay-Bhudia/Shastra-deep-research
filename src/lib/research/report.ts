import type { BuiltDiagram } from "./diagram";
import { isVedicHost, normalizeVedicUrl, urlKey } from "@/lib/vedic-url";

/** Pages the tools actually returned, keyed by canonical URL (see urlKey). */
export type SourceMap = Map<string, { url: string; title: string }>;

export type FinalizeOptions = {
  markdown: string;
  sources: SourceMap;
  /** Saved research notes by their number; the model may cite them as [3] or [3, 5]. */
  notes?: Map<number, { url: string; title: string }>;
  diagrams: BuiltDiagram[];
  includeDiagrams: boolean;
};

const NUMERIC = /(?<![\]\w\\])\[\[?\s*(\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*)\s*\]?\](?!\()/g;
const LINK = /(?<!!)\[([^\]]+)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
const MARKER = /\[\[\s*diagram\s*:\s*([A-Za-z0-9_-]+)\s*\]\]/gi;
const MERMAID_FENCE = /```\s*mermaid[\s\S]*?```/gi;

function lastSegment(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
}

/** Finds the retrieved page a model-written link most plausibly meant, or undefined. */
function resolveSource(url: string, sources: SourceMap) {
  const key = urlKey(url);
  if (!key) return undefined;
  const exact = sources.get(key);
  if (exact) return exact;
  // The model sometimes mangles a long URL. Accept a unique match on the final path segment.
  const segment = lastSegment(key);
  if (segment.length < 6) return undefined;
  const matches = [...sources.values()].filter((source) => lastSegment(source.url) === segment);
  return matches.length === 1 ? matches[0] : undefined;
}

export function pdfFileName(title: string, date = new Date()): string {
  const base = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  return `${base || "Shastra-research"}-${date.toISOString().slice(0, 10)}.pdf`;
}

/**
 * Turns the model's draft into the report the reader sees and the PDF contains:
 * - citation links are repaired to the exact retrieved page (https, www.vedic.study),
 *   and any link that cannot be matched to a retrieved page is shown as plain text
 *   marked unverified rather than as a dead link;
 * - [[diagram:ID]] markers become the grounded diagrams built by create_diagram;
 *   hand-written mermaid blocks are dropped;
 * - a References list built from the links actually cited is appended.
 */
export function finalizeReport({ markdown, sources, notes = new Map(), diagrams, includeDiagrams }: FinalizeOptions): string {
  let text = markdown.replace(MERMAID_FENCE, "");

  const cited: { url: string; title: string }[] = [];
  const displayNumber = new Map<string, number>();
  const cite = (source: { url: string; title: string }) => {
    const key = urlKey(source.url)!;
    if (!displayNumber.has(key)) {
      displayNumber.set(key, cited.length + 1);
      cited.push({ url: normalizeVedicUrl(source.url)!, title: source.title });
    }
    return displayNumber.get(key)!;
  };

  // Markdown links: repair to the exact retrieved page, or drop the link.
  text = text.replace(LINK, (_whole, label: string, rawUrl: string) => {
    const url = rawUrl.replace(/^<|>$/g, "");
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return `${label} (unverified source)`;
    }
    if (!isVedicHost(host)) return label; // the source boundary is vedic.study only
    const source = resolveSource(url, sources);
    if (!source) return `${label} (unverified source)`;
    cite(source);
    return `[${label}](${normalizeVedicUrl(source.url)})`;
  });

  // Numeric citations such as [3] or [3, 5] point at saved notes; the URL comes from the note.
  text = text.replace(NUMERIC, (_whole, list: string) =>
    list
      .split(/[,;–-]/)
      .map((part) => Number(part.trim()))
      .map((number) => {
        const note = notes.get(number);
        const source = note && resolveSource(note.url, sources);
        if (!source) return "";
        return `[\\[${cite(source)}\\]](${normalizeVedicUrl(source.url)})`;
      })
      .filter(Boolean)
      .join(" "),
  );

  const byId = new Map(diagrams.map((diagram) => [diagram.id.toUpperCase(), diagram]));
  const placed = new Set<string>();
  const render = (diagram: BuiltDiagram) => {
    const links = diagram.sources
      .map((url) => {
        const source = sources.get(url);
        return source ? `[${source.title.slice(0, 80)}](${normalizeVedicUrl(source.url)})` : undefined;
      })
      .filter(Boolean)
      .join("; ");
    return `\n\n\`\`\`mermaid\n${diagram.mermaid}\n\`\`\`\n\n*${diagram.title}: a synthesis of the cited pages, not a quotation.${
      links ? ` Based on: ${links}.` : ""
    }*\n\n`;
  };

  text = text.replace(MARKER, (_whole, id: string) => {
    const diagram = byId.get(id.toUpperCase());
    if (!includeDiagrams || !diagram || placed.has(diagram.id)) return "";
    placed.add(diagram.id);
    return render(diagram);
  });

  if (includeDiagrams) {
    const missing = diagrams.filter((diagram) => !placed.has(diagram.id));
    if (missing.length > 0) {
      text = `${text.trimEnd()}\n\n## Diagrams\n${missing.map(render).join("")}`;
    }
  }

  // The model is told not to write its own source list; references are generated from real links.
  // Numbered by first citation, matching the inline [n] links.
  if (cited.length > 0) {
    text = `${text.trimEnd()}\n\n## References\n\n${cited
      .map((source, index) => `${index + 1}. [${source.title}](${source.url})`)
      .join("\n")}\n`;
  }
  return text.replace(/\n{4,}/g, "\n\n\n");
}
