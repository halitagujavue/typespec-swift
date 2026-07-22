import { getDoc } from "@typespec/compiler";
import { escapeIdentifier, lowerFirst } from "./naming.ts";
import { swiftTypeForType } from "./type-mapping.ts";
import { docComment, paramDocLines, type DocParam } from "./doc-comment.ts";
import type { ResolvedSwiftEmitterOptions } from "./index.ts";

interface ParamInfo {
  name: string;
  wireName: string;
  swiftType: string;
  required: boolean;
  greedy?: boolean;
  isEnum?: boolean;
  /** The TypeSpec node (`ModelProperty`) this parameter was derived from,
   * used to read its own `@doc` for `- Parameter` lines. */
  docNode?: any;
}

function pathExpr(uri: string, labels: ParamInfo[]): string {
  let expr = uri;
  for (const p of labels) {
    const enc = p.greedy ? "greedy" : "segment";
    const replacement = `\\(PathEncoding.${enc}(${escapeIdentifier(p.name)}))`;
    expr = expr.replace(`{${p.name}+}`, replacement).replace(`{${p.name}}`, replacement);
  }
  return `"${expr}"`;
}

// Converts a query or header parameter's Swift value into the `String` (or
// `[String]`, for array query params) that HTTPRequestBuilder's addQuery/
// setHeader overloads require. Used for both query and header params since
// both bindings require the same conversion.
function stringValueExpr(p: ParamInfo): string {
  const name = escapeIdentifier(p.name);
  if (p.swiftType.endsWith("]")) return name; // array query params pass through
  if (p.isEnum) {
    return p.required ? `${name}.rawValue` : `${name}?.rawValue`;
  }
  switch (p.swiftType) {
    case "String":
      return name;
    case "Date":
      return p.required ? `JSONCoding.iso8601String(${name})` : `${name}.map(JSONCoding.iso8601String)`;
    default:
      return p.required ? `String(${name})` : `${name}.map(String.init)`;
  }
}

interface PartInfo {
  /** Wire/part name, also used as the base Swift parameter name. */
  name: string;
  /** Swift type of a single element (before any `[]` wrapping for `multi`):
   * `"HTTPFile"` for binary parts, otherwise the part's native Swift type. */
  baseSwiftType: string;
  /** Full parameter Swift type, including `[]` wrapping when `multi`. */
  swiftType: string;
  required: boolean;
  multi: boolean;
  /** True for `Http.File`-derived parts and bare `HttpPart<bytes>` parts —
   * both get an `HTTPFile` parameter instead of their raw type. */
  isBinary: boolean;
  /** Fallback passed to `HTTPFile.resolvedContentType(fallback:)` when the
   * spec has no dynamic content-type property but does declare a single
   * static content type (the bare `HttpPart<bytes>` case). Undefined when a
   * dynamic property exists (no fallback needed) or neither is present. */
  contentTypeFallback?: string;
  docNode?: any;
}

function buildMultipartParts(program: any, body: any): PartInfo[] {
  return body.parts.map((part: any): PartInfo => {
    const elementType = swiftTypeForType(part.body.type, program);
    const isBinary = part.body.bodyKind === "file" || elementType === "Data";
    const baseSwiftType = isBinary ? "HTTPFile" : elementType;
    const swiftType = part.multi ? `[${baseSwiftType}]` : baseSwiftType;
    const info: PartInfo = {
      name: part.name,
      baseSwiftType,
      swiftType,
      required: !part.optional,
      multi: !!part.multi,
      isBinary,
      docNode: part.property,
    };
    if (isBinary && !part.body.contentTypeProperty && part.body.contentTypes?.length === 1) {
      info.contentTypeFallback = part.body.contentTypes[0];
    }
    return info;
  });
}

// Converts a single (non-optional, already-unwrapped) part value expression
// into the `Data` that a MultipartFormData.Part's `.data(...)` source needs.
function partValueToDataExpr(baseType: string, expr: string): string {
  switch (baseType) {
    case "String":
      return `Data(${expr}.utf8)`;
    case "Date":
      return `Data(JSONCoding.iso8601String(${expr}).utf8)`;
    case "Bool":
    case "Int32":
    case "Int64":
    case "Float":
    case "Double":
      return `Data(String(${expr}).utf8)`;
    default:
      return `try JSONCoding.encoder.encode(${expr})`;
  }
}

