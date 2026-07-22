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
    perf: {
      startTimer: () => ({ end: () => 0 }),
      time: (_l: string, cb: () => any) => cb(),
      timeAsync: (_l: string, cb: () => any) => cb(),
    },
  } as any);

  console.log(`Generated Swift client into ${outputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
