import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE_SWIFT = `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "GeneratedTest",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(name: "HTTPRuntime", path: "Sources/Runtime"),
        .target(name: "Generated", dependencies: ["HTTPRuntime"], path: "Sources/Generated"),
    ]
)
`;

export interface SwiftBuildResult {
  dir: string;
  stdout: string;
}

/** Copies emitted Swift sources into a fresh temp SwiftPM package and runs
 * `swift build`. Throws (with the captured stdout/stderr) if the build fails. */
export function buildGeneratedSwift(outputDir: string): SwiftBuildResult {
  const dir = mkdtempSync(join(tmpdir(), "typespec-swift-"));
  writeFileSync(join(dir, "Package.swift"), PACKAGE_SWIFT);
  mkdirSync(join(dir, "Sources", "Generated"), { recursive: true });
  cpSync(outputDir, join(dir, "Sources", "Generated"), {
    recursive: true,
    filter: (src) => !src.includes(`${join(outputDir, "Runtime")}`),
  });
  cpSync(join(outputDir, "Runtime"), join(dir, "Sources", "Runtime"), { recursive: true });
  const stdout = execFileSync("swift", ["build", "--package-path", dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { dir, stdout };
}
