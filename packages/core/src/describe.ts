import { isObject, operationKey } from "./json.js";

export function describeOperation(
  doc: Record<string, unknown>,
  api: string,
  operation: string,
  depth = 1,
): string {
  const parsed = operation.trim().match(/^([A-Za-z]+)\s+(\/\S+)$/);
  if (!parsed?.[1] || !parsed[2]) throw new Error(`Expected "METHOD /path", got ${operation}`);
  const method = parsed[1].toUpperCase();
  const opPath = parsed[2];
  const paths = isObject(doc.paths) ? doc.paths : {};
  const item = paths[opPath];
  if (!isObject(item) || !isObject(item[method.toLowerCase()])) {
    throw new Error(`${api} has no ${operationKey(method, opPath)}`);
  }
  const op = item[method.toLowerCase()] as Record<string, unknown>;
  const name = typeof op.operationId === "string" ? op.operationId : fallbackName(method, opPath);
  const auth = authLabel(doc, op);
  const params = [
    ...(Array.isArray(item.parameters) ? item.parameters : []),
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ].filter(isObject);
  const args: string[] = [];
  const pathParams = params.filter((param) => param.in === "path");
  const queryParams = params.filter((param) => param.in === "query");
  for (const param of pathParams) {
    args.push(`${String(param.name)}: ${schemaToTs(param.schema, depth, doc)}`);
  }
  if (queryParams.length > 0) {
    args.push(`query?: ${inlineObject(queryParams.map((param) => fieldFromParam(param)), depth, doc)}`);
  }
  const body = requestBody(op);
  if (body) args.push(`body${body.required ? "" : "?"}: ${schemaToTs(body.schema, depth, doc)}`);
  const success = successSchema(op);
  const returnType = success ? schemaToTs(success, 0, doc) : "void";
  const errors = errorStatuses(op);
  const lines = [
    `// ${api} · ${operationKey(method, opPath)} · auth: ${auth}`,
    `${name}(${args.join(", ")}): Promise<${returnType}>${errors ? ` // errors: ${errors}` : ""}`,
  ];
  return lines.join("\n");
}

function fieldFromParam(param: Record<string, unknown>): { name: string; required: boolean; schema: unknown; description?: string } {
  return {
    name: String(param.name),
    required: param.required === true,
    schema: param.schema,
    description: typeof param.description === "string" ? param.description : undefined,
  };
}

function requestBody(op: Record<string, unknown>): { required: boolean; schema: unknown } | undefined {
  if (!isObject(op.requestBody)) return undefined;
  const content = isObject(op.requestBody.content) ? op.requestBody.content : {};
  const json = content["application/json"] ?? Object.values(content)[0];
  if (!isObject(json)) return undefined;
  return { required: op.requestBody.required === true, schema: json.schema };
}

function successSchema(op: Record<string, unknown>): unknown {
  if (!isObject(op.responses)) return undefined;
  const preferred = ["200", "201", "202", "204"].find((code) => isObject(op.responses) && op.responses[code]);
  const response = preferred && isObject(op.responses) ? op.responses[preferred] : undefined;
  if (!isObject(response) || !isObject(response.content)) return undefined;
  const json = response.content["application/json"] ?? Object.values(response.content)[0];
  return isObject(json) ? json.schema : undefined;
}

function errorStatuses(op: Record<string, unknown>): string {
  if (!isObject(op.responses)) return "";
  return Object.keys(op.responses)
    .filter((code) => Number(code) >= 400)
    .sort()
    .join(", ");
}

function authLabel(doc: Record<string, unknown>, op: Record<string, unknown>): string {
  const security = op.security !== undefined ? op.security : doc.security;
  if (!Array.isArray(security) || security.length === 0) return "none";
  const names = security.flatMap((requirement) => (isObject(requirement) ? Object.keys(requirement) : []));
  if (names.length === 0) return "none";
  const schemes = isObject(doc.components) && isObject(doc.components.securitySchemes)
    ? doc.components.securitySchemes
    : {};
  return names
    .map((name) => {
      const scheme = schemes[name];
      if (!isObject(scheme)) return name;
      const base = typeof scheme.scheme === "string" ? scheme.scheme : String(scheme.type ?? name);
      const description = typeof scheme.description === "string" ? ` (${scheme.description})` : "";
      return `${base}${description}`;
    })
    .join(", ");
}

function fallbackName(method: string, opPath: string): string {
  const parts = opPath.split("/").filter((part) => part && !part.startsWith("{"));
  const tail = parts.at(-1) ?? "root";
  return `${method.toLowerCase()}${tail[0]?.toUpperCase() ?? ""}${tail.slice(1)}`;
}

function schemaToTs(schema: unknown, depth: number, doc: Record<string, unknown>): string {
  if (!isObject(schema)) return "unknown";
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").pop() ?? "unknown";
    const resolved = resolveRef(doc, schema.$ref);
    if (depth > 0 && isObject(resolved) && (resolved.type === "object" || resolved.properties)) {
      return schemaToTs(resolved, depth - 1, doc);
    }
    return name;
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((item) => JSON.stringify(item)).join(" | ");
  if (schema.nullable === true) return `${schemaToTs({ ...schema, nullable: false }, depth, doc)} | null`;
  if (schema.type === "array") return `${schemaToTs(schema.items, depth, doc)}[]`;
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "string" || schema.type === undefined && !schema.properties) {
    if (schema.type === "string") return "string";
  }
  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    if (schema.additionalProperties && !schema.properties) {
      const inner = schema.additionalProperties === true
        ? "unknown"
        : schemaToTs(schema.additionalProperties, Math.max(depth - 1, 0), doc);
      return `Record<string, ${inner}>`;
    }
    if (depth <= 0 && typeof schema.title === "string") return schema.title;
    return inlineObject(objectFields(schema), depth, doc);
  }
  return "unknown";
}

function objectFields(schema: Record<string, unknown>): Array<{ name: string; required: boolean; schema: unknown; description?: string }> {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.keys(properties).map((name) => ({
    name,
    required: required.has(name),
    schema: properties[name],
    description: isObject(properties[name]) && typeof properties[name].description === "string"
      ? String(properties[name].description)
      : undefined,
  }));
}

function inlineObject(
  fields: Array<{ name: string; required: boolean; schema: unknown; description?: string }>,
  depth: number,
  doc: Record<string, unknown>,
): string {
  if (fields.length === 0) return "Record<string, unknown>";
  const lines = fields.map((field) => {
    const comment = field.description ? ` // ${field.description}` : "";
    return `  ${field.name}${field.required ? "" : "?"}: ${schemaToTs(field.schema, Math.max(depth - 1, 0), doc)};${comment}`;
  });
  return `{\n${lines.join("\n")}\n}`;
}

function resolveRef(doc: Record<string, unknown>, ref: string): unknown {
  const match = ref.match(/^#\/(.+)$/);
  if (!match?.[1]) return undefined;
  let current: unknown = doc;
  for (const part of match[1].split("/")) {
    if (!isObject(current)) return undefined;
    current = current[decodeURIComponent(part)];
  }
  return current;
}
