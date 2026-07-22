import { createTypeSpecLibrary, type EmitContext, type JSONSchemaType } from "@typespec/compiler";
import { createAssetEmitter } from "@typespec/asset-emitter";
import { getAllHttpServices } from "@typespec/http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyRuntime } from "./runtime.ts";
import { SwiftTypeEmitter } from "./type-emitter.ts";
import { generateClient } from "./http-emitter.ts";

export interface SwiftEmitterOptions {
  outputDir?: string;
  accessModifier?: "public" | "internal";
  generateRuntime?: boolean;
  enumStyle?: "openStruct" | "enum";
}

const SwiftEmitterOptionsSchema: JSONSchemaType<SwiftEmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    outputDir: { type: "string", nullable: true },
    accessModifier: { type: "string", enum: ["public", "internal"], nullable: true },
    generateRuntime: { type: "boolean", nullable: true },
    enumStyle: { type: "string", enum: ["openStruct", "enum"], nullable: true },
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
  enumStyle: "openStruct" | "enum";
}

export function resolveOptions(context: EmitContext<SwiftEmitterOptions>): ResolvedSwiftEmitterOptions {
  return {
    outputDir: resolve(context.options.outputDir ?? context.emitterOutputDir),
    accessModifier: context.options.accessModifier ?? "public",
    generateRuntime: context.options.generateRuntime ?? true,
    enumStyle: context.options.enumStyle ?? "openStruct",
  };
}

/** Shared emit path used by both the `$onEmit` plugin hook and the CLI. */
export async function runEmit(context: EmitContext<SwiftEmitterOptions>): Promise<void> {
  const options = resolveOptions(context);
  mkdirSync(options.outputDir, { recursive: true });
  const assetEmitter = createAssetEmitter(context.program, SwiftTypeEmitter, {
    ...context,
    options,
  } as any);
  assetEmitter.emitProgram();
  await assetEmitter.writeOutput();

  const [services] = getAllHttpServices(context.program);
  if (services.length > 0) {
    const { filename, content } = generateClient(context.program, services[0], options);
    writeFileSync(join(options.outputDir, filename), content);
  }

  if (options.generateRuntime) {
    copyRuntime(options.outputDir);
  }
}

export async function $onEmit(context: EmitContext<SwiftEmitterOptions>): Promise<void> {
  await runEmit(context);
}
