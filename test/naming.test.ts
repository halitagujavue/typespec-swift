import { describe, expect, it } from "vitest";
import {
  enumCaseName,
  escapeIdentifier,
  internalParamName,
  isSwiftKeyword,
  lowerFirst,
  upperFirst,
} from "../src/naming.ts";

describe("naming", () => {
  it("identifies Swift keywords", () => {
    expect(isSwiftKeyword("protocol")).toBe(true);
    expect(isSwiftKeyword("name")).toBe(false);
  });

  it("escapes keyword identifiers with backticks", () => {
    expect(escapeIdentifier("protocol")).toBe("`protocol`");
    expect(escapeIdentifier("name")).toBe("name");
  });

  it("builds dual-name init parameters for keywords", () => {
    expect(internalParamName("self")).toBe("selfValue");
    expect(internalParamName("name")).toBe("name");
  });

  it("normalizes SCREAMING_SNAKE_CASE enum case names", () => {
    expect(enumCaseName("ACTIVE")).toBe("active");
    expect(enumCaseName("NOT_FOUND")).toBe("notFound");
  });

  it("normalizes snake_case and passes through camelCase", () => {
    expect(enumCaseName("not_found")).toBe("notFound");
    expect(enumCaseName("alreadyCamel")).toBe("alreadyCamel");
  });

  it("adjusts first-letter case", () => {
    expect(upperFirst("item")).toBe("Item");
    expect(lowerFirst("Item")).toBe("item");
  });
});
