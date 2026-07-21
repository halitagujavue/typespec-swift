# TypeSpec → Swift Emitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `typespec-swift` emitter package: a TypeSpec plugin + CLI that generates idiomatic, dependency-free Swift HTTP clients (models + service client) and vendors the HTTPRuntime Swift sources into the output directory.

**Architecture:** `src/index.ts` exposes `$onEmit` (TypeSpec plugin entry point) and a shared `runEmit()` used by both the plugin and `src/cli.ts`. `runEmit()` calls `getAllHttpServices(program)`, then runs three independent passes: `SwiftTypeEmitter` (extends `CodeTypeEmitter` from `@typespec/asset-emitter`, dispatches on `modelDeclaration`/`enumDeclaration`/`unionDeclaration`/`scalarDeclaration`/`modelInstantiation` to build `Models.swift`), `generateClient()` in `http-emitter.ts` (a plain function over `HttpOperation[]` that builds `<ServiceName>Client.swift` — it does not use `TypeEmitter`), and `copyRuntime()` in `runtime.ts` (vendors the 12 HTTPRuntime files). Type-to-Swift conversion for individual TypeSpec types (scalars, `Array<T>`, `Record<string,V>`, model/enum/union references) is centralized in `type-mapping.ts` as a plain recursive function (`swiftTypeForType`), called by both `type-emitter.ts` and `http-emitter.ts` — this avoids needing the asset-emitter's cross-file reference/`Placeholder` machinery, since every declaration is emitted into a single `Models.swift` file where Swift requires no forward declarations.

**Tech Stack:** Node.js ≥22 (native TypeScript type-stripping, no build step for the emitter itself — matches the proven pattern in `grdsdev/spike-swift-supabase-code-generation/generator`), `@typespec/compiler` 1.13.0, `@typespec/http` 1.13.0, `@typespec/asset-emitter` 1.13.0, Vitest, Swift 6 toolchain (macOS).

## Global Constraints

- No external Swift package dependencies in generated code — only the vendored `HTTPRuntime` target (spec §1).
- `package.json` dependencies pinned exactly: `@typespec/compiler` 1.13.0, `@typespec/http` 1.13.0, `@typespec/asset-emitter` 1.13.0 (spec §2).
- `devDependencies` pinned exactly: `@typespec/rest` 0.83.0, `@typespec/sse` 0.83.0, `@typespec/events` 0.83.0, `@typespec/streams` 0.83.0 (spec §2).
- All generated declarations default to `public` visibility; `accessModifier` option (`"public" | "internal"`) controls this globally (spec §8).
- `outputDir` defaults to `{project-root}/tsp-output/swift`; `generateRuntime` defaults to `true` (spec §8).
- Every emitter test compiles a `.tsp` fixture, writes output + a `Package.swift` scaffold to a temp dir, and asserts `swift build` exits 0 (spec §9.1).
- Runtime source of truth for vendoring: `../swift-http-runtime/Sources/HTTPRuntime/*.swift` (12 files, cleaner and more current than the spike's copy — e.g. `HTTPResponse.body` is `AsyncThrowingStream<UInt8, any Error>` there, not `Data`).

---

## Task 1: Repo scaffold, emitter library skeleton, and Swift build test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts`
- Create: `test/helpers/swift-build.ts`
- Create: `test/helpers/compile-fixture.ts`
- Create: `test/fixtures/empty/main.tsp`
- Create: `test/fixtures/empty/package.json`
- Create: `test/emitter.test.ts`

**Interfaces:**
- Produces: `SwiftEmitterOptions` (`{ outputDir?: string; accessModifier?: "public" | "internal"; generateRuntime?: boolean }`), `runEmit(context: EmitContext<SwiftEmitterOptions>): Promise<void>`, `$onEmit(context: EmitContext<SwiftEmitterOptions>): Promise<void>` — all exported from `src/index.ts`. Every later task imports `runEmit` and `SwiftEmitterOptions` from here.
- Produces: `buildGeneratedSwift(generatedDir: string, runtimeDir: string): { dir: string; stdout: string }` from `test/helpers/swift-build.ts`.
- Produces: `compileFixture(name: string, options?: Partial<SwiftEmitterOptions>): Promise<string>` (returns the emitter's `outputDir`) from `test/helpers/compile-fixture.ts`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "typespec-swift",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "typespec-swift": "./src/cli.ts"
  },
  "exports": {
    ".": "./src/index.ts"
  },
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@typespec/compiler": "1.13.0",
    "@typespec/http": "1.13.0",
    "@typespec/asset-emitter": "1.13.0"
  },
  "devDependencies": {
    "@typespec/rest": "0.83.0",
    "@typespec/sse": "0.83.0",
    "@typespec/events": "0.83.0",
    "@typespec/streams": "0.83.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000, // swift build is slow
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
tsp-output/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 5: Write the emitter skeleton `src/index.ts`**

```ts
import { createTypeSpecLibrary, type EmitContext, type JSONSchemaType } from "@typespec/compiler";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface SwiftEmitterOptions {
  outputDir?: string;
  accessModifier?: "public" | "internal";
  generateRuntime?: boolean;
}

const SwiftEmitterOptionsSchema: JSONSchemaType<SwiftEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    outputDir: { type: "string", nullable: true },
    accessModifier: { type: "string", enum: ["public", "internal"], nullable: true },
    generateRuntime: { type: "boolean", nullable: true },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "typespec-swift",
  diagnostics: {},
  emitter: {
    options: SwiftEmitterOptionsSchema,
  },
});

/** Resolved, defaulted options — every downstream module reads these instead
 * of the raw (partial) `SwiftEmitterOptions`. */
export interface ResolvedSwiftEmitterOptions {
  outputDir: string;
  accessModifier: "public" | "internal";
  generateRuntime: boolean;
}

export function resolveOptions(context: EmitContext<SwiftEmitterOptions>): ResolvedSwiftEmitterOptions {
  return {
    outputDir: resolve(context.options.outputDir ?? context.emitterOutputDir),
    accessModifier: context.options.accessModifier ?? "public",
    generateRuntime: context.options.generateRuntime ?? true,
  };
}

/** Shared emit path used by both the `$onEmit` plugin hook and the CLI. */
export async function runEmit(context: EmitContext<SwiftEmitterOptions>): Promise<void> {
  const options = resolveOptions(context);
  mkdirSync(options.outputDir, { recursive: true });
  // Model/enum/union/client generation and runtime copying are wired in
  // later tasks; this skeleton only proves the plumbing end-to-end.
  if (options.generateRuntime) {
    const { copyRuntime } = await import("./runtime.ts");
    copyRuntime(options.outputDir);
  }
}

export async function $onEmit(context: EmitContext<SwiftEmitterOptions>): Promise<void> {
  await runEmit(context);
}
```

Note: `copyRuntime` doesn't exist yet — this step will fail to run until Task 3. That's expected; Step 6 below only checks that the package installs and type-checks, not that emission works yet. Task 4 replaces the dynamic `import("./runtime.ts")` with a static import once `runtime.ts` exists.

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: exits 0, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 7: Write the Swift build test helper `test/helpers/swift-build.ts`**

```ts
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_SWIFT = `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "GeneratedTest",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(name: "HTTPRuntime", path: "Sources/Runtime"),
        .target(name: "Generated", dependencies: ["HTTPRuntime"], path: "Sources/Generated"),
    ]
)
`;

export interface SwiftBuildResult {
  dir: string;
  stdout: string;
}

/** Copies emitted Swift sources into a fresh temp SwiftPM package and runs
 * `swift build`. Throws (with the captured stdout/stderr) if the build fails. */
export function buildGeneratedSwift(outputDir: string): SwiftBuildResult {
  const dir = mkdtempSync(join(tmpdir(), "typespec-swift-"));
  writeFileSync(join(dir, "Package.swift"), PACKAGE_SWIFT);
  mkdirSync(join(dir, "Sources", "Generated"), { recursive: true });
  cpSync(outputDir, join(dir, "Sources", "Generated"), {
    recursive: true,
    filter: (src) => !src.includes(`${join(outputDir, "Runtime")}`),
  });
  cpSync(join(outputDir, "Runtime"), join(dir, "Sources", "Runtime"), { recursive: true });
  const stdout = execFileSync("swift", ["build", "--package-path", dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { dir, stdout };
}
```

- [ ] **Step 8: Write the fixture-compile helper `test/helpers/compile-fixture.ts`**