// Builds the `HTTPFile.resolvedContentType(...)` call expression for a
// binary part value expression (e.g. a parameter name or a loop variable).
function resolvedContentTypeExpr(p: PartInfo, valueExpr: string): string {
  return p.contentTypeFallback
    ? `${valueExpr}.resolvedContentType(fallback: ${JSON.stringify(p.contentTypeFallback)})`
    : `${valueExpr}.resolvedContentType()`;
}

// Emits the `multipart.append(...)` statement(s) for one part, handling the
// four combinations of multi × binary (optionality is handled via `?? []`
// for multi arrays and `if let` for single optional values).
function emitPartAppend(p: PartInfo): string {
  const label = escapeIdentifier(p.name);
  const wire = JSON.stringify(p.name);

  if (p.multi) {
    const iterExpr = p.required ? label : `${label} ?? []`;
    if (p.isBinary) {
      return (
        `        for value in ${iterExpr} {\n` +
        `            multipart.append(.init(name: ${wire}, filename: value.resolvedFilename(), contentType: ${resolvedContentTypeExpr(p, "value")}, source: value.asHTTPBody()))\n` +
        `        }\n`
      );
    }
    return (
      `        for value in ${iterExpr} {\n` +
      `            multipart.append(.init(name: ${wire}, source: .data(${partValueToDataExpr(p.baseSwiftType, "value")})))\n` +
      `        }\n`
    );
  }

  if (p.isBinary) {
    const append = `multipart.append(.init(name: ${wire}, filename: ${label}.resolvedFilename(), contentType: ${resolvedContentTypeExpr(p, label)}, source: ${label}.asHTTPBody()))\n`;
    if (p.required) return `        ${append}`;
    return `        if let ${label} {\n            ${append}        }\n`;
  }

  const append = `multipart.append(.init(name: ${wire}, source: .data(${partValueToDataExpr(p.baseSwiftType, label)})))\n`;
  if (p.required) return `        ${append}`;
  return `        if let ${label} {\n            ${append}        }\n`;
}

// @typespec/http flattens `SSEStream<EventUnion>` to a `string` body, so the
// typed event union is recovered from the operation's RAW return type, not
// from the HTTP metadata (mirrors the OpenAPI fidelity loss).
function findEventUnion(op: any): string | undefined {
  const rt = op.returnType;
  const candidates = rt?.kind === "Union" ? [...rt.variants.values()].map((v: any) => v.type) : [rt];
  for (const c of candidates) {
    if (c?.kind === "Model" && c.templateMapper?.args?.length) {
      const arg = c.templateMapper.args[0];
      if (arg?.kind === "Union" || arg?.kind === "Model") return arg.name;
    }
  }
  return undefined;
}

interface OperationInfo {
  opName: string;
  labels: ParamInfo[];
  queries: ParamInfo[];
  headers: ParamInfo[];
  requestBodyKind: "json" | "streamingBlob" | "multipart" | "none";
  payload?: ParamInfo;
  multipartParts: PartInfo[];
  multipartHasFilePart: boolean;
  responseKind: "json" | "empty" | "streamingBlob" | "eventStream";
  outputSwiftType: string;
  eventUnion?: string;
  errorTable: string;
  method: string;
  mutatesBuilder: boolean;
  docParams: DocParam[];
  doc: string | undefined;
  returnType: string;
}

