// Regenerates each fixture's emitted Swift output into
// `test/fixtures/<name>/generated/` for manual inspection. Not part of the
// automated test suite (which compiles into temp dirs) — run manually with
// `npm run generate:fixtures` whenever you want to eyeball emitter output.
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost } from "@typespec/compiler";
import { runEmit } from "../src/index.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function generateFixture(name: string): Promise<void> {
  const specDir = join(FIXTURES_DIR, name);
  const outputDir = join(specDir, "generated");

  const program = await compile(NodeHost, specDir, {});
  const fatal = program.diagnostics.filter((d) => d.severity === "error");
  if (fatal.length) {
    throw new Error(`${name}: TypeSpec compile errors:\n` + fatal.map((d) => d.message).join("\n"));
  }

  await runEmit({
    program,
    emitterOutputDir: outputDir,
    options: { outputDir, generateRuntime: false },
    perf: { startTimer: () => ({ end: () => 0 }), time: (_l, cb) => cb(), timeAsync: (_l, cb) => cb() },
  } as any);

  console.log(`generated ${name} -> ${outputDir}`);
}

const fixtures = readdirSync(FIXTURES_DIR).filter((f) => statSync(join(FIXTURES_DIR, f)).isDirectory());
for (const name of fixtures) {
  await generateFixture(name);
}
