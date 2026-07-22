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
