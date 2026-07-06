# TypeSpec → Swift Emitter: Design Spec

**Date:** 2026-07-06
**Status:** Approved

---

## 1. Goal

Build a general-purpose TypeSpec emitter that generates idiomatic, zero-dependency Swift HTTP clients. The emitter targets the HTTPRuntime defined in the spike (`grdsdev/spike-swift-supabase-code-generation`), which it inlines into the output directory alongside the generated files. No external Swift package dependencies are required by the generated code.

---

## 2. Package structure

```
http-client-swift/
├── package.json           # name: "typespec-swift"; exports $onEmit + CLI bin
├── tsconfig.json
├── src/
│   ├── index.ts           # $onEmit(EmitContext) + SwiftEmitterOptions
│   ├── type-emitter.ts    # SwiftTypeEmitter extends TypeEmitter<string>
│   ├── http-emitter.ts    # HTTP client generation (uses @typespec/http)
│   ├── naming.ts          # Swift keyword escaping, lowerCamelCase, etc.
│   └── runtime.ts         # Copies HTTPRuntime .swift assets to output
├── runtime/               # HTTPRuntime Swift sources (verbatim from spike)
│   └── *.swift            # ~12 files
└── test/
    ├── fixtures/           # .tsp test specs (one per edge-case group)
    ├── helpers/
    │   └── swift-build.ts  # writes Package.swift scaffold + spawns swift build
    └── emitter.test.ts     # Vitest, one test per fixture
```

---

## 3. Emitter integration

The package exports `$onEmit` as a TypeSpec plugin and also ships a CLI bin.

### 3.1 TypeSpec plugin (`tsp compile`)

Users add the emitter to `tspconfig.yaml`:

```yaml
emit:
  - typespec-swift
options:
  typespec-swift:
    outputDir: "{project-root}/Generated"
    accessModifier: public    # default; or "internal"
    generateRuntime: true     # default; set false to manage runtime separately
```

Invoked automatically by `tsp compile`.

### 3.2 CLI

```
npx typespec-swift <specDir> <outputDir> [--access-modifier internal] [--no-runtime]
```

The CLI calls `@typespec/compiler`'s `compile()` itself, then routes the compiled `Program` into the same emit path as the plugin.

### 3.3 Data flow

```
tsp compile               CLI
     │                     │
     ▼                     ▼
$onEmit(EmitContext)    compile(specDir)
     │                     │
     └──────────┬──────────┘
                ▼
     getAllHttpServices(program)     ← @typespec/http
                │
                ├──▶ SwiftTypeEmitter (TypeEmitter)
                │       modelDeclaration  → struct
                │       enumDeclaration   → enum
                │       unionDeclaration  → indirect enum
                │       scalarDeclaration → primitive / typealias
                │
                ├──▶ HTTP client generator (http-emitter.ts)
                │       per-operation → async throws func
                │
                └──▶ Runtime asset copier (runtime.ts)
                         runtime/*.swift → outputDir/Runtime/
```

---

## 4. Type emission — `SwiftTypeEmitter`

`SwiftTypeEmitter extends TypeEmitter<string, SwiftEmitterOptions>`. The output unit per type is a Swift declaration string. `AssetEmitter` aggregates all declarations into `Models.swift` and handles deduplication.

### 4.1 TypeSpec → Swift type mapping

| TypeSpec | Swift | Notes |
|---|---|---|
| `model Foo { ... }` | `public struct Foo: Codable, Sendable, Hashable` | memberwise init; dual-name params for reserved keywords |
| `@error model FooError` | `+ APIError` conformance | detected via `@error` decorator |
| `enum Status { Active }` | `public enum Status: String, Codable, Sendable, Hashable, CaseIterable` | raw value from spec member value |
| `union Content { text: string, nested: Item }` | `public indirect enum Content: Codable, Sendable, Hashable` | single-key-object Codable |
| `string / boolean / bytes` | `String / Bool / Data` | |
| `int32 / int64 / uint32 / uint64` | `Int32 / Int64` | |
| `float32 / float64` | `Float / Double` | |
| `utcDateTime / offsetDateTime` | `Date` | ISO-8601 via `JSONCoding` |
| `Array<T>` | `[T]` | model instantiation override |
| `Record<string, V>` | `[String: V]` | map override |
| `unknown` / `Record<unknown>` | `JSONValue` | free-form JSON via HTTPRuntime |
| Optional property `prop?: T` | `var prop: T?` | |

