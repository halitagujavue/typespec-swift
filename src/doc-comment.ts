import { getDoc } from "@typespec/compiler";

/** Formats a `@doc` string as a Swift `///` block, one line per input line.
 * Returns `""` for `undefined`/empty input — callers can always concatenate
 * the result directly with no extra blank-line handling. */
export function docComment(doc: string | undefined, indent = ""): string {
  if (!doc) return "";
  return doc.split("\n").map((l) => `${indent}/// ${l}`).join("\n") + "\n";
}

/** One entry in a `paramDocLines()` call: `label` is the exact
 * escaped/backticked name used in the generated function signature;
 * `docNode` is the TypeSpec node (`ModelProperty`, etc.) to read `@doc`
 * from via `getDoc()`. */
export interface DocParam {
  label: string;
  docNode: any;
}

/** Renders one `- Parameter <label>: <doc>` line per entry in `params` that
 * has its own `@doc`. Entries with no `@doc` are silently skipped. Returns
 * `""` if no entry has a doc. */
export function paramDocLines(program: any, params: DocParam[], indent = ""): string {
  let out = "";
  for (const p of params) {
    const doc = getDoc(program, p.docNode);
    if (!doc) continue;
    out += `${indent}/// - Parameter ${p.label}: ${doc}\n`;
  }
  return out;
}
