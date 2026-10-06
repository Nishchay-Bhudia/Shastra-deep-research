import Sanscript from "@indic-transliteration/sanscript";

const indicRun =
  /[\u0900-\u097F\u0A80-\u0AFF]+(?:[\s\u0964\u0965,;:!?।॥]+[\u0900-\u097F\u0A80-\u0AFF]+)*/g;

export function normalizeScrapedText(text: string): string {
  return text.replace(indicRun, (run) => {
    const sourceScript = /[\u0A80-\u0AFF]/.test(run) ? "gujarati" : "devanagari";
    try {
      const latin = Sanscript.t(run, sourceScript, "iast");
      return latin && latin !== run ? `${run} [${latin}]` : run;
    } catch {
      // Preserve the source exactly if a character is unsupported.
      return run;
    }
  });
}
