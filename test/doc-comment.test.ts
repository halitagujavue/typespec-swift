import { describe, expect, it } from "vitest";
import { compile, NodeHost } from "@typespec/compiler";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docComment, paramDocLines, type DocParam } from "../src/doc-comment.ts";

// Temp dirs must live inside the repo tree (not os.tmpdir()) so TypeSpec's
// node module resolution can walk up to this package's node_modules.
const TMP_ROOT = join(import.meta.dirname, ".tmp-doc-comment");
mkdirSync(TMP_ROOT, { recursive: true });

async function compileSnippet(body: string) {
  const dir = mkdtempSync(join(TMP_ROOT, "case-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  writeFileSync(join(dir, "main.tsp"), `@service namespace Test;\n${body}`);
  const program = await compile(NodeHost, dir, {});
  const fatal = program.diagnostics.filter((d) => d.severity === "error");
  if (fatal.length) throw new Error(fatal.map((d) => d.message).join("\n"));
  return program;
}

describe("docComment", () => {
  it("returns empty string for undefined doc", () => {
    expect(docComment(undefined)).toBe("");
  });

  it("returns empty string for empty doc", () => {
    expect(docComment("")).toBe("");
  });

  it("formats a single-line doc with no indent", () => {
    expect(docComment("Hello.")).toBe("/// Hello.\n");
  });

  it("formats a multi-line doc, one /// per line, with indent", () => {
    expect(docComment("Line one.\nLine two.", "    ")).toBe(
      "    /// Line one.\n    /// Line two.\n"
    );
  });
});

describe("paramDocLines", () => {
  it("returns empty string when no params are given", async () => {
    const program = await compileSnippet(`model M { a: string; }`);
    const params: DocParam[] = [];
    expect(paramDocLines(program, params)).toBe("");
  });

  it("skips params whose docNode has no @doc", async () => {
    const program = await compileSnippet(`model M { a: string; }`);
    const prop = program.getGlobalNamespaceType().namespaces.get("Test")!.models.get("M")!.properties.get("a");
    const params: DocParam[] = [{ label: "x", docNode: prop }];
    expect(paramDocLines(program, params)).toBe("");
  });

  it("emits a - Parameter line for a param with its own @doc", async () => {
    const program = await compileSnippet(`model M {\n  /** The identifier. */\n  a: string;\n}`);
    const prop = program.getGlobalNamespaceType().namespaces.get("Test")!.models.get("M")!.properties.get("a");
    const params: DocParam[] = [{ label: "x", docNode: prop }];
    expect(paramDocLines(program, params, "    ")).toBe("    /// - Parameter x: The identifier.\n");
  });
});
