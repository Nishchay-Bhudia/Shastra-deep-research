import { describe, expect, it } from "vitest";
import { normalizeScrapedText } from "./transliterate";

describe("normalizeScrapedText", () => {
  it("keeps Devanagari and appends a Latin transliteration", () => {
    const result = normalizeScrapedText("धर्म");
    expect(result).toContain("धर्म [");
    expect(result).not.toBe("धर्म");
  });

  it("preserves ordinary English text", () => {
    expect(normalizeScrapedText("Dharma and the Vedas")).toBe(
      "Dharma and the Vedas",
    );
  });

  it("does not remove punctuation around source text", () => {
    const result = normalizeScrapedText("Verse: धर्म।");
    expect(result.startsWith("Verse: ")).toBe(true);
    expect(result).toContain("धर्म");
  });
});
