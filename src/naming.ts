const SWIFT_KEYWORDS = new Set([
  "protocol", "class", "self", "default", "enum", "struct", "func", "let", "var",
  "if", "else", "switch", "case", "for", "while", "return", "public", "private",
  "internal", "static", "init", "deinit", "extension", "import", "where", "as",
  "is", "in", "do", "try", "catch", "throw", "throws", "async", "await", "any",
  "some", "nil", "true", "false", "Type", "Protocol", "operator", "associatedtype",
]);

export function isSwiftKeyword(name: string): boolean {
  return SWIFT_KEYWORDS.has(name);
}

export function escapeIdentifier(name: string): string {
  return isSwiftKeyword(name) ? `\`${name}\`` : name;
}

export function internalParamName(name: string): string {
  return isSwiftKeyword(name) ? `${name}Value` : name;
}

export function upperFirst(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function lowerFirst(s: string): string {
  return s.length ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** Normalizes spec enum member names (often SCREAMING_SNAKE_CASE or
 * snake_case) to idiomatic lowerCamelCase Swift case names. The original wire
 * value is always preserved separately as the case's raw value. */
export function enumCaseName(name: string): string {
  const camel = /^[A-Z0-9_]+$/.test(name)
    ? name.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
    : name.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
  return lowerFirst(camel);
}
