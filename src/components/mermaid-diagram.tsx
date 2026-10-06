"use client";

import { useEffect, useId, useRef, useState } from "react";

export function MermaidDiagram({ chart }: { chart: string }) {
  const elementId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      if (!containerRef.current) return;
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            background: "#f8f6ef",
            primaryColor: "#eee7d4",
            primaryTextColor: "#493f2d",
            primaryBorderColor: "#b9a77a",
            lineColor: "#8e7951",
            secondaryColor: "#e8eddf",
            tertiaryColor: "#f7f1e3",
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          },
        });
        const { svg } = await mermaid.render(`shastra-${elementId}`, chart);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(false);
        }
      } catch {
        if (!cancelled && containerRef.current) {
          containerRef.current.textContent =
            "This diagram could not be rendered. The report still contains its source definition.";
          setError(true);
        }
      }
    }

    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [chart, elementId]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label="Research concept diagram"
      className={`my-5 overflow-x-auto rounded-2xl border border-cream-300 bg-cream-50/80 p-4 text-sm ${
        error ? "text-cream-700" : ""
      }`}
    />
  );
}