```ts
import { compile, NodeHost } from "@typespec/compiler";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runEmit, type SwiftEmitterOptions } from "../../src/index.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Compiles `test/fixtures/<name>/main.tsp` with the emitter and returns the
 * resolved output directory (a fresh temp dir per call). */
export async function compileFixture(
  name: string,
  options: Partial<SwiftEmitterOptions> = {}
): Promise<string> {
  const specDir = join(FIXTURES_DIR, name);
  const outputDir = mkdtempSync(join(tmpdir(), "typespec-swift-out-"));
  const program = await compile(NodeHost, specDir, {});
  const fatal = program.diagnostics.filter((d) => d.severity === "error");
  if (fatal.length) {
    throw new Error("TypeSpec compile errors:\n" + fatal.map((d) => d.message).join("\n"));
  }
  await runEmit({
    program,
    emitterOutputDir: outputDir,
    options: { outputDir, ...options },
    perf: { startTimer: () => ({ end: () => 0 }), time: (_l, cb) => cb(), timeAsync: (_l, cb) => cb() },
  } as any);
  return outputDir;
}
```

- [ ] **Step 9: Write the empty fixture**

`test/fixtures/empty/package.json`:
```json
{ "name": "fixture-empty", "private": true, "type": "module" }
```

`test/fixtures/empty/main.tsp`:
```typespec
@service(#{ title: "EmptyService" })
namespace EmptyService;
```

- [ ] **Step 10: Write the smoke test `test/emitter.test.ts`**

```ts
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
```

This test will fail until Task 3 provides `runtime.ts` / vendored files — that's expected for now; do not attempt to make it pass in this task.

- [ ] **Step 11: Run the test to confirm it fails for the expected reason**

Run: `npx vitest run test/emitter.test.ts`
Expected: FAIL — `Cannot find module './runtime.ts'` (import inside `runEmit`). This confirms the plumbing is wired correctly and only the next task is missing.

- [ ] **Step 12: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/index.ts test/
git commit -m "feat: scaffold typespec-swift emitter package and swift-build test harness"
```

---

## Task 2: Naming utilities

**Files:**
- Create: `src/naming.ts`
- Test: `test/naming.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces: `isSwiftKeyword(name: string): boolean`, `escapeIdentifier(name: string): string` (backtick-escapes keywords), `internalParamName(name: string): string` (returns `` `name`Value `` for keywords, `name` otherwise — used as the dual-name init parameter), `enumCaseName(name: string): string` (normalizes `SCREAMING_SNAKE`/`snake_case` to `lowerCamelCase`), `lowerFirst(s: string): string`, `upperFirst(s: string): string`. Used by `type-emitter.ts` and `http-emitter.ts` in later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// test/naming.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/naming.test.ts`
Expected: FAIL with "Cannot find module '../src/naming.ts'"

- [ ] **Step 3: Write `src/naming.ts`**

```ts
const SWIFT_KEYWORDS = new Set([
  "protocol", "class", "self", "default", "enum", "struct", "func", "let", "var",
  "if", "else", "switch", "case", "for", "while", "return", "public", "private",
  "internal", "static", "init", "deinit", "extension", "import", "where", "as",
  "is", "in", "do", "try", "catch", "throw", "throws", "async", "await", "any",
  "some", "nil", "true", "false", "Type", "Protocol", "operator", "associatedtype",
]);

export function isSwiftKeyword(name: string): boolean {
  return SWIFT_KEYWORDS.has(name);
}

export function escapeIdentifier(name: string): string {
  return isSwiftKeyword(name) ? `\`${name}\`` : name;
}

export function internalParamName(name: string): string {
  return isSwiftKeyword(name) ? `${name}Value` : name;
}

