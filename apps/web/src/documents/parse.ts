/**
 * The design documents as a person reads them (T24b), from the text the
 * agents wrote: the Slice Plan, the API Contract (OpenAPI), the UI Spec and
 * the Penpot design are JSON; the System Design is Markdown. Each parser is
 * defensive, because a document from an older Run may not have every field,
 * and returns null for what it cannot read, so the view falls back to Raw.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one) => typeof one === "string") : [];

function json(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

export type PlannedSlice = {
  title: string;
  goal: string;
  isWalkingSkeleton: boolean;
  endpoints: string[];
};

export function parseSlicePlan(content: string): PlannedSlice[] | null {
  const parsed = json(content);
  const slices = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.slices)
      ? parsed.slices
      : null;
  if (!slices) return null;
  return slices.filter(isObject).map((slice) => ({
    title: text(slice.title),
    goal: text(slice.goal),
    isWalkingSkeleton: slice.isWalkingSkeleton === true,
    endpoints: strings(slice.endpoints),
  }));
}

export type Field = {
  name: string;
  type: string;
  required: boolean;
  note: string;
};

/** A schema, flattened to what a person scans: its type and its fields. */
export type SchemaView = { type: string; fields: Field[] };

export type Operation = {
  method: string;
  path: string;
  /** "GET /todos", as Slices and screens name it. */
  endpoint: string;
  summary: string;
  parameters: Field[];
  requestBody: SchemaView | null;
  responses: Array<{
    status: string;
    description: string;
    body: SchemaView | null;
  }>;
};

export type ApiContract = {
  title: string;
  version: string;
  operations: Operation[];
  schemas: Array<{ name: string; schema: SchemaView }>;
};

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function parseApiContract(content: string): ApiContract | null {
  const document = json(content);
  if (!isObject(document) || !isObject(document.paths)) return null;
  const components =
    isObject(document.components) && isObject(document.components.schemas)
      ? document.components.schemas
      : {};
  const view = (schema: unknown) => schemaView(schema, components);
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      operations.push({
        method: method.toUpperCase(),
        path,
        endpoint: `${method.toUpperCase()} ${path}`,
        summary: text(operation.summary) || text(operation.description),
        parameters: [
          ...(Array.isArray(item.parameters) ? item.parameters : []),
          ...(Array.isArray(operation.parameters) ? operation.parameters : []),
        ]
          .filter(isObject)
          .map((parameter) => ({
            name: text(parameter.name),
            type: typeOf(parameter.schema, components),
            required: parameter.required === true,
            note: text(parameter.in),
          })),
        requestBody: isObject(operation.requestBody)
          ? bodyOf(operation.requestBody, view)
          : null,
        responses: isObject(operation.responses)
          ? Object.entries(operation.responses).map(([status, response]) => ({
              status,
              description: isObject(response) ? text(response.description) : "",
              body: isObject(response) ? bodyOf(response, view) : null,
            }))
          : [],
      });
    }
  }
  const info = isObject(document.info) ? document.info : {};
  return {
    title: text(info.title),
    version: text(info.version),
    operations,
    schemas: Object.entries(components).map(([name, schema]) => ({
      name,
      schema: view(schema),
    })),
  };
}

/** The JSON body of a request or response, whichever media type it names. */
function bodyOf(
  holder: Json,
  view: (schema: unknown) => SchemaView,
): SchemaView | null {
  if (!isObject(holder.content)) return null;
  const media =
    holder.content["application/json"] ?? Object.values(holder.content)[0];
  return isObject(media) && media.schema !== undefined
    ? view(media.schema)
    : null;
}

/** How deep a schema's references are followed: enough to read, never a loop. */
const DEPTH = 3;

function resolve(schema: unknown, components: Json, depth = 0): Json {
  if (!isObject(schema)) return {};
  const ref = text(schema.$ref);
  if (ref && depth < DEPTH) {
    const name = ref.split("/").pop() ?? "";
    return resolve(components[name], components, depth + 1);
  }
  return schema;
}

