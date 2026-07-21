import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("basic-models fixture", () => {
  it("emits a Models.swift with a public struct and builds", async () => {
    const outputDir = await compileFixture("basic-models");
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    expect(models).toContain("public struct Item: Codable, Sendable, Hashable {");
    expect(models).toContain("public var id: String");
    expect(models).toContain("public var quantity: Int32");
    expect(models).toContain("public var price: Double");
    expect(models).toContain("public var inStock: Bool");
    expect(models).toContain("public var createdAt: Date");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("unions fixture", () => {
  it("emits enum, indirect union, and @error conformance, and builds", async () => {
    const outputDir = await compileFixture("unions");
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    expect(models).toContain("public enum ItemStatus: String, Codable, Sendable, Hashable, CaseIterable {");
    expect(models).toContain('case active = "active"');
    expect(models).toContain("public indirect enum Content: Codable, Sendable, Hashable {");
    expect(models).toContain("case nested(Item)");
    expect(models).toContain("public struct NotFoundError: Codable, Sendable, Hashable, APIError {");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});
