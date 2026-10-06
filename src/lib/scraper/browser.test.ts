import { describe, expect, it } from "vitest";
import { isAllowedVedicUrl, isGatePath } from "./browser";

describe("source URL boundary", () => {
  it("allows HTTPS pages on vedic.study and its subdomains", () => {
    expect(isAllowedVedicUrl("https://vedic.study/search?q=dharma")).toBe(true);
    expect(isAllowedVedicUrl("https://texts.vedic.study/page/1")).toBe(true);
  });

  it("rejects other domains, insecure URLs, and embedded credentials", () => {
    expect(isAllowedVedicUrl("https://vedic.study.example.com/page")).toBe(false);
    expect(isAllowedVedicUrl("https://example.com/")).toBe(false);
    expect(isAllowedVedicUrl("http://vedic.study/")).toBe(false);
    expect(isAllowedVedicUrl("https://user:pass@vedic.study/")).toBe(false);
  });
});

describe("invite gate detection", () => {
  it("recognizes the sign-in gate path only", () => {
    expect(isGatePath("/gate")).toBe(true);
    expect(isGatePath("/gate/")).toBe(true);
    expect(isGatePath("/gateway")).toBe(false);
    expect(isGatePath("/texts/gate")).toBe(false);
  });
});