// Computes everything needed to emit either the concrete method
// (emitOperation) or the protocol requirement (emitProtocolRequirement) for
// one operation, so both stay perfectly in sync without duplicating the
// TypeSpec-shape inspection logic.
function computeOperationInfo(program: any, httpOp: any): OperationInfo {
  const opName = lowerFirst(httpOp.operation.name);
  const labels: ParamInfo[] = [];
  const queries: ParamInfo[] = [];
  const headers: ParamInfo[] = [];

  for (const p of httpOp.parameters.parameters) {
    const info: ParamInfo = {
      name: p.param.name,
      wireName: p.name,
      swiftType: swiftTypeForType(p.param.type, program),
      required: !p.param.optional,
      greedy: !!p.allowReserved,
      isEnum: p.param.type?.kind === "Enum",
      docNode: p.param,
    };
    if (p.type === "path") labels.push(info);
    else if (p.type === "query") queries.push(info);
    else if (p.type === "header") headers.push(info);
  }

  // Request body.
  let requestBodyKind: "json" | "streamingBlob" | "multipart" | "none" = "none";
  let payload: ParamInfo | undefined;
  let multipartParts: PartInfo[] = [];
  const reqBody = httpOp.parameters.body;
  if (reqBody && reqBody.bodyKind === "single") {
    const bt = reqBody.type;
    if (bt?.kind === "Scalar" && swiftTypeForType(bt, program) === "Data") {
      requestBodyKind = "streamingBlob";
    } else {
      requestBodyKind = "json";
      payload = {
        name: reqBody.property?.name ?? "payload",
        wireName: "",
        swiftType: swiftTypeForType(bt, program),
        required: !(reqBody.property?.optional ?? false),
        docNode: reqBody.property,
      };
    }
  } else if (reqBody && reqBody.bodyKind === "multipart" && reqBody.multipartKind === "model") {
    requestBodyKind = "multipart";
    multipartParts = buildMultipartParts(program, reqBody);
  }
  const multipartHasFilePart = multipartParts.some((p) => p.isBinary);

  // Responses: success shape + error table.
  let responseKind: "json" | "empty" | "streamingBlob" | "eventStream" = "empty";
  let outputSwiftType = "JSONValue";
  let eventUnion: string | undefined;
  const errors: { status: number; shape: string }[] = [];

  for (const resp of httpOp.responses) {
    const status = typeof resp.statusCodes === "number" ? resp.statusCodes : undefined;
    if (status === undefined) continue;
    const isSuccess = status >= 200 && status < 300;
    const content = resp.responses?.[0];
    const body = content?.body;
    if (isSuccess) {
      const contentTypes: string[] = body?.contentTypes ?? [];
      if (!body) {
        responseKind = "empty";
      } else if (contentTypes.some((c) => c.includes("event-stream"))) {
        responseKind = "eventStream";
        eventUnion = findEventUnion(httpOp.operation);
      } else if (body.type?.kind === "Scalar" && swiftTypeForType(body.type, program) === "Data") {
        responseKind = "streamingBlob";
      } else {
        responseKind = "json";
        outputSwiftType = swiftTypeForType(body.type, program);
      }
    } else if (resp.type?.name) {
      errors.push({ status, shape: resp.type.name });
    }
  }

  let returnType = "";
  if (responseKind === "json") returnType = ` -> ${outputSwiftType}`;
  else if (responseKind === "streamingBlob") returnType = ` -> HTTPResponseStream`;
  else if (responseKind === "eventStream") returnType = ` -> AsyncThrowingStream<${eventUnion}, any Error>`;

  const method = httpOp.verb.toLowerCase();
  const mutatesBuilder = queries.length > 0 || headers.length > 0 || requestBodyKind !== "none";
  const errorTable = errors.length
    ? "[" + errors.map((e) => `${e.status}: ${e.shape}.self`).join(", ") + "]"
    : "[:]";

  const docParams: DocParam[] = [];
  for (const p of [...labels, ...queries, ...headers]) {
    if (p.docNode) docParams.push({ label: escapeIdentifier(p.name), docNode: p.docNode });
  }
  if (requestBodyKind === "json" && payload?.docNode) {
    docParams.push({ label: escapeIdentifier(payload.name), docNode: payload.docNode });
  } else if (requestBodyKind === "streamingBlob" && reqBody?.property) {
    docParams.push({ label: "body", docNode: reqBody.property });
  } else if (requestBodyKind === "multipart") {
    for (const p of multipartParts) {
      if (p.docNode) docParams.push({ label: escapeIdentifier(p.name), docNode: p.docNode });
    }
  }

  return {
    opName,
    labels,
    queries,
    headers,
    requestBodyKind,
    payload,
    multipartParts,
    multipartHasFilePart,
    responseKind,
    outputSwiftType,
    eventUnion,
    errorTable,
    method,
    mutatesBuilder,
    docParams,
    doc: getDoc(program, httpOp.operation),
    returnType,
  };
}

function formatParam(name: string, swiftType: string, required: boolean, includeDefault: boolean): string {
  const optional = required ? "" : "?";
  const def = !required && includeDefault ? " = nil" : "";
  return `${escapeIdentifier(name)}: ${swiftType}${optional}${def}`;
}

