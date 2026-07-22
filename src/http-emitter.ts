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

function emitOperation(program: any, httpOp: any, modifier: string): string {
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

  const params: string[] = [];
  for (const p of [...labels, ...queries, ...headers]) {
    params.push(`${escapeIdentifier(p.name)}: ${p.swiftType}${p.required ? "" : "?"}${p.required ? "" : " = nil"}`);
  }
  if (requestBodyKind === "json" && payload) {
    params.push(`${escapeIdentifier(payload.name)}: ${payload.swiftType}${payload.required ? "" : "?"}${payload.required ? "" : " = nil"}`);
  } else if (requestBodyKind === "streamingBlob") {
    params.push(`body: HTTPBody`);
    params.push(`uploadProgress: ProgressHandler? = nil`);
  } else if (requestBodyKind === "multipart") {
    for (const p of multipartParts) {
      params.push(`${escapeIdentifier(p.name)}: ${p.swiftType}${p.required ? "" : "?"}${p.required ? "" : " = nil"}`);
    }
    if (multipartHasFilePart) {
      params.push(`uploadProgress: ProgressHandler? = nil`);
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

  let out = docComment(getDoc(program, httpOp.operation), "    ");
  out += paramDocLines(program, docParams, "    ");
  out += `    ${modifier} func ${opName}(${params.join(", ")}) async throws${returnType} {\n`;
  out += `        ${mutatesBuilder ? "var" : "let"} builder = HTTPRequestBuilder(method: .${method}, baseURL: baseURL, path: ${pathExpr(httpOp.path, labels)})\n`;
  for (const q of queries) {
    out += `        builder.addQuery(${JSON.stringify(q.wireName)}, ${stringValueExpr(q)})\n`;
  }
  for (const h of headers) {
    out += `        builder.setHeader(${JSON.stringify(h.wireName)}, ${stringValueExpr(h)})\n`;
  }
  if (requestBodyKind === "json" && payload) {
    if (payload.required) {
      out += `        builder.setHeader("Content-Type", "application/json")\n`;
      out += `        builder.setBody(.data(try JSONCoding.encoder.encode(${escapeIdentifier(payload.name)})))\n`;
    } else {
      out += `        if let ${escapeIdentifier(payload.name)} {\n`;
      out += `            builder.setHeader("Content-Type", "application/json")\n`;
      out += `            builder.setBody(.data(try JSONCoding.encoder.encode(${escapeIdentifier(payload.name)})))\n`;
      out += `        }\n`;
    }
  } else if (requestBodyKind === "streamingBlob") {
    out += `        builder.setBody(body)\n`;
  } else if (requestBodyKind === "multipart") {
    out += `        var multipart = MultipartFormData()\n`;
    for (const p of multipartParts) {
      out += emitPartAppend(p);
    }
    out += `        builder.setHeader("Content-Type", multipart.contentType)\n`;
    if (multipartHasFilePart) {
      out += `        let multipartFile = try multipart.writeToTemporaryFile()\n`;
      out += `        defer { try? FileManager.default.removeItem(at: multipartFile) }\n`;
      out += `        builder.setBody(.file(multipartFile))\n`;
    } else {
      out += `        builder.setBody(.data(try multipart.encode()))\n`;
    }
  }

  const sendsWithProgress =
    requestBodyKind === "streamingBlob" || (requestBodyKind === "multipart" && multipartHasFilePart);

  if (responseKind === "json") {
    const send = sendsWithProgress
      ? `try await transport.send(builder.build(), uploadProgress: uploadProgress)`
      : `try await transport.send(builder.build())`;
    out += `        let response = ${send}\n`;
    out += `        try response.checkStatus(errorTypes: ${errorTable})\n`;
    out += `        return try JSONCoding.decoder.decode(${outputSwiftType}.self, from: response.body)\n`;
  } else if (responseKind === "empty") {
    const send = sendsWithProgress
      ? `try await transport.send(builder.build(), uploadProgress: uploadProgress)`
      : `try await transport.send(builder.build())`;
    out += `        let response = ${send}\n`;
    out += `        try response.checkStatus(errorTypes: ${errorTable})\n`;
  } else if (responseKind === "streamingBlob") {
    out += `        let stream = try await transport.stream(builder.build())\n`;
    out += `        try await Self.ensureSuccess(stream, errorTypes: ${errorTable})\n`;
    out += `        return stream\n`;
  } else if (responseKind === "eventStream") {
    out += `        let stream = try await transport.stream(builder.build())\n`;
    out += `        try await Self.ensureSuccess(stream, errorTypes: ${errorTable})\n`;
    out += `        let frames = stream.body.serverSentEvents()\n`;
    out += `        return AsyncThrowingStream<${eventUnion}, any Error> { continuation in\n`;
    out += `            let task = Task {\n`;
    out += `                do {\n`;
    out += `                    for try await frame in frames {\n`;
    out += `                        guard let data = frame.data.data(using: .utf8) else { continue }\n`;
    out += `                        continuation.yield(try JSONCoding.decoder.decode(${eventUnion}.self, from: data))\n`;
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

export function generateClient(
  program: any,
  service: any,
  options: ResolvedSwiftEmitterOptions
): { filename: string; content: string } {
  const clientName = `${service.namespace.name}Client`;
  const modifier = options.accessModifier;
  let out = `// Code generated by typespec-swift. DO NOT EDIT.\n\n`;
  out += `import Foundation\nimport HTTPRuntime\n\n`;
  out += `/// Generated client for ${service.namespace.name}. Depends only on HTTPRuntime.\n`;
  out += `${modifier} struct ${clientName}: Sendable {\n`;
  out += `    private let baseURL: URL\n`;
  out += `    private let transport: any HTTPTransport\n\n`;
  out += `    ${modifier} init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) {\n`;
  out += `        self.baseURL = baseURL\n`;
  out += `        self.transport = transport\n`;
  out += `    }\n\n`;

  const operations = [...service.operations].sort((a: any, b: any) =>
    a.operation.name.localeCompare(b.operation.name)
  );
  for (const httpOp of operations) {
    out += emitOperation(program, httpOp, modifier) + "\n";
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
