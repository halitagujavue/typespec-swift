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