// Builds the full parameter list text (without surrounding parens) for an
// operation. `includeDefaults` is false for protocol requirements (Swift
// forbids default arguments there) and true for the concrete method.
function formatParamList(info: OperationInfo, includeDefaults: boolean): string {
  const params: string[] = [];
  for (const p of [...info.labels, ...info.queries, ...info.headers]) {
    params.push(formatParam(p.name, p.swiftType, p.required, includeDefaults));
  }
  if (info.requestBodyKind === "json" && info.payload) {
    params.push(formatParam(info.payload.name, info.payload.swiftType, info.payload.required, includeDefaults));
  } else if (info.requestBodyKind === "streamingBlob") {
    params.push(`body: HTTPBody`);
    params.push(includeDefaults ? `uploadProgress: ProgressHandler? = nil` : `uploadProgress: ProgressHandler?`);
  } else if (info.requestBodyKind === "multipart") {
    for (const p of info.multipartParts) {
      params.push(formatParam(p.name, p.swiftType, p.required, includeDefaults));
    }
    if (info.multipartHasFilePart) {
      params.push(includeDefaults ? `uploadProgress: ProgressHandler? = nil` : `uploadProgress: ProgressHandler?`);
    }
  }
  return params.join(", ");
}

// Emits the concrete method implementation. `ensureSuccessRef` is `"Self"`
// for operations on the top-level client, or the outer client's type name
// (e.g. `"ShopServiceClient"`) for operations on a nested interface
// sub-client, since a nested struct's own `Self` doesn't resolve to the
// outer type that declares `ensureSuccess`.
function emitOperation(program: any, httpOp: any, modifier: string, ensureSuccessRef: string = "Self"): string {
  const info = computeOperationInfo(program, httpOp);
  const params = formatParamList(info, true);

  let out = docComment(info.doc, "    ");
  out += paramDocLines(program, info.docParams, "    ");
  out += `    ${modifier} func ${info.opName}(${params}) async throws${info.returnType} {\n`;
  out += `        ${info.mutatesBuilder ? "var" : "let"} builder = HTTPRequestBuilder(method: .${info.method}, baseURL: baseURL, path: ${pathExpr(httpOp.path, info.labels)})\n`;
  for (const q of info.queries) {
    out += `        builder.addQuery(${JSON.stringify(q.wireName)}, ${stringValueExpr(q)})\n`;
  }
  for (const h of info.headers) {
    out += `        builder.setHeader(${JSON.stringify(h.wireName)}, ${stringValueExpr(h)})\n`;
  }
  if (info.requestBodyKind === "json" && info.payload) {
    if (info.payload.required) {
      out += `        builder.setHeader("Content-Type", "application/json")\n`;
      out += `        builder.setBody(.data(try JSONCoding.encoder.encode(${escapeIdentifier(info.payload.name)})))\n`;
    } else {
      out += `        if let ${escapeIdentifier(info.payload.name)} {\n`;
      out += `            builder.setHeader("Content-Type", "application/json")\n`;
      out += `            builder.setBody(.data(try JSONCoding.encoder.encode(${escapeIdentifier(info.payload.name)})))\n`;
      out += `        }\n`;
    }
  } else if (info.requestBodyKind === "streamingBlob") {
    out += `        builder.setBody(body)\n`;
  } else if (info.requestBodyKind === "multipart") {
    out += `        var multipart = MultipartFormData()\n`;
    for (const p of info.multipartParts) {
      out += emitPartAppend(p);
    }
    out += `        builder.setHeader("Content-Type", multipart.contentType)\n`;
    if (info.multipartHasFilePart) {
      out += `        let multipartFile = try multipart.writeToTemporaryFile()\n`;
      out += `        defer { try? FileManager.default.removeItem(at: multipartFile) }\n`;
      out += `        builder.setBody(.file(multipartFile))\n`;
    } else {
      out += `        builder.setBody(.data(try multipart.encode()))\n`;
    }
  }

  const sendsWithProgress =
    info.requestBodyKind === "streamingBlob" || (info.requestBodyKind === "multipart" && info.multipartHasFilePart);

  if (info.responseKind === "json") {
    const send = sendsWithProgress
      ? `try await transport.send(builder.build(), uploadProgress: uploadProgress)`
      : `try await transport.send(builder.build())`;
    out += `        let response = ${send}\n`;
    out += `        try response.checkStatus(errorTypes: ${info.errorTable})\n`;
    out += `        return try JSONCoding.decoder.decode(${info.outputSwiftType}.self, from: response.body)\n`;
  } else if (info.responseKind === "empty") {
    const send = sendsWithProgress
      ? `try await transport.send(builder.build(), uploadProgress: uploadProgress)`
      : `try await transport.send(builder.build())`;
    out += `        let response = ${send}\n`;
    out += `        try response.checkStatus(errorTypes: ${info.errorTable})\n`;
  } else if (info.responseKind === "streamingBlob") {
    out += `        let stream = try await transport.stream(builder.build())\n`;
    out += `        try await ${ensureSuccessRef}.ensureSuccess(stream, errorTypes: ${info.errorTable})\n`;
    out += `        return stream\n`;
  } else if (info.responseKind === "eventStream") {
    out += `        let stream = try await transport.stream(builder.build())\n`;
    out += `        try await ${ensureSuccessRef}.ensureSuccess(stream, errorTypes: ${info.errorTable})\n`;
    out += `        let frames = stream.body.serverSentEvents()\n`;
    out += `        return AsyncThrowingStream<${info.eventUnion}, any Error> { continuation in\n`;
    out += `            let task = Task {\n`;
    out += `                do {\n`;
    out += `                    for try await frame in frames {\n`;
    out += `                        guard let data = frame.data.data(using: .utf8) else { continue }\n`;
    out += `                        continuation.yield(try JSONCoding.decoder.decode(${info.eventUnion}.self, from: data))\n`;
    out += `                    }\n`;
    out += `                    continuation.finish()\n`;
    out += `                } catch {\n`;
    out += `                    continuation.finish(throwing: error)\n`;
    out += `                }\n`;
    out += `            }\n`;
    out += `            continuation.onTermination = { _ in task.cancel() }\n`;
    out += `        }\n`;
  }
  out += `    }\n`;
  return out;
}

