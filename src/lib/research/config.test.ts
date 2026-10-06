import { describe, expect, it } from "vitest";
import { getMaxSteps, getStepGuidance, type Depth } from "./config";

describe("getStepGuidance", () => {
  const depths: Depth[] = ["standard", "deep", "really-deep"];

  it("disables tools on exactly the last allowed step for every depth", () => {
    for (const depth of depths) {
      const max = getMaxSteps(depth);
      expect(getStepGuidance(depth, max - 1).finalize).toBe(true);
      expect(getStepGuidance(depth, max - 2).finalize).toBe(false);
    }
  });

  it("warns one step before finalizing", () => {
    expect(getStepGuidance("standard", 3).note).toMatch(/One research step remains/);
  });

  it("gives phase guidance only on longer runs", () => {
    expect(getStepGuidance("standard", 1).note).toBeUndefined();
    expect(getStepGuidance("really-deep", 15).note).toMatch(/Middle phase/);
    expect(getStepGuidance("really-deep", 22).note).toMatch(/Late phase/);
  });
});
