import type { Depth } from "./config";

export type QualityInput = {
  markdown: string;
  depth: Depth;
  noteCount: number;
  /** Sub-question number of every saved note, in note order (index 0 is note 1). */
  noteSubQuestions: (number | undefined)[];
  subQuestionCount: number;
  /** Relaxed checks apply when time is nearly up: deliver the best honest report rather than none. */
  relaxed: boolean;
};

export type QualityResult = {
  /** Problems with the writing that a rewrite can fix. */
  style: string[];
  /** Problems that only more research can fix. */
  evidence: string[];
};

const MIN_WORDS: Record<Depth, number> = { standard: 800, deep: 1_300, "really-deep": 2_000 };
const MIN_NOTES: Record<Depth, number> = { standard: 6, deep: 10, "really-deep": 16 };

// Process chatter that belongs in the agent's working, never in a report.
const CHATTER =
  /\b(let me|let's|i will now|i'll now|i'm going to|i am going to|i need to|i should|now i will|first,? i will|i have (searched|read|gathered)|based on my (search|research)|the tool|check_coverage|save_note|read_documents?|search_knowledge_base|analyze_evidence|create_diagram|submit_report|research budget|search budget)\b/i;

export const minNotesFor = (depth: Depth) => MIN_NOTES[depth];

export function citedNoteNumbers(markdown: string): number[] {
  const cited: number[] = [];
  for (const match of markdown.matchAll(/(?<![\]\w\\])\[\[?\s*(\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*)\s*\]?\](?!\()/g)) {
    for (const part of match[1].split(/[,;–-]/)) cited.push(Number(part.trim()));
  }
  return cited;
}

export function checkReport(input: QualityInput): QualityResult {
  const { markdown, depth, noteCount, noteSubQuestions, subQuestionCount, relaxed } = input;
  const style: string[] = [];
  const evidence: string[] = [];

  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  const minWords = relaxed ? 250 : MIN_WORDS[depth];
  if (words < minWords) {
    style.push(`too short (${words} words; at least ${minWords} are needed). Develop the analysis: quote the key passages, explain what they establish, and compare them`);
  }

  const opening = markdown.trim().slice(0, 500);
  if (CHATTER.test(opening) || /^(okay|ok|sure|alright|certainly|here is|here's|now,)\b/i.test(opening)) {
    style.push("it opens with process talk instead of the report. Begin directly with the bottom line");
  }
  const chatterLine = markdown.split("\n").find((line) => CHATTER.test(line));
  if (chatterLine) {
    style.push(`it mentions your process or tools ("${chatterLine.trim().slice(0, 70)}"). A report speaks only about the sources and the question`);
  }

  if ((markdown.match(/^#{1,4}\s+\S/gm) ?? []).length < 3) {
    style.push("it needs clear section headings (bottom line, analysis by sub-question, tensions, limitations)");
  }

  const cited = citedNoteNumbers(markdown);
  const missing = [...new Set(cited.filter((n) => n < 1 || n > noteCount))];
  if (missing.length > 0) {
    style.push(`it cites note numbers that do not exist (${missing.join(", ")}); there are ${noteCount} notes`);
  }
  const distinct = new Set(cited.filter((n) => n >= 1 && n <= noteCount));
  const minCited = relaxed ? Math.min(2, noteCount) : Math.min(Math.max(4, Math.ceil(noteCount * 0.25)), 10, noteCount);
  if (distinct.size < minCited) {
    style.push(`it cites only ${distinct.size} distinct notes; cite the evidence behind each claim (at least ${minCited} different notes)`);
  }

  // Most questions should draw on the evidence gathered for them (one or two may be thin).
  let unused = 0;
  let withNotes = 0;
  for (let q = 1; q <= subQuestionCount; q += 1) {
    if (!noteSubQuestions.some((n) => n === q)) continue;
    withNotes += 1;
    if (![...distinct].some((n) => noteSubQuestions[n - 1] === q)) unused += 1;
  }
  if (!relaxed && withNotes > 0 && unused > Math.floor(withNotes / 2)) {
    style.push(`it ignores the evidence you gathered for ${unused} of ${withNotes} sub-questions; use it`);
  }

  if (!relaxed && noteCount < MIN_NOTES[depth]) {
    evidence.push(`only ${noteCount} notes were saved; a ${depth} report needs at least ${MIN_NOTES[depth]} well-sourced notes`);
  }
  return { style, evidence };
}
