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
