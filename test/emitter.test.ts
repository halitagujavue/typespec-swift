import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { compileFixture } from "./helpers/compile-fixture.ts";
import { buildGeneratedSwift } from "./helpers/swift-build.ts";

describe("empty fixture", () => {
  it("copies the runtime and produces a buildable (empty) package", async () => {
    const outputDir = await compileFixture("empty");
    expect(readdirSync(join(outputDir, "Runtime")).length).toBeGreaterThan(0);
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

function join(...parts: string[]) {
  return parts.join("/");
}