export function schemaView(schema: unknown, components: Json): SchemaView {
  const resolved = resolve(schema, components);
  const items = resolve(resolved.items, components);
  const holder = text(resolved.type) === "array" ? items : resolved;
  const required = new Set(strings(holder.required));
  const fields = isObject(holder.properties)
    ? Object.entries(holder.properties).map(([name, property]) => ({
        name,
        type: typeOf(property, components),
        required: required.has(name),
        note: noteOf(resolve(property, components)),
      }))
    : [];
  return { type: typeOf(schema, components), fields };
}

/** "string", "Todo[]", "integer", "Session": a type as a person names it. */
export function typeOf(schema: unknown, components: Json): string {
  if (!isObject(schema)) return "any";
  const ref = text(schema.$ref);
  if (ref) return ref.split("/").pop() ?? "object";
  const type = text(schema.type);
  if (type === "array") return `${typeOf(schema.items, components)}[]`;
  if (Array.isArray(schema.enum))
    return schema.enum.map((one) => JSON.stringify(one)).join(" | ");
  return type || (isObject(schema.properties) ? "object" : "any");
}

/** What else a person needs about a field: its format, limits or example. */
function noteOf(schema: Json): string {
  return [
    text(schema.format),
    typeof schema.minLength === "number"
      ? `min length ${schema.minLength}`
      : "",
    typeof schema.maxLength === "number"
      ? `max length ${schema.maxLength}`
      : "",
    typeof schema.minimum === "number" ? `≥ ${schema.minimum}` : "",
    typeof schema.maximum === "number" ? `≤ ${schema.maximum}` : "",
    schema.example !== undefined
      ? `e.g. ${JSON.stringify(schema.example)}`
      : "",
    text(schema.description),
  ]
    .filter(Boolean)
    .join(" · ");
}

export type UiElement = {
  kind: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type UiScreen = {
  name: string;
  route: string;
  purpose: string;
  sliceTitle: string;
  endpoints: string[];
  states: string[];
  elements: UiElement[];
};

export type UiSpec = {
  tokens: Array<{ name: string; value: string }>;
  screens: UiScreen[];
};

const number = (value: unknown) => (typeof value === "number" ? value : 0);

export function parseUiSpec(content: string): UiSpec | null {
  const spec = json(content);
  if (!isObject(spec) || !Array.isArray(spec.screens)) return null;
  return {
    tokens: isObject(spec.tokens)
      ? Object.entries(spec.tokens).map(([name, value]) => ({
          name,
          value: String(value),
        }))
      : [],
    screens: spec.screens.filter(isObject).map((screen) => ({
      name: text(screen.name),
      route: text(screen.route),
      purpose: text(screen.purpose),
      sliceTitle: text(screen.sliceTitle),
      endpoints: strings(screen.endpoints),
      states: strings(screen.states),
      elements: (Array.isArray(screen.elements) ? screen.elements : [])
        .filter(isObject)
        .map((element) => ({
          kind: text(element.kind),
          label: text(element.label),
          x: number(element.x),
          y: number(element.y),
          width: number(element.width),
          height: number(element.height),
        })),
    })),
  };
}

export type PenpotDesign = { page: string; screens: string[] };

export function parsePenpotDesign(content: string): PenpotDesign | null {
  const design = json(content);
  if (!isObject(design)) return null;
  return {
    // The UI Design Agent writes the page as { name, pageId, fileId }.
    page: isObject(design.page) ? text(design.page.name) : text(design.page),
    screens: (Array.isArray(design.screens) ? design.screens : [])
      .filter(isObject)
      .map((screen) => text(screen.name)),
  };
}

/** The text as the agents wrote it, JSON laid out to be read. */
export function raw(content: string): string {
  const parsed = json(content);
  return parsed === undefined ? content : JSON.stringify(parsed, null, 2);
}
