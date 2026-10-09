/**
 * A report built directly from the saved notes, with no model involved. It is the safety net: when a
 * run cannot deliver a normal report (out of time, a model error, the connection cut), the reader
 * still gets everything that was found, organised by question, with working citations, and an
 * honest notice of what went wrong, instead of a blank screen.
 */
export type FallbackInput = {
  plan?: { reportTitle: string; subQuestions: string[] };
  notes: { note: string; quote?: string; subQuestion?: number }[];
  analysis?: { thesis: string; tensions: string[]; gaps: string[] };
  /** Pages the searches surfaced (title, link, passage); used when no notes were saved. */
  hits?: { title: string; url: string; snippet: string }[];
  /** Problems the tools reported (for example an expired vedic.study session). */
  errors: string[];
  /** Why the normal report could not be delivered, in plain words. */
  reason: string;
};

export type FallbackReport = { markdown: string; issues: string[] };

export function compileFallbackReport(input: FallbackInput): FallbackReport {
  const { plan, notes, analysis, errors, reason, hits = [] } = input;
  const issues = [reason];
  const lines: string[] = [];

  if (notes.length === 0 && hits.length > 0) {
    // No notes were saved, but the searches did surface passages: give the reader those, honestly labelled.
    lines.push("## Bottom line", "");
    lines.push(
      "The research could not read the full pages or write an analysis, so this is only what the searches surfaced: the most relevant passages found on vedic.study, with links so you can read them in full.",
      "",
    );
    lines.push("## Passages the searches surfaced", "");
    for (const hit of hits.slice(0, 15)) {
      lines.push(`- **[${hit.title.replace(/[\[\]]/g, "")}](${hit.url})**: ${hit.snippet.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("", "## Limitations and gaps", "");
    lines.push(`- ${reason}`);
    for (const error of [...new Set(errors)].slice(0, 4)) lines.push(`- A source problem was reported: ${error}`);
    return { markdown: lines.join("\n"), issues };
  }

  if (notes.length === 0) {
    lines.push("## Bottom line", "");
    lines.push("No evidence could be retrieved from vedic.study for this question, so there is nothing to report yet.", "");
    lines.push("## What went wrong", "");
    lines.push(`- ${reason}`);
    for (const error of [...new Set(errors)].slice(0, 5)) lines.push(`- ${error}`);
    lines.push("", "Try the question again. If it keeps failing, the saved vedic.study session may have expired (run `npm run login`).");
    return { markdown: lines.join("\n"), issues };
  }

  lines.push("## Bottom line", "");
  lines.push(
    analysis?.thesis ||
      "The run ended before a full analysis could be written, so this is a structured digest of what the sources say, organised by question. Each point cites the page it comes from.",
    "",
  );

  lines.push("## What the sources say", "");
  const questions = plan?.subQuestions.length ? plan.subQuestions : ["Findings"];
  const unanswered: string[] = [];
  questions.forEach((question, index) => {
    const own = notes
      .map((entry, noteIndex) => ({ entry, number: noteIndex + 1 }))
      .filter(({ entry }) => (plan ? entry.subQuestion === index + 1 : true));
    lines.push(`### ${question}`, "");
    if (own.length === 0) {
      lines.push("_No evidence was retrieved for this question._", "");
      unanswered.push(question);
      return;
    }
    for (const { entry, number } of own) {
      const quote = entry.quote?.trim();
      lines.push(`- ${entry.note.trim()}${quote ? `\n  > ${quote.replace(/\n+/g, " ")}` : ""} [${number}]`);
    }
    lines.push("");
  });

  if (analysis?.tensions.length) {
    lines.push("## Tensions and nuance", "", ...analysis.tensions.map((tension) => `- ${tension}`), "");
  }

  lines.push("## Limitations and gaps", "");
  lines.push(`- This is a compiled digest, not a fully written analysis: ${reason}`);
  for (const question of unanswered) lines.push(`- Nothing was found for: ${question}`);
  for (const gap of analysis?.gaps ?? []) lines.push(`- ${gap}`);
  for (const error of [...new Set(errors)].slice(0, 3)) lines.push(`- A source problem was reported: ${error}`);

  return { markdown: lines.join("\n"), issues };
}
