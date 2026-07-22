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

describe("multipart fixture", () => {
  it("flattens parts into parameters, builds multipart bodies, and builds", async () => {
    const outputDir = await compileFixture("multipart");
    const client = readFileSync(join(outputDir, "MultipartServiceClient.swift"), "utf8");

    // uploadProfile: plain + multi + file part bundled into HTTPFile.
    expect(client).toContain(
      "public func uploadProfile(name: String, tags: [String], avatar: HTTPFile, uploadProgress: ProgressHandler? = nil) async throws -> UploadResult {"
    );
    expect(client).toContain('multipart.append(.init(name: "name", source: .data(Data(name.utf8))))');
    expect(client).toContain("for value in tags {");
    expect(client).toContain('multipart.append(.init(name: "tags", source: .data(Data(value.utf8))))');
    expect(client).toContain(
      'multipart.append(.init(name: "avatar", filename: avatar.resolvedFilename(), contentType: avatar.resolvedContentType(), source: avatar.asHTTPBody()))'
    );
    expect(client).toContain('builder.setHeader("Content-Type", multipart.contentType)');
    expect(client).toContain("let multipartFile = try multipart.writeToTemporaryFile()");
    expect(client).toContain("defer { try? FileManager.default.removeItem(at: multipartFile) }");
    expect(client).toContain("builder.setBody(.file(multipartFile))");
    expect(client).toContain(
      "let response = try await transport.send(builder.build(), uploadProgress: uploadProgress)"
    );

    // uploadRaw: bare HttpPart<bytes>, static single content type as fallback.
    expect(client).toContain(
      "public func uploadRaw(raw: HTTPFile, uploadProgress: ProgressHandler? = nil) async throws -> UploadResult {"
    );
    expect(client).toContain(
      'multipart.append(.init(name: "raw", filename: raw.resolvedFilename(), contentType: raw.resolvedContentType(fallback: "application/octet-stream"), source: raw.asHTTPBody()))'
    );

    // uploadMetadata: plain parts only (one optional) -> in-memory encode(), no uploadProgress.
    expect(client).toContain(
      "public func uploadMetadata(name: String, description: String? = nil) async throws -> UploadResult {"
    );
    expect(client).toContain("if let description {");
    expect(client).toContain('multipart.append(.init(name: "description", source: .data(Data(description.utf8))))');
    expect(client).toContain("builder.setBody(.data(try multipart.encode()))");
    expect(client).not.toContain("uploadMetadata(name: String, description: String? = nil, uploadProgress");

    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);
});

describe("interfaces fixture", () => {
  it("groups operations by interface into nested sub-clients with protocols, and builds", async () => {
    const outputDir = await compileFixture("interfaces");
    const client = readFileSync(join(outputDir, "ShopServiceClient.swift"), "utf8");

    // Protocols.
    expect(client).toContain("public protocol UsersAPI: Sendable {");
    expect(client).toContain("public protocol OrdersAPI: Sendable {");
    expect(client).toContain("public protocol AItemsAPI: Sendable {");
    expect(client).toContain("public protocol BItemsAPI: Sendable {");
    // Protocol requirements have no modifier, no body, no defaults.
    expect(client).toContain("    func list() async throws -> [Item]\n");

    // Top-level client: sub-client properties + instantiation in init.
    expect(client).toContain("public struct ShopServiceClient: Sendable {");
    expect(client).toContain("public let aItems: AItems");
    expect(client).toContain("public let bItems: BItems");
    expect(client).toContain("public let orders: Orders");
    expect(client).toContain("public let users: Users");
    expect(client).toContain("self.users = Users(baseURL: baseURL, transport: transport)");
    expect(client).toContain("self.orders = Orders(baseURL: baseURL, transport: transport)");
    expect(client).toContain("self.aItems = AItems(baseURL: baseURL, transport: transport)");
    expect(client).toContain("self.bItems = BItems(baseURL: baseURL, transport: transport)");

    // Bare operation stays flat on the top-level client.
    expect(client).toContain("public func health() async throws {");

    // Nested structs conform to their protocol and re-declare list().
    expect(client).toContain("public struct Users: UsersAPI, Sendable {");
    expect(client).toContain("public struct Orders: OrdersAPI, Sendable {");
    expect(client).toContain("public struct AItems: AItemsAPI, Sendable {");
    expect(client).toContain("public struct BItems: BItemsAPI, Sendable {");
    // Both nested structs' `list()` methods coexist without collision
    // (this is the bug fix — previously this produced two identical
    // `func list()` declarations directly on one struct).
    const listMatches = client.match(/public func list\(\) async throws -> \[Item\] \{/g);
    expect(listMatches?.length).toBe(4); // Users, Orders, AItems, BItems

    const { stdout } = buildGeneratedSwift(outputDir);
    expect(stdout).toBeDefined();
  }, 120_000);

  it("omits protocols but keeps nested structs when generateProtocols is false", async () => {
    const outputDir = await compileFixture("interfaces", { generateProtocols: false });
    const client = readFileSync(join(outputDir, "ShopServiceClient.swift"), "utf8");
    expect(client).not.toContain("protocol UsersAPI");
    expect(client).not.toContain("protocol OrdersAPI");
    expect(client).toContain("public struct Users: Sendable {");
    expect(client).toContain("public struct Orders: Sendable {");
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
