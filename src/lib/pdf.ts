import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export async function markdownToHtml(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize)
    .use(rehypeStringify)
    .process(markdown);
  // Mermaid reads the decoded text of a <pre class="mermaid"> block.
  return String(file).replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    '<pre class="mermaid">$1</pre>',
  );
}

const STYLES = `
  @page { margin: 22mm 18mm; }
  body { font-family: "Iowan Old Style", Georgia, "Noto Serif", "Noto Serif Devanagari", "Noto Sans Gujarati", "Kohinoor Devanagari", "Gujarati Sangam MN", serif;
         color: #2f2a1f; font-size: 11pt; line-height: 1.6; }
  h1 { font-size: 22pt; margin: 0 0 4pt; }
  h2 { font-size: 15pt; margin-top: 20pt; border-bottom: 1px solid #d9cfb5; padding-bottom: 3pt; }
  h3 { font-size: 12.5pt; margin-top: 14pt; }
  a { color: #7a5a1a; word-break: break-word; }
  blockquote { margin: 10pt 0; padding: 2pt 12pt; border-left: 3px solid #c9b98a; color: #4a4231; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 10pt; }
  th, td { border: 1px solid #d9cfb5; padding: 4pt 7pt; text-align: left; vertical-align: top; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 9.5pt; background: #f3eddc; padding: 0 3pt; border-radius: 3px; }
  pre { white-space: pre-wrap; }
  pre.mermaid { text-align: center; background: none; page-break-inside: avoid; }
  .meta { color: #8a7d5c; font-size: 9pt; margin-bottom: 14pt; }
  h2, h3 { page-break-after: avoid; }
`;

export async function renderReportPdf(options: {
  markdown: string;
  title: string;
}): Promise<Buffer> {
  const body = await markdownToHtml(options.markdown);
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title>
    <style>${STYLES}</style></head><body>
    <h1>${escapeHtml(options.title)}</h1>
    <div class="meta">Shastra research report · ${date} · Sources: vedic.study</div>
    ${body}</body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    if (html.includes('class="mermaid"')) {
      const mermaidPath = path.join(process.cwd(), "node_modules/mermaid/dist/mermaid.min.js");
      await page.addScriptTag({ content: await readFile(mermaidPath, "utf8") });
      await page.evaluate(async () => {
        const mermaid = (window as unknown as { mermaid: { initialize: (c: object) => void; run: (c: object) => Promise<void> } }).mermaid;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
        // A diagram that fails to parse stays as readable source text.
        await mermaid.run({ querySelector: "pre.mermaid", suppressErrors: true });
      });
    }

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#8a7d5c;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: "22mm", bottom: "20mm", left: "18mm", right: "18mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
