import { describe, expect, it } from "vitest";
import { compile, NodeHost } from "@typespec/compiler";
import { getAllHttpServices } from "@typespec/http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { swiftTypeForType } from "../src/type-mapping.ts";

// Temp dirs must live inside the repo tree (not os.tmpdir()) so TypeSpec's
// node module resolution can walk up to this package's node_modules for
// "@typespec/http".
const TMP_ROOT = join(import.meta.dirname, ".tmp-type-mapping");
mkdirSync(TMP_ROOT, { recursive: true });

async function compileSnippet(body: string) {
  const dir = mkdtempSync(join(TMP_ROOT, "case-"));
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