### 4.2 `TypeEmitter` dispatch methods

- **`modelDeclaration`** — emits `struct` body + memberwise init. Skips `@statusCode` and `@header` properties (handled by the HTTP emitter). Detects `@error` decorator to add `APIError` conformance. Reserved Swift keyword members (e.g. `protocol`, `class`, `self`, `default`) are backtick-escaped in declarations and use dual-label form in the init (`\`protocol\` protocolValue: String?`).
- **`enumDeclaration`** — emits `String`-raw-value enum. Normalises `SCREAMING_SNAKE` case names to `lowerCamelCase`.
- **`unionDeclaration`** — emits `indirect enum` with manual `Codable` conformance using the single-key-object try-each-key decode pattern. `indirect` is applied when any case holds a reference type (i.e. another named model/union).
- **`scalarDeclaration`** — walks `baseScalar` chain to find the nearest known primitive; custom scalars with no known base fall back to `String`.
- **`modelInstantiation`** — intercepts `Array<T>` → `[T]` and `Record<string, V>` → `[String: V]` before they reach `modelDeclaration`.

---

## 5. HTTP client generation — `http-emitter.ts`

A separate pass over `HttpOperation[]` from `getAllHttpServices(program)`. Produces `<ServiceName>Client.swift`. Does not use `TypeEmitter`.

### 5.1 Generated client shape

```swift
public struct <ServiceName>Client: Sendable {
    private let baseURL: URL
    private let transport: any HTTPTransport

    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) { ... }

    public func <operationName>(<params>) async throws<returnType> { ... }
}
```

### 5.2 Parameter binding → Swift

| `@typespec/http` binding | Swift emission |
|---|---|
| `@path` (simple) | `PathEncoding.segment(<name>)` interpolated into path literal |
| `@path` with `allowReserved` (greedy `{name}`) | `PathEncoding.greedy(<name>)` |
| `@query` (scalar) | `builder.addQuery("<wireName>", <valueExpr>)` |
| `@query` (array) | `builder.addQuery("<wireName>", <array>)` |
| `@header` | `builder.setHeader("<wireName>", <value>)` |
| JSON body (required) | `builder.setBody(.data(try JSONCoding.encoder.encode(payload)))` |
| JSON body (optional) | `if let payload { builder.setHeader(...); builder.setBody(...) }` |
| `bytes` / streaming body | `body: HTTPBody` param + `builder.setBody(body)` |

### 5.3 Response kind → return type

| Response | Return type | Transport call |
|---|---|---|
| JSON | `-> T` | `transport.send(builder.build())` → `JSONCoding.decoder.decode(T.self, from: response.body)` |
| Empty (204) | _(void)_ | `transport.send` + `checkStatus` |
| Streaming bytes | `-> HTTPResponseStream` | `transport.stream(builder.build())` + `ensureSuccess` |
| SSE event stream | `-> AsyncThrowingStream<EventUnion, Error>` | `transport.stream` → `.serverSentEvents()` → decode each frame |

### 5.4 SSE event union recovery

`@typespec/http` flattens `SSEStream<EventUnion>` to a `string` body. The emitter recovers the typed union by inspecting the operation's raw TypeSpec return type's template arguments — not from HTTP metadata. This is the same technique proven in the spike's `findEventUnion`.

### 5.5 Error table

```swift
try response.checkStatus(errorTypes: [404: NotFoundError.self, 422: ValidationError.self])
```

Built from each operation's `errors` array (`@typespec/http` `HttpOperationResponse` entries with non-2xx status codes).

### 5.6 Streaming upload progress

When request body kind is `bytes`, the operation receives an additional `uploadProgress: ProgressHandler? = nil` parameter and calls `transport.send(builder.build(), uploadProgress: uploadProgress)`.

