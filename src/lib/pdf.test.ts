import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./pdf";

describe("markdownToHtml", () => {
  it("keeps links and tables and marks mermaid blocks", async () => {
    const html = await markdownToHtml(
      "## H\n\n[Src](https://www.vedic.study/a)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```",
    );
    expect(html).toContain('<a href="https://www.vedic.study/a">Src</a>');
    expect(html).toContain("<table>");
    expect(html).toContain('<pre class="mermaid">');
  });

  it("strips scripts", async () => {
    expect(await markdownToHtml("<script>alert(1)</script>hi")).not.toContain("<script");
  });
});
