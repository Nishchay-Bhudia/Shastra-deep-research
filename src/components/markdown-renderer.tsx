"use client";

import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="report-prose prose prose-stone max-w-none prose-headings:font-medium prose-p:leading-7 prose-li:leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          pre({ children }) {
            return <div className="not-prose my-4">{children}</div>;
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