export function upperFirst(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function lowerFirst(s: string): string {
  return s.length ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** Normalizes spec enum member names (often SCREAMING_SNAKE_CASE or
 * snake_case) to idiomatic lowerCamelCase Swift case names. The original wire
 * value is always preserved separately as the case's raw value. */
export function enumCaseName(name: string): string {
  const camel = /^[A-Z0-9_]+$/.test(name)
    ? name.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
    : name.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
  return lowerFirst(camel);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/naming.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/naming.ts test/naming.test.ts
git commit -m "feat: add Swift naming and keyword-escaping utilities"
```

---

## Task 3: Vendor HTTPRuntime sources and implement `copyRuntime`

**Files:**
- Create: `runtime/HTTPError.swift`, `runtime/HTTPMethod.swift`, `runtime/HTTPRequest.swift`, `runtime/HTTPResponse.swift`, `runtime/HTTPTransport.swift`, `runtime/JSONCoding.swift`, `runtime/JSONValue.swift`, `runtime/MultipartFormData.swift`, `runtime/PathEncoding.swift`, `runtime/ServerSentEvents.swift`, `runtime/TransferProgress.swift`, `runtime/URLSessionTransport.swift`
- Create: `src/runtime.ts`
- Modify: `src/index.ts` (replace the dynamic `import("./runtime.ts")` with a static import)
- Test: `test/runtime.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `copyRuntime(outputDir: string): void` — copies all `*.swift` files from the emitter package's `runtime/` directory into `<outputDir>/Runtime/`. Consumed by `runEmit()` in `src/index.ts` (already wired in Task 1).

- [ ] **Step 1: Vendor the runtime sources verbatim**

Run:
```bash
mkdir -p runtime
cp ../swift-http-runtime/Sources/HTTPRuntime/*.swift runtime/
rm -f runtime/.DS_Store
ls runtime/
```
Expected: 12 `.swift` files listed, no `.DS_Store`.

- [ ] **Step 2: Write the failing test**

```ts
// test/runtime.test.ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRuntime } from "../src/runtime.ts";

const EXPECTED_FILES = [
  "HTTPError.swift", "HTTPMethod.swift", "HTTPRequest.swift", "HTTPResponse.swift",
  "HTTPTransport.swift", "JSONCoding.swift", "JSONValue.swift", "MultipartFormData.swift",
  "PathEncoding.swift", "ServerSentEvents.swift", "TransferProgress.swift", "URLSessionTransport.swift",
];

describe("copyRuntime", () => {
  it("copies all 12 HTTPRuntime files into <outputDir>/Runtime", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "typespec-swift-runtime-"));
    copyRuntime(outputDir);
    const runtimeDir = join(outputDir, "Runtime");
    expect(existsSync(runtimeDir)).toBe(true);
    const copied = readdirSync(runtimeDir).sort();
    expect(copied).toEqual(EXPECTED_FILES.sort());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/runtime.test.ts`
Expected: FAIL with "Cannot find module '../src/runtime.ts'"

- [ ] **Step 4: Write `src/runtime.ts`**

```ts
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The `runtime/` directory ships alongside `src/` in the published package.
const RUNTIME_SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime");

/** Copies the vendored HTTPRuntime `.swift` sources into
 * `<outputDir>/Runtime/`, creating directories as needed. */
export function copyRuntime(outputDir: string): void {
  const destDir = join(outputDir, "Runtime");
  mkdirSync(destDir, { recursive: true });
  for (const file of readdirSync(RUNTIME_SOURCE_DIR)) {
    if (!file.endsWith(".swift")) continue;
    cpSync(join(RUNTIME_SOURCE_DIR, file), join(destDir, file));
  }
}
```

- [ ] **Step 5: Wire the static import in `src/index.ts`**

```ts
// Replace:
//   if (options.generateRuntime) {
//     const { copyRuntime } = await import("./runtime.ts");
//     copyRuntime(options.outputDir);
//   }
// With:
import { copyRuntime } from "./runtime.ts";
// ...
  if (options.generateRuntime) {
    copyRuntime(options.outputDir);
  }
```

(Add the `import { copyRuntime } from "./runtime.ts";` line near the top of `src/index.ts`, and replace the dynamic-import block inside `runEmit` with the plain `copyRuntime(options.outputDir);` call.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/runtime.test.ts`
Expected: PASS (1 test)

- [ ] **Step 7: Run the Task 1 smoke test — it should now pass**

Run: `npx vitest run test/emitter.test.ts`
Expected: PASS — the empty fixture now copies the runtime and `swift build` succeeds against an empty `Generated` target.

- [ ] **Step 8: Commit**

```bash
git add runtime/ src/runtime.ts src/index.ts test/runtime.test.ts
git commit -m "feat: vendor HTTPRuntime sources and implement copyRuntime"
```

---

## Task 4: Type mapping (`type-mapping.ts`)

**Files:**
- Create: `src/type-mapping.ts`
- Test: `test/type-mapping.test.ts`

**Interfaces:**
- Consumes: TypeSpec compiler `Type`, `Scalar`, `Program` from `@typespec/compiler`.
- Produces: `swiftTypeForType(type: any, program: any): string` — converts any TypeSpec type reachable from a model property, union variant, or operation parameter into a Swift type expression (e.g. `String`, `[Item]`, `[String: String]`, `Item?` is NOT handled here — optionality is applied by the caller). Consumed by `type-emitter.ts` (Task 5+) and `http-emitter.ts` (Task 9+).
- Produces: `resolveScalarChain(scalar: any): string` — walks `scalar.baseScalar` to the nearest known TypeSpec built-in scalar name and returns its Swift primitive name, defaulting to `"String"`.

- [ ] **Step 1: Write the failing test**

```ts
// test/type-mapping.test.ts
import { describe, expect, it } from "vitest";
import { compile, NodeHost } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swiftTypeForType } from "../src/type-mapping.ts";

async function compileSnippet(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "typespec-swift-typemap-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  writeFileSync(join(dir, "main.tsp"), `import "@typespec/http";\nusing Http;\n@service namespace Test;\n${body}`);
  const program = await compile(NodeHost, dir, {});
  const fatal = program.diagnostics.filter((d) => d.severity === "error");
  if (fatal.length) throw new Error(fatal.map((d) => d.message).join("\n"));
  return program;
}

function findModel(program: any, name: string) {
  const [services] = getAllHttpServices(program);
  const ns = services[0].namespace;
  return ns.models.get(name);
}

describe("swiftTypeForType", () => {
  it("maps built-in scalars", async () => {
    const program = await compileSnippet(`
      model M { a: string; b: boolean; c: int32; d: int64; e: float32; f: float64; g: bytes; h: utcDateTime; }
    `);
    const m = findModel(program, "M");
    const swiftOf = (name: string) => swiftTypeForType(m.properties.get(name).type, program);
    expect(swiftOf("a")).toBe("String");
    expect(swiftOf("b")).toBe("Bool");
    expect(swiftOf("c")).toBe("Int32");
    expect(swiftOf("d")).toBe("Int64");
    expect(swiftOf("e")).toBe("Float");
    expect(swiftOf("f")).toBe("Double");
    expect(swiftOf("g")).toBe("Data");
    expect(swiftOf("h")).toBe("Date");
  });

  it("maps Array<T> and Record<string, V>", async () => {
    const program = await compileSnippet(`
      model M { tags: string[]; meta: Record<string>; }
    `);
    const m = findModel(program, "M");
    expect(swiftTypeForType(m.properties.get("tags").type, program)).toBe("[String]");
    expect(swiftTypeForType(m.properties.get("meta").type, program)).toBe("[String: String]");
  });

  it("maps named model references by name", async () => {
    const program = await compileSnippet(`
      model Item { id: string; }
      model M { item: Item; }
    `);
    const m = findModel(program, "M");
    expect(swiftTypeForType(m.properties.get("item").type, program)).toBe("Item");
  });

  it("maps unknown to JSONValue", async () => {
    const program = await compileSnippet(`
      model M { data: unknown; }
    `);
    const m = findModel(program, "M");
    expect(swiftTypeForType(m.properties.get("data").type, program)).toBe("JSONValue");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/type-mapping.test.ts`
Expected: FAIL with "Cannot find module '../src/type-mapping.ts'"

- [ ] **Step 3: Write `src/type-mapping.ts`**

```ts
// Maps TypeSpec built-in scalar names to Swift primitive type names.
const SCALAR_MAP: Record<string, string> = {
  string: "String", url: "string" as any, uuid: "String",
  boolean: "Bool",
  bytes: "Data",
  int8: "Int32", int16: "Int32", int32: "Int32", uint8: "Int32", uint16: "Int32", uint32: "Int32",
  integer: "Int32", safeint: "Int64",
  int64: "Int64", uint64: "Int64",
  float32: "Float",
  float64: "Double", float: "Double", decimal: "Double", decimal128: "Double",
  utcDateTime: "Date", offsetDateTime: "Date", plainDate: "Date", plainTime: "Date", duration: "Date",
};
SCALAR_MAP.url = "String";

/** Walks a Scalar's `baseScalar` chain to the nearest TypeSpec built-in with a
 * known Swift mapping. Custom scalars with no known ancestor fall back to
 * `String`. */
export function resolveScalarChain(scalar: any): string {
  let s = scalar;
  while (s) {
    if (SCALAR_MAP[s.name]) return SCALAR_MAP[s.name];
    s = s.baseScalar;
  }
  return "String";
}

/** Converts any TypeSpec type reachable from a model property, union variant,
 * or operation parameter into a Swift type expression. Optionality (`?`) is
 * NOT applied here — callers append it based on `property.optional`. */
export function swiftTypeForType(type: any, program: any): string {
  if (!type) return "JSONValue";
  switch (type.kind) {
    case "Scalar":
      return resolveScalarChain(type);
    case "Model":
      if (type.name === "Array") return `[${swiftTypeForType(type.indexer?.value, program)}]`;
      if (type.name === "Record") return `[String: ${swiftTypeForType(type.indexer?.value, program)}]`;
      if (!type.name) return "JSONValue"; // anonymous model literal
      return type.name;
    case "Union":
      return type.name ?? "JSONValue";
    case "Enum":
      return type.name ?? "JSONValue";
    case "ModelProperty":
      return swiftTypeForType(type.type, program);
    case "Intrinsic":
    default:
      return "JSONValue";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/type-mapping.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/type-mapping.ts test/type-mapping.test.ts
git commit -m "feat: add TypeSpec-to-Swift type mapping"
```

---

## Task 5: `SwiftTypeEmitter` — model declarations (structs)

**Files:**
- Create: `src/type-emitter.ts`
- Modify: `src/index.ts` (wire `SwiftTypeEmitter` into `runEmit`, write `Models.swift`)
- Create: `test/fixtures/basic-models/main.tsp`
- Create: `test/fixtures/basic-models/package.json`
- Modify: `test/emitter.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `swiftTypeForType`, `resolveScalarChain` from `src/type-mapping.ts` (Task 4); `escapeIdentifier`, `internalParamName` from `src/naming.ts` (Task 2); `isStatusCode`, `isHeader` from `@typespec/http`; `isErrorModel` from `@typespec/compiler`.
- Produces: `class SwiftTypeEmitter extends CodeTypeEmitter<ResolvedSwiftEmitterOptions>` with a working `modelDeclaration`. Consumed by `runEmit()` in `src/index.ts`, which calls `createAssetEmitter(program, SwiftTypeEmitter, context)`, `assetEmitter.emitProgram()`, `assetEmitter.writeOutput()`.

- [ ] **Step 1: Write the fixture**

`test/fixtures/basic-models/package.json`:
```json
{ "name": "fixture-basic-models", "private": true, "type": "module" }
```

`test/fixtures/basic-models/main.tsp`:
```typespec
@service(#{ title: "BasicModelsService" })
namespace BasicModelsService;

model Item {
  id: string;
  name: string;
  quantity: int32;
  price: float64;
  inStock: boolean;
  createdAt: utcDateTime;
}
```

- [ ] **Step 2: Add the failing test to `test/emitter.test.ts`**

```ts
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
```

Add `import { readFileSync } from "node:fs";` to the top of `test/emitter.test.ts` alongside the existing imports, and replace the ad hoc `join()` helper with `import { join } from "node:path";`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/emitter.test.ts -t "basic-models"`
Expected: FAIL — `Models.swift` does not exist (nothing writes it yet).

- [ ] **Step 4: Write `src/type-emitter.ts`**

```ts
import { CodeTypeEmitter } from "@typespec/asset-emitter";
import { isErrorModel } from "@typespec/compiler";
import { isHeader, isStatusCode } from "@typespec/http";
import { escapeIdentifier, internalParamName, isSwiftKeyword } from "./naming.ts";
import { swiftTypeForType } from "./type-mapping.ts";
import type { ResolvedSwiftEmitterOptions } from "./index.ts";

function docComment(doc: string | undefined, indent = ""): string {
  if (!doc) return "";
  return doc.split("\n").map((l) => `${indent}/// ${l}`).join("\n") + "\n";
}

export class SwiftTypeEmitter extends CodeTypeEmitter<ResolvedSwiftEmitterOptions> {
  #modifier(): string {
    return this.emitter.getOptions().accessModifier;
  }

  programContext(program: any) {
    const sourceFile = this.emitter.createSourceFile("Models.swift");
    return { scope: sourceFile.globalScope };
  }

  modelDeclaration(model: any, name: string) {
    const program = this.emitter.getProgram();
    const modifier = this.#modifier();
    const bodyMembers: any[] = [];
    for (const prop of model.properties.values()) {
      if (isStatusCode(program, prop)) continue; // handled by http-emitter
      if (isHeader(program, prop)) continue; // handled by http-emitter
      bodyMembers.push(prop);
    }

    const protocols = isErrorModel(program, model)
      ? "Codable, Sendable, Hashable, APIError"
      : "Codable, Sendable, Hashable";

    let out = docComment(this.emitter.getProgram().stateSet ? undefined : undefined);
    out += `${modifier} struct ${name}: ${protocols} {\n`;
    for (const prop of bodyMembers) {
      const type = swiftTypeForType(prop.type, program) + (prop.optional ? "?" : "");
      out += `    ${modifier} var ${escapeIdentifier(prop.name)}: ${type}\n`;
    }

    // Memberwise init. Reserved-word members use Swift's dual-name parameter
    // form (`` `protocol` protocolValue: String? ``) so the call-site label is
    // preserved while the body avoids shadowing.
    const params = bodyMembers
      .map((prop) => {
        const type = swiftTypeForType(prop.type, program) + (prop.optional ? "?" : "");
        const label = isSwiftKeyword(prop.name)
          ? `${escapeIdentifier(prop.name)} ${internalParamName(prop.name)}`
          : escapeIdentifier(prop.name);
        return `${label}: ${type}${prop.optional ? " = nil" : ""}`;
      })
      .join(", ");
    out += `\n    ${modifier} init(${params}) {\n`;
    for (const prop of bodyMembers) {
      out += `        self.${escapeIdentifier(prop.name)} = ${internalParamName(prop.name)}\n`;
    }
    out += `    }\n`;
    out += `}\n`;

    return this.emitter.result.declaration(name, out);
  }
}
```

- [ ] **Step 5: Wire `SwiftTypeEmitter` and `Models.swift` writing into `src/index.ts`**

```ts
// Add near the other imports:
import { createAssetEmitter } from "@typespec/asset-emitter";
import { SwiftTypeEmitter } from "./type-emitter.ts";

// Inside runEmit, after resolving `options` and before/instead of the
// runtime-copy block, add:
  const assetEmitter = createAssetEmitter(context.program, SwiftTypeEmitter, {
    ...context,
    options,
  } as any);
  assetEmitter.emitProgram();
  await assetEmitter.writeOutput();
```

Keep the existing `if (options.generateRuntime) { copyRuntime(options.outputDir); }` block from Task 3 — both blocks run in `runEmit`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/emitter.test.ts -t "basic-models"`
Expected: PASS — `Models.swift` is written with the `Item` struct and `swift build` succeeds.

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS (all tests so far)

- [ ] **Step 8: Commit**

```bash
git add src/type-emitter.ts src/index.ts test/fixtures/basic-models test/emitter.test.ts
git commit -m "feat: emit Swift struct declarations for TypeSpec models"
```

---

## Task 6: `SwiftTypeEmitter` — enums and unions (indirect, Codable, `@error`)

**Files:**
- Modify: `src/type-emitter.ts` (add `enumDeclaration`, `unionDeclaration`)
- Create: `test/fixtures/unions/main.tsp`
- Create: `test/fixtures/unions/package.json`
- Modify: `test/emitter.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `swiftTypeForType` (Task 4), `escapeIdentifier` (Task 2), `isErrorModel` (already imported).
- Produces: `SwiftTypeEmitter.enumDeclaration`, `SwiftTypeEmitter.unionDeclaration` — no new exports beyond the class already produced in Task 5.

- [ ] **Step 1: Write the fixture**

`test/fixtures/unions/package.json`:
```json
{ "name": "fixture-unions", "private": true, "type": "module" }
```

`test/fixtures/unions/main.tsp`:
```typespec
@service(#{ title: "UnionsService" })
namespace UnionsService;

enum ItemStatus {
  active: "active",
  archived: "archived",
  pending: "pending",
}

union Content {
  text: string,
  number: float64,
  nested: Item,
}

model Item {
  id: string;
  status?: ItemStatus;
  content?: Content;
  /// Recursive: an item can reference child items (tree).
  children?: Item[];
}

@error
model NotFoundError {
  message: string;
}
```

- [ ] **Step 2: Add the failing test**

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/emitter.test.ts -t "unions"`
Expected: FAIL — `enumDeclaration`/`unionDeclaration` are not implemented, so `Models.swift` is missing `ItemStatus`/`Content`/`NotFoundError`.

- [ ] **Step 4: Add `enumDeclaration` and `unionDeclaration` to `src/type-emitter.ts`**

```ts
import { enumCaseName } from "./naming.ts";

// ... inside class SwiftTypeEmitter, after modelDeclaration:

  enumDeclaration(en: any, name: string) {
    const modifier = this.#modifier();
    let out = `${modifier} enum ${name}: String, Codable, Sendable, Hashable, CaseIterable {\n`;
    for (const member of en.members.values()) {
      const caseName = escapeIdentifier(enumCaseName(String(member.name)));
      const rawValue = JSON.stringify(String(member.value ?? member.name));
      out += `    case ${caseName} = ${rawValue}\n`;
    }
    out += `}\n`;
    return this.emitter.result.declaration(name, out);
  }

  unionDeclaration(union: any, name: string) {
    const program = this.emitter.getProgram();
    const modifier = this.#modifier();
    const variants = [...union.variants.values()];
    const needsIndirect = variants.some((v: any) => v.type.kind === "Model" || v.type.kind === "Union");
    const kw = needsIndirect ? "indirect enum" : "enum";

    let out = `${modifier} ${kw} ${name}: Codable, Sendable, Hashable {\n`;
    for (const v of variants) {
      const caseName = escapeIdentifier(String(v.name));
      out += `    case ${caseName}(${swiftTypeForType(v.type, program)})\n`;
    }

    // Single-key-object Codable conformance: try each case's key in turn.
    out += `\n    private enum CodingKeys: String, CodingKey {\n`;
    out += `        case ${variants.map((v: any) => escapeIdentifier(String(v.name))).join(", ")}\n`;
    out += `    }\n`;
    out += `\n    ${modifier} init(from decoder: any Decoder) throws {\n`;
    out += `        let container = try decoder.container(keyedBy: CodingKeys.self)\n`;
    for (const v of variants) {
      const caseName = escapeIdentifier(String(v.name));
      const type = swiftTypeForType(v.type, program);
      out += `        if let value = try container.decodeIfPresent(${type}.self, forKey: .${caseName}) {\n`;
      out += `            self = .${caseName}(value)\n`;
      out += `            return\n`;
      out += `        }\n`;
    }
    out += `        throw DecodingError.dataCorrupted(.init(\n`;
    out += `            codingPath: decoder.codingPath,\n`;
    out += `            debugDescription: "No known case key present for ${name}"\n`;
    out += `        ))\n`;
    out += `    }\n`;
    out += `\n    ${modifier} func encode(to encoder: any Encoder) throws {\n`;
    out += `        var container = encoder.container(keyedBy: CodingKeys.self)\n`;
    out += `        switch self {\n`;
    for (const v of variants) {
      const caseName = escapeIdentifier(String(v.name));
      out += `        case .${caseName}(let value): try container.encode(value, forKey: .${caseName})\n`;
    }
    out += `        }\n`;
    out += `    }\n`;
    out += `}\n`;
    return this.emitter.result.declaration(name, out);
  }
```

Also add `import { escapeIdentifier, enumCaseName, internalParamName, isSwiftKeyword } from "./naming.ts";` (merge with the existing naming import at the top of the file rather than duplicating it).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/emitter.test.ts -t "unions"`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all tests so far)

- [ ] **Step 7: Commit**

```bash
git add src/type-emitter.ts test/fixtures/unions test/emitter.test.ts
git commit -m "feat: emit Swift enums and indirect unions with Codable conformance"
```

---

## Task 7: `SwiftTypeEmitter` — arrays/maps/optionals and reserved keywords

**Files:**
- Modify: `src/type-emitter.ts` (add `modelInstantiation` guard)
- Create: `test/fixtures/maps-arrays/main.tsp`, `test/fixtures/maps-arrays/package.json`
- Create: `test/fixtures/keywords/main.tsp`, `test/fixtures/keywords/package.json`
- Modify: `test/emitter.test.ts` (add two `describe` blocks)

**Interfaces:**
- Consumes: everything from Tasks 4–6.
- Produces: `SwiftTypeEmitter.modelInstantiation` (defensive no-op for `Array<T>`/`Record<string,V>` — the actual `[T]`/`[String:V]` mapping already happens in `swiftTypeForType`, called from `modelDeclaration`; this guard only prevents the asset-emitter's default declaration behavior from ever emitting a spurious struct for a template instantiation reached via `emitProgram`'s namespace walk).

- [ ] **Step 1: Write the maps-arrays fixture**

`test/fixtures/maps-arrays/package.json`:
```json
{ "name": "fixture-maps-arrays", "private": true, "type": "module" }
```

`test/fixtures/maps-arrays/main.tsp`:
```typespec
@service(#{ title: "MapsArraysService" })
namespace MapsArraysService;

model Item {
  id: string;
  tags?: string[];
  metadata?: Record<string>;
  children?: Item[];
}
```

- [ ] **Step 2: Write the keywords fixture**

`test/fixtures/keywords/package.json`:
```json
{ "name": "fixture-keywords", "private": true, "type": "module" }
```

`test/fixtures/keywords/main.tsp`:
```typespec
@service(#{ title: "KeywordsService" })
namespace KeywordsService;

model Item {
  id: string;
  `protocol`?: string;
  `class`?: string;
  `self`?: string;
  `default`?: boolean;
}
```

- [ ] **Step 3: Add the failing tests**

```ts
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
```

- [ ] **Step 4: Run tests to verify current state**

Run: `npx vitest run test/emitter.test.ts -t "maps-arrays|keywords"`
Expected: The `maps-arrays` and `keywords` assertions on member/init text should already PASS (Task 5's `modelDeclaration` + Task 4's `swiftTypeForType` already handle these). If `swift build` fails or any text assertion fails, that reveals a bug in Task 5/6 to fix now — do not proceed until both fixtures build cleanly.

- [ ] **Step 5: Add the defensive `modelInstantiation` guard to `src/type-emitter.ts`**

```ts
  modelInstantiation(model: any, name: string | undefined) {
    // Array<T> and Record<string, V> are mapped to [T] / [String: V] inline by
    // swiftTypeForType() wherever they're referenced as a property type; they
    // must never surface as their own struct declaration.
    if (model.name === "Array" || model.name === "Record") {
      return this.emitter.result.none();
    }
    return super.modelInstantiation(model, name);
  }
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all tests so far)

- [ ] **Step 7: Commit**

```bash
git add src/type-emitter.ts test/fixtures/maps-arrays test/fixtures/keywords test/emitter.test.ts
git commit -m "feat: guard against spurious Array/Record instantiation declarations"
```

---

## Task 8: HTTP client generation — basic CRUD

**Files:**
- Create: `src/http-emitter.ts`
- Modify: `src/index.ts` (call `generateClient` and write `<ServiceName>Client.swift`)
- Create: `test/fixtures/basic-crud/main.tsp`, `test/fixtures/basic-crud/package.json`
- Modify: `test/emitter.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `getAllHttpServices`, `isStatusCode` (unused here), `HttpOperation` shapes from `@typespec/http`; `swiftTypeForType` (Task 4); `escapeIdentifier`, `lowerFirst` (Task 2).
- Produces: `generateClient(program: any, service: any, options: ResolvedSwiftEmitterOptions): { filename: string; content: string }` — takes one `HttpService` (from `getAllHttpServices(program)[0][0]`) and returns the `<ServiceName>Client.swift` file. Consumed by `runEmit()` in `src/index.ts`.

- [ ] **Step 1: Write the fixture**

`test/fixtures/basic-crud/package.json`:
```json
{ "name": "fixture-basic-crud", "private": true, "type": "module" }
```

`test/fixtures/basic-crud/main.tsp`:
```typespec
import "@typespec/http";
using Http;

@service(#{ title: "BasicCrudService" })
@route("/")
namespace BasicCrudService;

model Item {
  id: string;
  name: string;
}

model ItemInput {
  name: string;
}

@error
model NotFoundError {
  @statusCode statusCode: 404;
  message: string;
}

@error
model ValidationError {
  @statusCode statusCode: 422;
  message: string;
}

@route("/items/{itemId}")
@get
op getItem(@path itemId: string, @query include?: string, @header ifNoneMatch?: string): { @body item: Item } | NotFoundError;

@route("/items")
@post
op createItem(@body payload: ItemInput): { @statusCode statusCode: 201; @body item: Item } | ValidationError;

@route("/items/{itemId}")
@put
op updateItem(@path itemId: string, @body payload: ItemInput): { @body item: Item } | NotFoundError | ValidationError;

@route("/items/{itemId}")
@delete
op deleteItem(@path itemId: string): { @statusCode statusCode: 204 } | NotFoundError;
```

- [ ] **Step 2: Add the failing test**

```ts
describe("basic-crud fixture", () => {
  it("emits a Client.swift with CRUD operations and builds", async () => {
    const outputDir = await compileFixture("basic-crud");
    const client = readFileSync(join(outputDir, "BasicCrudServiceClient.swift"), "utf8");
    expect(client).toContain("public struct BasicCrudServiceClient: Sendable {");
    expect(client).toContain(
      "public func getItem(itemId: String, include: String? = nil, ifNoneMatch: String? = nil) async throws -> Item {"
    );
    expect(client).toContain('builder.addQuery("include", include)');
    expect(client).toContain('builder.setHeader("ifNoneMatch", ifNoneMatch)');
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/emitter.test.ts -t "basic-crud"`
Expected: FAIL — `BasicCrudServiceClient.swift` does not exist.

- [ ] **Step 4: Write `src/http-emitter.ts`**

```ts
import { isStatusCode, isHeader } from "@typespec/http";
import { escapeIdentifier, lowerFirst } from "./naming.ts";
import { swiftTypeForType } from "./type-mapping.ts";
import type { ResolvedSwiftEmitterOptions } from "./index.ts";

function docComment(doc: string | undefined, indent = ""): string {
  if (!doc) return "";
  return doc.split("\n").map((l) => `${indent}/// ${l}`).join("\n") + "\n";
}

interface ParamInfo {
  name: string;
  wireName: string;
  swiftType: string;
  required: boolean;
  greedy?: boolean;
}

function pathExpr(uri: string, labels: ParamInfo[]): string {
  let expr = uri;
  for (const p of labels) {
    const enc = p.greedy ? "greedy" : "segment";
    const replacement = `\\(PathEncoding.${enc}(${escapeIdentifier(p.name)}))`;
    expr = expr.replace(`{${p.name}+}`, replacement).replace(`{${p.name}}`, replacement);
  }
  return `"${expr}"`;
}

function queryValueExpr(p: ParamInfo): string {
  const name = escapeIdentifier(p.name);
  if (p.swiftType.endsWith("]")) return name; // array query params pass through
  switch (p.swiftType) {
    case "String":
      return name;
    case "Date":
      return p.required ? `JSONCoding.iso8601String(${name})` : `${name}.map(JSONCoding.iso8601String)`;
    default:
      // Enum refs use .rawValue; everything else uses String(...).
      return p.required ? `String(${name})` : `${name}.map(String.init)`;
  }
}

function emitOperation(program: any, httpOp: any, modifier: string): string {
  const opName = lowerFirst(httpOp.operation.name);
  const labels: ParamInfo[] = [];
  const queries: ParamInfo[] = [];
  const headers: ParamInfo[] = [];

  for (const p of httpOp.parameters.parameters) {
    const info: ParamInfo = {
      name: p.param.name,
      wireName: p.name,
      swiftType: swiftTypeForType(p.param.type, program),
      required: !p.param.optional,
      greedy: !!p.allowReserved,
    };
    if (p.type === "path") labels.push(info);
    else if (p.type === "query") queries.push(info);
    else if (p.type === "header") headers.push(info);
  }

  // Request body.
  let requestBodyKind: "json" | "streamingBlob" | "none" = "none";
  let payload: ParamInfo | undefined;
  const reqBody = httpOp.parameters.body;
  if (reqBody && reqBody.bodyKind === "single") {
    const bt = reqBody.type;
    if (bt?.kind === "Scalar" && swiftTypeForType(bt, program) === "Data") {
      requestBodyKind = "streamingBlob";
    } else {
      requestBodyKind = "json";
      payload = {
        name: reqBody.property?.name ?? "payload",
        wireName: "",
        swiftType: swiftTypeForType(bt, program),
        required: !(reqBody.property?.optional ?? false),
      };
    }
  }

  // Responses: success shape + error table.
  let responseKind: "json" | "empty" | "streamingBlob" | "eventStream" = "empty";
  let outputSwiftType = "JSONValue";
  const errors: { status: number; shape: string }[] = [];

  for (const resp of httpOp.responses) {
    const status = typeof resp.statusCodes === "number" ? resp.statusCodes : undefined;
    if (status === undefined) continue;
    const isSuccess = status >= 200 && status < 300;
    const content = resp.responses?.[0];
    const body = content?.body;
    if (isSuccess) {
      if (!body) {
        responseKind = "empty";
      } else {
        responseKind = "json";
        outputSwiftType = swiftTypeForType(body.type, program);
      }
    } else if (resp.type?.name) {
      errors.push({ status, shape: resp.type.name });
    }
  }

  const params: string[] = [];
  for (const p of [...labels, ...queries, ...headers]) {
    params.push(`${escapeIdentifier(p.name)}: ${p.swiftType}${p.required ? "" : "?"}${p.required ? "" : " = nil"}`);
  }
  if (requestBodyKind === "json" && payload) {
    params.push(`${escapeIdentifier(payload.name)}: ${payload.swiftType}${payload.required ? "" : "?"}${payload.required ? "" : " = nil"}`);
  }

  const returnType = responseKind === "json" ? ` -> ${outputSwiftType}` : "";
  const method = httpOp.verb.toLowerCase();
  const mutatesBuilder = queries.length > 0 || headers.length > 0 || requestBodyKind !== "none";
  const errorTable = errors.length
    ? "[" + errors.map((e) => `${e.status}: ${e.shape}.self`).join(", ") + "]"
    : "[:]";

  let out = docComment(undefined, "    ");
  out += `    ${modifier} func ${opName}(${params.join(", ")}) async throws${returnType} {\n`;
  out += `        ${mutatesBuilder ? "var" : "let"} builder = HTTPRequestBuilder(method: .${method}, baseURL: baseURL, path: ${pathExpr(httpOp.path, labels)})\n`;
  for (const q of queries) {
    out += `        builder.addQuery(${JSON.stringify(q.wireName)}, ${queryValueExpr(q)})\n`;
  }
  for (const h of headers) {
    out += `        builder.setHeader(${JSON.stringify(h.wireName)}, ${escapeIdentifier(h.name)})\n`;
  }
  if (requestBodyKind === "json" && payload) {
    if (payload.required) {
      out += `        builder.setHeader("Content-Type", "application/json")\n`;
      out += `        builder.setBody(.data(try JSONCoding.encoder.encode(${escapeIdentifier(payload.name)})))\n`;
    } else {
      out += `        if let ${escapeIdentifier(payload.name)} {\n`;
      out += `            builder.setHeader("Content-Type", "application/json")\n`;
      out += `            builder.setBody(.data(try JSONCoding.encoder.encode(${escapeIdentifier(payload.name)})))\n`;
      out += `        }\n`;
    }
  }

  if (responseKind === "json") {
    out += `        let response = try await transport.send(builder.build())\n`;
    out += `        try response.checkStatus(errorTypes: ${errorTable})\n`;
    out += `        return try JSONCoding.decoder.decode(${outputSwiftType}.self, from: response.body)\n`;
  } else if (responseKind === "empty") {
    out += `        let response = try await transport.send(builder.build())\n`;
    out += `        try response.checkStatus(errorTypes: ${errorTable})\n`;
  }
  out += `    }\n`;
  return out;
}

export function generateClient(
  program: any,
  service: any,
  options: ResolvedSwiftEmitterOptions
): { filename: string; content: string } {
  const clientName = `${service.namespace.name}Client`;
  const modifier = options.accessModifier;
  let out = `// Code generated by typespec-swift. DO NOT EDIT.\n\n`;
  out += `import Foundation\nimport HTTPRuntime\n\n`;
  out += `/// Generated client for ${service.namespace.name}. Depends only on HTTPRuntime.\n`;
  out += `${modifier} struct ${clientName}: Sendable {\n`;
  out += `    private let baseURL: URL\n`;
  out += `    private let transport: any HTTPTransport\n\n`;
  out += `    ${modifier} init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) {\n`;
  out += `        self.baseURL = baseURL\n`;
  out += `        self.transport = transport\n`;
  out += `    }\n\n`;

  const operations = [...service.operations].sort((a: any, b: any) =>
    a.operation.name.localeCompare(b.operation.name)
  );
  for (const httpOp of operations) {
    out += emitOperation(program, httpOp, modifier) + "\n";
  }
  out += `}\n`;

  return { filename: `${clientName}.swift`, content: out };
}
```

- [ ] **Step 5: Wire `generateClient` into `src/index.ts`**

```ts
// Add near the other imports:
import { writeFileSync } from "node:fs";
import { getAllHttpServices } from "@typespec/http";
import { generateClient } from "./http-emitter.ts";

// Inside runEmit, after the assetEmitter.writeOutput() call:
  const [services] = getAllHttpServices(context.program);
  if (services.length > 0) {
    const { filename, content } = generateClient(context.program, services[0], options);
    writeFileSync(join(options.outputDir, filename), content);
  }
```

Add `import { join } from "node:path";` to `src/index.ts` if not already present.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/emitter.test.ts -t "basic-crud"`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all tests so far)

- [ ] **Step 8: Commit**

```bash
git add src/http-emitter.ts src/index.ts test/fixtures/basic-crud test/emitter.test.ts
git commit -m "feat: generate HTTP client with basic CRUD operations"
```

---

## Task 9: HTTP client generation — streaming (bytes upload/download, SSE)

**Files:**
- Modify: `src/http-emitter.ts` (add `streamingBlob` request/response handling, SSE event-union recovery, upload progress)
- Create: `test/fixtures/streaming/main.tsp`, `test/fixtures/streaming/package.json`
- Modify: `test/emitter.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: everything from Task 8; adds `findEventUnion(httpOperation: any): string | undefined` (internal to `http-emitter.ts`) which inspects `httpOperation.returnType`'s template arguments to recover the event union name that `@typespec/http` flattens away.
- Produces: extended `emitOperation` covering `responseKind === "streamingBlob" | "eventStream"` and `requestBodyKind === "streamingBlob"` with `uploadProgress`.

- [ ] **Step 1: Write the fixture**

`test/fixtures/streaming/package.json`:
```json
{
  "name": "fixture-streaming",
  "private": true,
  "type": "module",
  "dependencies": {
    "@typespec/sse": "0.83.0",
    "@typespec/events": "0.83.0",
    "@typespec/streams": "0.83.0"
  }
}
```

`test/fixtures/streaming/main.tsp`:
```typespec
import "@typespec/http";
import "@typespec/streams";
import "@typespec/sse";
import "@typespec/events";

using Http;
using TypeSpec.Streams;
using TypeSpec.SSE;

@service(#{ title: "StreamingService" })
@route("/")
namespace StreamingService;

model UploadResult {
  key: string;
  size: int64;
}

@error
model ValidationError {
  @statusCode statusCode: 422;
  message: string;
}

model MessageEvent {
  delta: string;
}

model DoneEvent {
  total: int32;
}

@events
union FunctionEvent {
  message: MessageEvent,
  done: DoneEvent,
}

@route("/storage/{bucket}")
@post
op uploadFile(@path bucket: string, @header contentType?: string, @bodyRoot body: bytes): {
  @body result: UploadResult;
} | ValidationError;

@route("/storage/{bucket}")
@get
op downloadFile(@path bucket: string): {
  @bodyRoot body: bytes;
};

@route("/functions/{name}")
@post
op invokeFunction(@path name: string): SSEStream<FunctionEvent> | ValidationError;
```

- [ ] **Step 2: Add the failing test**

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/emitter.test.ts -t "streaming"`
Expected: FAIL — streaming/SSE operations aren't handled yet (`responseKind` stays `"empty"`/`"json"` incorrectly, or the operation body is wrong).

- [ ] **Step 4: Extend `src/http-emitter.ts`**

Replace the request-body detection block:
```ts
  // Request body.
  let requestBodyKind: "json" | "streamingBlob" | "none" = "none";
  let payload: ParamInfo | undefined;
  const reqBody = httpOp.parameters.body;
  if (reqBody && reqBody.bodyKind === "single") {
    const bt = reqBody.type;
    if (bt?.kind === "Scalar" && swiftTypeForType(bt, program) === "Data") {
      requestBodyKind = "streamingBlob";
    } else {
      requestBodyKind = "json";
      payload = {
        name: reqBody.property?.name ?? "payload",
        wireName: "",
        swiftType: swiftTypeForType(bt, program),
        required: !(reqBody.property?.optional ?? false),
      };
    }
  }
```
with the same block plus event-union recovery for the response side. Replace the whole responses block:
```ts
  // @typespec/http flattens `SSEStream<EventUnion>` to a `string` body, so the
  // typed event union is recovered from the operation's RAW return type, not
  // from the HTTP metadata (mirrors the OpenAPI fidelity loss).
  function findEventUnion(op: any): string | undefined {
    const rt = op.returnType;
    const candidates = rt?.kind === "Union" ? [...rt.variants.values()].map((v: any) => v.type) : [rt];
    for (const c of candidates) {
      if (c?.kind === "Model" && c.templateMapper?.args?.length) {
        const arg = c.templateMapper.args[0];
        if (arg?.kind === "Union" || arg?.kind === "Model") return arg.name;
      }
    }
    return undefined;
  }

  // Responses: success shape + error table.
  let responseKind: "json" | "empty" | "streamingBlob" | "eventStream" = "empty";
  let outputSwiftType = "JSONValue";
  let eventUnion: string | undefined;
  const errors: { status: number; shape: string }[] = [];

  for (const resp of httpOp.responses) {
    const status = typeof resp.statusCodes === "number" ? resp.statusCodes : undefined;
    if (status === undefined) continue;
    const isSuccess = status >= 200 && status < 300;
    const content = resp.responses?.[0];
    const body = content?.body;
    if (isSuccess) {
      const contentTypes: string[] = body?.contentTypes ?? [];
      if (!body) {
        responseKind = "empty";
      } else if (contentTypes.some((c) => c.includes("event-stream"))) {
        responseKind = "eventStream";
        eventUnion = findEventUnion(httpOp.operation);
      } else if (body.type?.kind === "Scalar" && swiftTypeForType(body.type, program) === "Data") {
        responseKind = "streamingBlob";
      } else {
        responseKind = "json";
        outputSwiftType = swiftTypeForType(body.type, program);
      }
    } else if (resp.type?.name) {
      errors.push({ status, shape: resp.type.name });
    }
  }
```

Add `body: HTTPBody` + `uploadProgress` parameters when the request body streams, add the `-> HTTPResponseStream` / `-> AsyncThrowingStream<EventUnion, any Error>` return types, and add the streaming/SSE emission bodies. Update the parameter-building and body sections:
```ts
  const params: string[] = [];
  for (const p of [...labels, ...queries, ...headers]) {
    params.push(`${escapeIdentifier(p.name)}: ${p.swiftType}${p.required ? "" : "?"}${p.required ? "" : " = nil"}`);
  }
  if (requestBodyKind === "json" && payload) {
    params.push(`${escapeIdentifier(payload.name)}: ${payload.swiftType}${payload.required ? "" : "?"}${payload.required ? "" : " = nil"}`);
  } else if (requestBodyKind === "streamingBlob") {
    params.push(`body: HTTPBody`);
    params.push(`uploadProgress: ProgressHandler? = nil`);
  }

  let returnType = "";
  if (responseKind === "json") returnType = ` -> ${outputSwiftType}`;
  else if (responseKind === "streamingBlob") returnType = ` -> HTTPResponseStream`;
  else if (responseKind === "eventStream") returnType = ` -> AsyncThrowingStream<${eventUnion}, any Error>`;
```

And extend the body-emission `if` chain:
```ts
  } else if (requestBodyKind === "streamingBlob") {
    out += `        builder.setBody(body)\n`;
  }

  if (responseKind === "json") {
    const send = requestBodyKind === "streamingBlob"
      ? `try await transport.send(builder.build(), uploadProgress: uploadProgress)`
      : `try await transport.send(builder.build())`;
    out += `        let response = ${send}\n`;
    out += `        try response.checkStatus(errorTypes: ${errorTable})\n`;
    out += `        return try JSONCoding.decoder.decode(${outputSwiftType}.self, from: response.body)\n`;
  } else if (responseKind === "empty") {
    const send = requestBodyKind === "streamingBlob"
      ? `try await transport.send(builder.build(), uploadProgress: uploadProgress)`
      : `try await transport.send(builder.build())`;
    out += `        let response = ${send}\n`;
    out += `        try response.checkStatus(errorTypes: ${errorTable})\n`;
  } else if (responseKind === "streamingBlob") {
    out += `        let stream = try await transport.stream(builder.build())\n`;
    out += `        try await Self.ensureSuccess(stream, errorTypes: ${errorTable})\n`;
    out += `        return stream\n`;
  } else if (responseKind === "eventStream") {
    out += `        let stream = try await transport.stream(builder.build())\n`;
    out += `        try await Self.ensureSuccess(stream, errorTypes: ${errorTable})\n`;
    out += `        let frames = stream.body.serverSentEvents()\n`;
    out += `        return AsyncThrowingStream<${eventUnion}, any Error> { continuation in\n`;
    out += `            let task = Task {\n`;
    out += `                do {\n`;
    out += `                    for try await frame in frames {\n`;
    out += `                        guard let data = frame.data.data(using: .utf8) else { continue }\n`;
    out += `                        continuation.yield(try JSONCoding.decoder.decode(${eventUnion}.self, from: data))\n`;
    out += `                    }\n`;
    out += `                    continuation.finish()\n`;
    out += `                } catch {\n`;
    out += `                    continuation.finish(throwing: error)\n`;
    out += `                }\n`;
    out += `            }\n`;
    out += `            continuation.onTermination = { _ in task.cancel() }\n`;
    out += `        }\n`;
  }
```

Finally, add the shared `ensureSuccess` helper to `generateClient`'s output, right before the closing `}`:
```ts
  const usesStreaming = operations.some(
    (op: any) => /* recompute or track a flag while looping above */ false
  );
```
Rather than conditionally detecting usage, always emit the helper — it's small and unused-helper warnings don't fail `swift build`. Add, just before `out += \`}\n\`;` at the end of `generateClient`:
```ts
  out += `    private static func ensureSuccess(\n`;
  out += `        _ stream: HTTPResponseStream,\n`;
  out += `        errorTypes: [Int: any APIError.Type]\n`;
  out += `    ) async throws {\n`;
  out += `        guard !stream.head.isSuccess else { return }\n`;
  out += `        var data = Data()\n`;
  out += `        for try await chunk in stream.body { data.append(chunk) }\n`;
  out += `        try HTTPResponse(head: stream.head, body: data).checkStatus(errorTypes: errorTypes)\n`;
  out += `    }\n`;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/emitter.test.ts -t "streaming"`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all tests so far — confirm `basic-crud` still passes now that `ensureSuccess` is always emitted)

- [ ] **Step 7: Commit**

```bash
git add src/http-emitter.ts test/fixtures/streaming test/emitter.test.ts
git commit -m "feat: generate streaming upload/download and SSE event-stream operations"
```

---

## Task 10: HTTP client generation — greedy path params

**Files:**
- Create: `test/fixtures/greedy-path/main.tsp`, `test/fixtures/greedy-path/package.json`
- Modify: `test/emitter.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `pathExpr`, `emitOperation` from Task 8/9 (greedy path handling — `p.allowReserved` → `PathEncoding.greedy` — was already implemented generically in Task 8's `pathExpr`/`ParamInfo.greedy`; this task is a verification/fixture task, not a new-code task, unless it uncovers a bug).

**Scoping note:** The design spec's fixture table lists "multipart upload" for this fixture, but §6 (parameter binding / request body kinds) defines only `json` and `bytes`/streaming request bodies — no multipart body kind is specified anywhere in the design. This plan resolves that gap by testing greedy path params together with the streaming byte-upload path (already built in Task 9) rather than inventing an undesigned multipart code path. `MultipartFormData.swift` ships in the vendored runtime for future/manual use but generated operations do not construct it in this iteration.

- [ ] **Step 1: Write the fixture**

`test/fixtures/greedy-path/package.json`:
```json
{ "name": "fixture-greedy-path", "private": true, "type": "module" }
```

`test/fixtures/greedy-path/main.tsp`:
```typespec
import "@typespec/http";
using Http;

@service(#{ title: "GreedyPathService" })
@route("/")
namespace GreedyPathService;

model UploadResult {
  key: string;
}

@error
model NotFoundError {
  @statusCode statusCode: 404;
  message: string;
}

@route("/storage/{bucket}/{path+}")
@post
op uploadFile(@path bucket: string, @path path: string, @bodyRoot body: bytes): {
  @body result: UploadResult;
} | NotFoundError;

@route("/storage/{bucket}/{path+}")
@get
op downloadFile(@path bucket: string, @path path: string): {
  @bodyRoot body: bytes;
} | NotFoundError;
```

- [ ] **Step 2: Add the failing test**

```ts
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
```

- [ ] **Step 3: Run test**

Run: `npx vitest run test/emitter.test.ts -t "greedy-path"`
Expected: This should PASS immediately given Task 8/9's implementation, since `p.allowReserved` (set from `@typespec/http`'s parameter metadata for `{path+}` segments) already drives `PathEncoding.greedy` in `pathExpr`. If it fails, fix `pathExpr`/`ParamInfo` in `src/http-emitter.ts` until it passes — do not add new abstractions, this is a bugfix against existing code.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all tests so far)

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/greedy-path test/emitter.test.ts
git commit -m "test: cover greedy path parameter encoding"
```

---

## Task 11: CLI, `accessModifier` end-to-end verification, and `generateRuntime: false`

**Files:**
- Create: `src/cli.ts`
- Modify: `package.json` (already declares the `bin` entry from Task 1 — no change needed unless the shebang requires `chmod +x`)
- Modify: `test/emitter.test.ts` (add two `describe` blocks: `accessModifier: "internal"`, `generateRuntime: false`)

**Interfaces:**
- Consumes: `compile`, `NodeHost` from `@typespec/compiler`; `runEmit` from `src/index.ts`.
- Produces: a runnable CLI: `npx typespec-swift <specDir> <outputDir> [--access-modifier internal] [--no-runtime]`.

- [ ] **Step 1: Write `src/cli.ts`**

```ts
#!/usr/bin/env node
import { compile, NodeHost } from "@typespec/compiler";
import { runEmit, type SwiftEmitterOptions } from "./index.ts";

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const [specDir, outputDir] = positional;

  if (!specDir || !outputDir) {
    console.error("usage: typespec-swift <specDir> <outputDir> [--access-modifier internal] [--no-runtime]");
    process.exit(1);
  }

  const accessModifierFlagIndex = args.indexOf("--access-modifier");
  const accessModifier =
    accessModifierFlagIndex >= 0 ? (args[accessModifierFlagIndex + 1] as "public" | "internal") : undefined;
  const generateRuntime = !args.includes("--no-runtime");

  const options: SwiftEmitterOptions = { outputDir, accessModifier, generateRuntime };

  const program = await compile(NodeHost, specDir, {});
  const fatal = program.diagnostics.filter((d) => d.severity === "error");
  if (fatal.length) {
    console.error("TypeSpec compile errors:\n" + fatal.map((d) => d.message).join("\n"));
    process.exit(1);
  }

  await runEmit({
    program,
    emitterOutputDir: outputDir,
    options,
    perf: { startTimer: () => ({ end: () => 0 }), time: (_l: string, cb: () => any) => cb(), timeAsync: (_l: string, cb: () => any) => cb() },
  } as any);

  console.log(`Generated Swift client into ${outputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Run: `chmod +x src/cli.ts`

- [ ] **Step 2: Add the failing `accessModifier` test**

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/emitter.test.ts -t "accessModifier"`
Expected: FAIL — `resolveOptions` in `src/index.ts` already threads `accessModifier` through, so investigate: if this fails, the bug is that `compileFixture`'s `runEmit` invocation in Task 1's helper passes `options` directly as `context.options` without merging the caller's override correctly. Confirm `test/helpers/compile-fixture.ts`'s `options: { outputDir, ...options }` line places `...options` after `outputDir`, so `accessModifier: "internal"` from the test call overrides correctly. If the test still fails, it means `type-emitter.ts`/`http-emitter.ts` aren't reading `this.emitter.getOptions().accessModifier` / `options.accessModifier` correctly — fix those call sites, not the test.

- [ ] **Step 4: Fix any remaining hardcoded `"public"` occurrences**

Run: `grep -rn '"public"' src/type-emitter.ts src/http-emitter.ts`
Expected: no matches — every occurrence must read from `this.#modifier()` / the `modifier` parameter. If any literal `"public"` remains, replace it with the resolved modifier.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/emitter.test.ts -t "accessModifier"`
Expected: PASS

- [ ] **Step 6: Add and run the `generateRuntime: false` test**

```ts
describe("generateRuntime option", () => {
  it("skips vendoring the runtime when generateRuntime is false", async () => {
    const outputDir = await compileFixture("basic-models", { generateRuntime: false });
    expect(existsSync(join(outputDir, "Runtime"))).toBe(false);
    expect(existsSync(join(outputDir, "Models.swift"))).toBe(true);
  });
});
```

Add `import { existsSync } from "node:fs";` to `test/emitter.test.ts`.

Run: `npx vitest run test/emitter.test.ts -t "generateRuntime"`
Expected: PASS (the `if (options.generateRuntime)` guard from Task 1/3 already covers this)

- [ ] **Step 7: Verify the CLI works standalone**

Run:
```bash
mkdir -p /tmp/typespec-swift-cli-check
node src/cli.ts test/fixtures/basic-crud /tmp/typespec-swift-cli-check
ls /tmp/typespec-swift-cli-check
```
Expected: prints `Generated Swift client into /tmp/typespec-swift-cli-check`; directory contains `Models.swift`, `BasicCrudServiceClient.swift`, `Runtime/`.

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all tests)

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts test/emitter.test.ts
git commit -m "feat: add CLI entry point and verify accessModifier/generateRuntime options end-to-end"
```

---

## Task 12: CI workflow and README

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (infra/docs only).
- Produces: nothing consumed by other tasks — this is the final task.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm install
      - run: npx vitest run
```

- [ ] **Step 2: Write `README.md`**

```markdown
# typespec-swift

A TypeSpec emitter that generates idiomatic, zero-dependency Swift HTTP clients.

## Requirements

- Node.js ≥ 22
- Swift 6 toolchain (macOS) — required to run the test suite, which compiles
  generated fixtures with `swift build`.

## Usage

### As a TypeSpec emitter

```yaml
# tspconfig.yaml
emit:
  - typespec-swift
options:
  typespec-swift:
    outputDir: "{project-root}/Generated"
    accessModifier: public
    generateRuntime: true
```

```
npx tsp compile .
```

### As a CLI

```
npx typespec-swift <specDir> <outputDir> [--access-modifier internal] [--no-runtime]
```

## Development

```
npm install
npx vitest run
```

See `docs/superpowers/specs/2026-07-06-typespec-swift-emitter-design.md` for
the full design.
```

- [ ] **Step 3: Run the full suite one final time**

Run: `npx vitest run`
Expected: PASS (all tests across all fixtures — `empty`, `basic-models`, `unions`, `maps-arrays`, `keywords`, `basic-crud`, `streaming`, `greedy-path`, `accessModifier`, `generateRuntime`)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "chore: add CI workflow and README"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (goal) — Tasks 1–11 collectively. §2 (dependencies) — Task 1. §3 (package structure) — Tasks 1, 3, 8. §4 (emitter integration: plugin + CLI + data flow) — Tasks 1, 11. §5 (type emission) — Tasks 4–7. §6 (HTTP client generation) — Tasks 8–10. §7 (runtime bundling) — Task 3. §8 (emitter options) — Tasks 1, 11. §9 (testing strategy/layout/fixtures/CI) — all tasks + Task 12. §10 (out of scope) — intentionally not implemented.
- **Known scoping resolution:** the "multipart upload" line item in spec §9.4's `greedy-path.tsp` row has no corresponding behavior defined in §6; Task 10 documents this and substitutes greedy-path + streaming-bytes coverage, which exercises the same runtime surface (`MultipartFormData.swift` ships vendored but unused by codegen this iteration).
- **Type/signature consistency:** `SwiftEmitterOptions` (partial, user-facing) vs `ResolvedSwiftEmitterOptions` (defaulted, internal) are used consistently: `src/index.ts` produces both; `type-emitter.ts` and `http-emitter.ts` only ever consume `ResolvedSwiftEmitterOptions` via `this.emitter.getOptions()` or a passed `options` parameter. `generateClient(program, service, options)` signature is introduced in Task 8 and never changes shape afterward (Task 9 only edits its body). `swiftTypeForType(type, program)` signature from Task 4 is used unchanged in Tasks 5, 6, 8, 9.