// Emits a protocol requirement: same signature as the concrete method, but
// no defaults, no access modifier, no body.
function emitProtocolRequirement(program: any, httpOp: any): string {
  const info = computeOperationInfo(program, httpOp);
  const params = formatParamList(info, false);
  let out = docComment(info.doc, "    ");
  out += paramDocLines(program, info.docParams, "    ");
  out += `    func ${info.opName}(${params}) async throws${info.returnType}\n`;
  return out;
}

// Prepends `extra` to every non-blank line of `text`. Used to re-indent an
// already-formatted method body one level deeper when it's nested inside an
// interface sub-client struct instead of the top-level client.
function indentBlock(text: string, extra: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? extra + line : line))
    .join("\n");
}

interface InterfaceGroup {
  displayName: string;
  operations: any[];
}

// Walks `iface`'s enclosing namespaces upward (excluding `serviceNamespace`)
// to build a collision-safe qualified name, e.g. `A.Items` -> `AItems`.
function qualifiedInterfaceName(iface: any, serviceNamespace: any): string {
  const segments: string[] = [iface.name];
  let ns = iface.namespace;
  while (ns && ns !== serviceNamespace && ns.name) {
    segments.unshift(ns.name);
    ns = ns.namespace;
  }
  return segments.join("");
}

// Groups `service.operations` by TypeSpec `interface` (object identity, not
// name — two different namespaces can each define a same-named interface).
// Operations not in any interface are returned separately as `flatOps` and
// stay on the top-level client, unchanged from pre-grouping behavior.
function computeInterfaceGroups(service: any): { flatOps: any[]; groups: InterfaceGroup[] } {
  const flatOps: any[] = [];
  const groupsByInterface = new Map<any, any[]>();

  for (const httpOp of service.operations) {
    const iface = httpOp.container?.kind === "Interface" ? httpOp.operation.interface : undefined;
    if (iface) {
      if (!groupsByInterface.has(iface)) groupsByInterface.set(iface, []);
      groupsByInterface.get(iface)!.push(httpOp);
    } else {
      flatOps.push(httpOp);
    }
  }

  const entries = [...groupsByInterface.entries()];
  const nameCounts = new Map<string, number>();
  for (const [iface] of entries) {
    nameCounts.set(iface.name, (nameCounts.get(iface.name) ?? 0) + 1);
  }

  const groups: InterfaceGroup[] = entries.map(([iface, operations]) => {
    const collides = (nameCounts.get(iface.name) ?? 0) > 1;
    const displayName = collides ? qualifiedInterfaceName(iface, service.namespace) : iface.name;
    return { displayName, operations };
  });
  groups.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return { flatOps, groups };
}

