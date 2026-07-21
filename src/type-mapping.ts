// Maps TypeSpec built-in scalar names to Swift primitive type names.
const SCALAR_MAP: Record<string, string> = {
  string: "String", uuid: "String", url: "String",
  boolean: "Bool",
  bytes: "Data",
  int8: "Int32", int16: "Int32", int32: "Int32", uint8: "Int32", uint16: "Int32", uint32: "Int32",
  integer: "Int32", safeint: "Int64",
  int64: "Int64", uint64: "Int64",
  float32: "Float",
  float64: "Double", float: "Double", decimal: "Double", decimal128: "Double",
  utcDateTime: "Date", offsetDateTime: "Date", plainDate: "Date", plainTime: "Date", duration: "Date",
};

/** Walks a Scalar's `baseScalar` chain to the nearest TypeSpec built-in with a
 * known Swift mapping. Custom scalars with no known ancestor fall back to
 * `String`. */
export function resolveScalarChain(scalar: any): string {
  let s = scalar;
  while (s) {
    if (SCALAR_MAP[s.name]) return SCALAR_MAP[s.name];
    s = s.baseScalar;
  }
  return "String";
}

/** Converts any TypeSpec type reachable from a model property, union variant,
 * or operation parameter into a Swift type expression. Optionality (`?`) is
 * NOT applied here — callers append it based on `property.optional`. */
export function swiftTypeForType(type: any, program: any): string {
  if (!type) return "JSONValue";
  switch (type.kind) {
    case "Scalar":
      return resolveScalarChain(type);
    case "Model":
      if (type.name === "Array") return `[${swiftTypeForType(type.indexer?.value, program)}]`;
      if (type.name === "Record") return `[String: ${swiftTypeForType(type.indexer?.value, program)}]`;
      if (!type.name) return "JSONValue"; // anonymous model literal
      return type.name;
    case "Union":
      return type.name ?? "JSONValue";
    case "Enum":
      return type.name ?? "JSONValue";
    case "ModelProperty":
      return swiftTypeForType(type.type, program);
    case "Intrinsic":
    default:
      return "JSONValue";
  }
}
