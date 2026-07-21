import { createTypeSpecLibrary, type EmitContext, type JSONSchemaType } from "@typespec/compiler";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { copyRuntime } from "./runtime.ts";

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
  // Model/enum/union/client generation are wired in later tasks; this
  // skeleton only proves the runtime-copy plumbing end-to-end.
  if (options.generateRuntime) {
    copyRuntime(options.outputDir);
  }
}

export async function $onEmit(context: EmitContext<SwiftEmitterOptions>): Promise<void> {
  await runEmit(context);
}