function emitProtocol(program: any, group: InterfaceGroup, modifier: string): string {
  let out = `${modifier} protocol ${group.displayName}API: Sendable {\n`;
  const ops = [...group.operations].sort((a: any, b: any) => a.operation.name.localeCompare(b.operation.name));
  for (const httpOp of ops) {
    out += emitProtocolRequirement(program, httpOp);
  }
  out += `}\n`;
  return out;
}

function emitNestedClient(
  program: any,
  group: InterfaceGroup,
  modifier: string,
  outerClientName: string,
  generateProtocols: boolean
): string {
  const conformance = generateProtocols ? `: ${group.displayName}API, Sendable` : `: Sendable`;
  let out = `    ${modifier} struct ${group.displayName}${conformance} {\n`;
  out += `        private let baseURL: URL\n`;
  out += `        private let transport: any HTTPTransport\n\n`;
  out += `        init(baseURL: URL, transport: any HTTPTransport) {\n`;
  out += `            self.baseURL = baseURL\n`;
  out += `            self.transport = transport\n`;
  out += `        }\n\n`;

  const ops = [...group.operations].sort((a: any, b: any) => a.operation.name.localeCompare(b.operation.name));
  for (const httpOp of ops) {
    out += indentBlock(emitOperation(program, httpOp, modifier, outerClientName), "    ") + "\n";
  }

  out += `    }\n`;
  return out;
}

export function generateClient(
  program: any,
  service: any,
  options: ResolvedSwiftEmitterOptions
): { filename: string; content: string } {
  const clientName = `${service.namespace.name}Client`;
  const modifier = options.accessModifier;
  const { flatOps, groups } = computeInterfaceGroups(service);

  let out = `// Code generated by typespec-swift. DO NOT EDIT.\n\n`;
  out += `import Foundation\nimport HTTPRuntime\n\n`;

  if (options.generateProtocols) {
    for (const group of groups) {
      out += emitProtocol(program, group, modifier) + "\n";
    }
  }

  out += `/// Generated client for ${service.namespace.name}. Depends only on HTTPRuntime.\n`;
  out += `${modifier} struct ${clientName}: Sendable {\n`;
  for (const group of groups) {
    out += `    ${modifier} let ${lowerFirst(group.displayName)}: ${group.displayName}\n`;
  }
  out += `    private let baseURL: URL\n`;
  out += `    private let transport: any HTTPTransport\n\n`;
  out += `    ${modifier} init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) {\n`;
  out += `        self.baseURL = baseURL\n`;
  out += `        self.transport = transport\n`;
  for (const group of groups) {
    out += `        self.${lowerFirst(group.displayName)} = ${group.displayName}(baseURL: baseURL, transport: transport)\n`;
  }
  out += `    }\n\n`;

  const sortedFlatOps = [...flatOps].sort((a: any, b: any) => a.operation.name.localeCompare(b.operation.name));
  for (const httpOp of sortedFlatOps) {
    out += emitOperation(program, httpOp, modifier) + "\n";
  }

  for (const group of groups) {
    out += emitNestedClient(program, group, modifier, clientName, options.generateProtocols) + "\n";
  }

  out += `    private static func ensureSuccess(\n`;
  out += `        _ stream: HTTPResponseStream,\n`;
  out += `        errorTypes: [Int: any APIError.Type]\n`;
  out += `    ) async throws {\n`;
  out += `        guard !stream.head.isSuccess else { return }\n`;
  out += `        var data = Data()\n`;
  out += `        for try await chunk in stream.body { data.append(chunk) }\n`;
  out += `        try HTTPResponse(head: stream.head, body: data).checkStatus(errorTypes: errorTypes)\n`;
  out += `    }\n`;
  out += `}\n`;

  return { filename: `${clientName}.swift`, content: out };
}
