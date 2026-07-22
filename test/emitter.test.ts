import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    expect(models).toContain("public struct ItemStatus: RawRepresentable, Codable, Sendable, Hashable {");
    expect(models).toContain("public let rawValue: String");
    expect(models).toContain("public init(rawValue: String) {");
    expect(models).toContain('public static let active = ItemStatus(rawValue: "active")');
    expect(models).toContain('public static let archived = ItemStatus(rawValue: "archived")');
    expect(models).toContain('public static let pending = ItemStatus(rawValue: "pending")');
    expect(models).toContain("public indirect enum Content: Codable, Sendable, Hashable {");
    expect(models).toContain("case nested(Item)");
    expect(models).toContain("public struct NotFoundError: Codable, Sendable, Hashable, APIError {");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("enumStyle option", () => {
  it("emits a closed Swift enum when enumStyle is 'enum'", async () => {
    const outputDir = await compileFixture("unions", { enumStyle: "enum" });
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    expect(models).toContain("public enum ItemStatus: String, Codable, Sendable, Hashable, CaseIterable {");
    expect(models).toContain('case active = "active"');
    expect(models).toContain('case archived = "archived"');
    expect(models).toContain('case pending = "pending"');
    expect(models).not.toContain("RawRepresentable");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("basic-crud fixture", () => {
  it("emits a Client.swift with CRUD operations and builds", async () => {
    const outputDir = await compileFixture("basic-crud");
    const client = readFileSync(join(outputDir, "BasicCrudServiceClient.swift"), "utf8");
    expect(client).toContain("public struct BasicCrudServiceClient: Sendable {");
    expect(client).toContain(
      "public func getItem(itemId: String, include: String? = nil, ifNoneMatch: String? = nil) async throws -> Item {"
    );
    expect(client).toContain('builder.addQuery("include", include)');
    expect(client).toContain('builder.setHeader("if-none-match", ifNoneMatch)');
    expect(client).toContain("try response.checkStatus(errorTypes: [404: NotFoundError.self])");
    expect(client).toContain(
      "public func createItem(payload: ItemInput) async throws -> Item {"
    );
    expect(client).toContain("try response.checkStatus(errorTypes: [422: ValidationError.self])");
    expect(client).toContain(
      "public func deleteItem(itemId: String) async throws {"
    );
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("streaming fixture", () => {
  it("emits streaming upload/download and SSE operations, and builds", async () => {
    const outputDir = await compileFixture("streaming");
    const client = readFileSync(join(outputDir, "StreamingServiceClient.swift"), "utf8");
    expect(client).toContain(
      "public func uploadFile(bucket: String, contentType: String? = nil, body: HTTPBody, uploadProgress: ProgressHandler? = nil) async throws -> UploadResult {"
    );
    expect(client).toContain("builder.setBody(body)");
    expect(client).toContain(
      "try await transport.send(builder.build(), uploadProgress: uploadProgress)"
    );
    expect(client).toContain(
      "public func downloadFile(bucket: String) async throws -> HTTPResponseStream {"
    );
    expect(client).toContain("let stream = try await transport.stream(builder.build())");
    expect(client).toContain(
      "public func invokeFunction(name: String) async throws -> AsyncThrowingStream<FunctionEvent, any Error> {"
    );
    expect(client).toContain("stream.body.serverSentEvents()");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("accessModifier option", () => {
  it("emits internal declarations end-to-end when accessModifier is 'internal'", async () => {
    const outputDir = await compileFixture("basic-crud", { accessModifier: "internal" });
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    const client = readFileSync(join(outputDir, "BasicCrudServiceClient.swift"), "utf8");
    expect(models).toContain("internal struct Item: Codable, Sendable, Hashable {");
    expect(models).not.toContain("public struct Item");
    expect(client).toContain("internal struct BasicCrudServiceClient: Sendable {");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("generateRuntime option", () => {
  it("skips vendoring the runtime when generateRuntime is false", async () => {
    const outputDir = await compileFixture("basic-models", { generateRuntime: false });
    expect(existsSync(join(outputDir, "Runtime"))).toBe(false);
    expect(existsSync(join(outputDir, "Models.swift"))).toBe(true);
  });
});

describe("greedy-path fixture", () => {
  it("emits PathEncoding.greedy for {path+} segments and builds", async () => {
    const outputDir = await compileFixture("greedy-path");
    const client = readFileSync(join(outputDir, "GreedyPathServiceClient.swift"), "utf8");
    expect(client).toContain(
      'path: "/storage/\\(PathEncoding.segment(bucket))/\\(PathEncoding.greedy(path))"'
    );
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("maps-arrays fixture", () => {
  it("maps Array<T>, Record<string,V>, and optional properties, and builds", async () => {
    const outputDir = await compileFixture("maps-arrays");
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    expect(models).toContain("public var tags: [String]?");
    expect(models).toContain("public var metadata: [String: String]?");
    expect(models).toContain("public var children: [Item]?");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);

  it("converts an enum-typed query/header param to its .rawValue, and builds", async () => {
    const outputDir = await compileFixture("maps-arrays");
    const client = readFileSync(join(outputDir, "MapsArraysServiceClient.swift"), "utf8");
    expect(client).toContain(
      "public func listItems(status: ItemStatus? = nil, xStatus: ItemStatus? = nil) async throws -> [Item] {"
    );
    expect(client).toContain('builder.addQuery("status", status?.rawValue)');
    expect(client).toContain('builder.setHeader("x-status", xStatus?.rawValue)');
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("doc-comments fixture", () => {
  it("emits /// doc comments for models, properties, enums, enum members, unions, union variants, operations, and parameters, and builds", async () => {
    const outputDir = await compileFixture("doc-comments");
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    const client = readFileSync(join(outputDir, "DocCommentsServiceClient.swift"), "utf8");

    // Model + property.
    expect(models).toContain("/// An item in the catalog.\npublic struct Item");
    expect(models).toContain("    /// The item's unique identifier.\n    public var id: String");

    // Enum (openStruct default) + member.
    expect(models).toContain("/// The lifecycle status of an item.\npublic struct ItemStatus");
    expect(models).toContain(
      '    /// The item is active and visible.\n    public static let active = ItemStatus(rawValue: "Active")'
    );

    // Union + variant.
    expect(models).toContain("/// A polymorphic content block.\npublic indirect enum Content");
    expect(models).toContain("    /// Plain text content.\n    case text(String)");

    // Operation + parameter.
    expect(client).toContain("    /// Fetches an item by its identifier.\n");
    expect(client).toContain("    /// - Parameter itemId: The item's unique identifier.\n");
    expect(client).toContain("public func getItem(itemId: String) async throws -> Item {");

    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);

  it("emits doc comments on cases when enumStyle is 'enum'", async () => {
    const outputDir = await compileFixture("doc-comments", { enumStyle: "enum" });
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    expect(models).toContain(
      '    /// The item is active and visible.\n    case active = "Active"'
    );
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("keywords fixture", () => {
  it("escapes reserved Swift keyword members and uses dual-name init params, and builds", async () => {
    const outputDir = await compileFixture("keywords");
    const models = readFileSync(join(outputDir, "Models.swift"), "utf8");
    expect(models).toContain("public var `protocol`: String?");
    expect(models).toContain("public var `class`: String?");
    expect(models).toContain("public var `self`: String?");
    expect(models).toContain("public var `default`: Bool?");
    expect(models).toContain("`protocol` protocolValue: String? = nil");
    expect(models).toContain("self.`protocol` = protocolValue");
    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});
