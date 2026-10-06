/**
 * Playful status words shown while the agent works, keyed by what it is doing.
 * Gujarati ones are written in Latin script ("vaachu chhu" = "I am reading").
 */
export type Phase = "analysing" | "thinking" | "planning" | "searching" | "reading" | "noting" | "checking" | "drawing" | "writing";

const WORDS: Record<Phase, string[]> = {
  thinking: ["Thinking", "Vichaaru chhu", "Pondering", "Gathering thoughts"],
  planning: ["Planning", "Vichaaru chhu", "Charting a course", "Sketching an outline"],
  searching: ["Scurrying through the shelves", "Shodhu chhu", "Searching", "Hunting for passages", "Rummaging"],
  reading: ["Reading", "Vaachu chhu", "Studying", "Poring over the text", "Absorbing"],
  noting: ["Jotting notes", "Noto karu chhu", "Noting it down", "Marking the key lines"],
  analysing: ["Analysing", "Weighing the evidence", "Connecting the threads", "Taali jou chhu", "Finding the argument"],
  checking: ["Analysing", "Taali jou chhu", "Cross-checking", "Weighing the evidence"],
  drawing: ["Sketching a diagram", "Doru chhu", "Connecting the dots"],
  writing: ["Writing it up", "Lakhu chhu", "Composing", "Bringing it together"],
};

export function wordsFor(phase: Phase): string[] {
  return WORDS[phase];
}

/** Maps the tool currently in flight (or the lack of one) to a phase. */
export function phaseFor(activity: string | undefined, hasPlan: boolean, writing: boolean): Phase {
  if (writing) return "writing";
  switch (activity) {
    case "Planning the research":
      return "planning";
    case "Searching vedic.study":
      return "searching";
    case "Reading a source":
      return "reading";
    case "Taking notes":
      return "noting";
    case "Checking coverage":
      return "checking";
    case "Analysing the evidence":
      return "analysing";
    case "Drawing a diagram":
      return "drawing";
    default:
      return hasPlan ? "checking" : "thinking";
  }
}
