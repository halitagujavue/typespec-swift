import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRuntime } from "../src/runtime.ts";

const EXPECTED_FILES = [
  "HTTPError.swift", "HTTPFile.swift", "HTTPMethod.swift", "HTTPRequest.swift", "HTTPResponse.swift",
  "HTTPTransport.swift", "JSONCoding.swift", "JSONValue.swift", "MultipartFormData.swift",
  "PathEncoding.swift", "ServerSentEvents.swift", "TransferProgress.swift", "URLSessionTransport.swift",
];

describe("copyRuntime", () => {
  it("copies all 13 HTTPRuntime files into <outputDir>/Runtime", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "typespec-swift-runtime-"));
    copyRuntime(outputDir);
    const runtimeDir = join(outputDir, "Runtime");
    expect(existsSync(runtimeDir)).toBe(true);
    const copied = readdirSync(runtimeDir).sort();
    expect(copied).toEqual(EXPECTED_FILES.sort());
  });
});