---

## 6. Runtime asset bundling — `runtime.ts`

`copyRuntime(outputDir: string)` copies the 12 HTTPRuntime Swift source files from the emitter package's `runtime/` directory into `<outputDir>/Runtime/`. Called from both the plugin and CLI paths. Controlled by the `generateRuntime` option (default `true`).

HTTPRuntime files copied:
```
HTTPRequest.swift        HTTPResponse.swift       HTTPTransport.swift
HTTPError.swift          HTTPMethod.swift          JSONCoding.swift
JSONValue.swift          PathEncoding.swift        MultipartFormData.swift
ServerSentEvents.swift   TransferProgress.swift    URLSessionTransport.swift
```

**Output layout on disk:**

```
<outputDir>/
├── Models.swift
├── <ServiceName>Client.swift
└── Runtime/
    └── *.swift
```

The user's `Package.swift` declares:
```swift
.target(name: "HTTPRuntime", path: "Sources/Runtime"),
.target(name: "Generated", dependencies: ["HTTPRuntime"], path: "Sources/Generated"),
```

---

## 7. Emitter options

| Option | Type | Default | Description |
|---|---|---|---|
| `outputDir` | `string` | `{project-root}/tsp-output/swift` | Directory for all emitted files |
| `accessModifier` | `"public" \| "internal"` | `"public"` | Visibility of all generated declarations |
| `generateRuntime` | `boolean` | `true` | Whether to copy HTTPRuntime into `outputDir/Runtime/`. When `false`, generated code still emits `import HTTPRuntime` — the user must provide an `HTTPRuntime` Swift target from an external source. |

---

## 8. Testing

### 8.1 Strategy

Vitest end-to-end tests. Each test:
1. Compiles a `.tsp` fixture via the emitter
2. Writes output + a generated `Package.swift` scaffold to a temp directory
3. Spawns `swift build` on that directory
4. Asserts exit code 0

### 8.2 Test layout

```
test/
├── fixtures/
│   ├── basic-crud.tsp
│   ├── unions.tsp
│   ├── streaming.tsp
│   ├── keywords.tsp
│   ├── maps-arrays.tsp
│   └── greedy-path.tsp
├── helpers/
│   └── swift-build.ts     # creates temp Package.swift scaffold + runs swift build
└── emitter.test.ts        # one describe block per fixture
```

### 8.3 Temp dir scaffold (`swift-build.ts`)

```
<tmpDir>/
├── Package.swift
└── Sources/
    ├── Generated/
    │   ├── Models.swift
    │   └── <Name>Client.swift
    └── Runtime/
        └── *.swift
```

Generated `Package.swift`:
```swift
// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "GeneratedTest",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(name: "HTTPRuntime", path: "Sources/Runtime"),
        .target(name: "Generated", dependencies: ["HTTPRuntime"], path: "Sources/Generated"),
    ]
)
```

### 8.4 Edge-case fixture coverage

| Fixture | Edge cases covered |
|---|---|
| `basic-crud.tsp` | GET/POST/PUT/DELETE · JSON body · path params · query params · header params · typed errors · empty response |
| `unions.tsp` | Discriminated unions · recursive types (`indirect`) · `@error` models |
| `streaming.tsp` | SSE event streams · streaming binary upload with progress · streaming download |
| `keywords.tsp` | Reserved Swift keyword field names: `protocol`, `class`, `self`, `default` |
| `maps-arrays.tsp` | `Array<T>` · `Record<string, V>` · optional properties · enums as query params |
| `greedy-path.tsp` | Greedy path params (`{path+}`) · multipart upload |

### 8.5 CI requirements

Tests require both Node.js (≥22) and the Swift toolchain. CI runs on `macos-latest`. `package.json` documents the Swift version requirement.

---

## 9. Out of scope (this iteration)

- Authentication / interceptors
- Pagination helpers
- Retry / cancellation logic
- Background URLSession transfers
- Doc comment generation from TypeSpec `@doc`
- Second-language emitters (Kotlin, Python, etc.)
- `swift test` live HTTP tests against a mock server
