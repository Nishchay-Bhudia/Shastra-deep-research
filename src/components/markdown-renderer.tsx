"use client";

import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";

function normalizeUrl(href: string) {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return href;
  }
}

export function MarkdownRenderer({
  content,
  verifiedUrls,
}: {
  content: string;
  /** URLs actually returned by tools this run; other links are flagged. */
  verifiedUrls?: Set<string>;
}) {
  return (
    <div className="report-prose prose prose-stone max-w-none prose-headings:font-medium prose-p:leading-7 prose-li:leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          pre({ children }) {
            return <div className="not-prose my-4">{children}</div>;
          },
          a({ href, children }) {
            const isExternalCitation = !!href && /^https?:/i.test(href);
            const verified =
              !isExternalCitation || !verifiedUrls || verifiedUrls.has(normalizeUrl(href));
            return (
              <>
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
                {!verified && (
                  <span
                    title="This link was not returned by any search or page read in this run."
                    className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900"
                  >
                    unverified link
                  </span>
                )}
              </>
            );
          },
          code({ className, children, ...props }) {
            const value = String(children).replace(/\n$/, "");
            if (className?.includes("language-mermaid")) {
              return <MermaidDiagram chart={value} />;
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
