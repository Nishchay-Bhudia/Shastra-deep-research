import { describe, expect, it } from "vitest";
import { getStepGuidance } from "./config";

describe("getStepGuidance", () => {
  it("disables tools on the last allowed step", () => {
    expect(getStepGuidance("deep", 99, 0, 100, 60_000).finalize).toBe(true);
    expect(getStepGuidance("deep", 98, 0, 100, 60_000).finalize).toBe(false);
  });

  it("disables tools once the time budget is spent", () => {
    expect(getStepGuidance("really-deep", 3, 61_000, 500, 60_000).finalize).toBe(true);
  });

  it("warns shortly before the ceiling or deadline", () => {
    expect(getStepGuidance("deep", 97, 0, 100, 60_000).note).toMatch(/nearly spent/);
    expect(getStepGuidance("deep", 3, 55_000, 100, 60_000).note).toMatch(/nearly spent/);
  });

  it("does not interrupt a run that is well within budget", () => {
    expect(getStepGuidance("really-deep", 120, 1_000, 500, 60_000)).toEqual({ finalize: false });
  });
});
