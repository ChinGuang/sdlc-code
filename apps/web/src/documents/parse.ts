// SPDX-License-Identifier: MPL-2.0
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
  // A Slice Plan is Slices, each with a title; anything else is not one.
  if (
    !slices ||
    slices.length === 0 ||
    !slices.every((slice) => isObject(slice) && typeof slice.title === "string")
  )
    return null;
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
  const deref = (value: unknown) => resolve(value, document);
  const view = (schema: unknown) => schemaView(schema, document);
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
        parameters: parametersOf(item, operation, document),
        requestBody: isObject(operation.requestBody)
          ? bodyOf(deref(operation.requestBody), view)
          : null,
        responses: isObject(operation.responses)
          ? Object.entries(operation.responses).map(([status, value]) => {
              const response = deref(value);
              return {
                status,
                description: text(response.description),
                body: bodyOf(response, view),
              };
            })
          : [],
      });
    }
  }
  const info = isObject(document.info) ? document.info : {};
  const components = isObject(document.components) ? document.components : {};
  return {
    title: text(info.title),
    version: text(info.version),
    operations,
    schemas: Object.entries(
      isObject(components.schemas) ? components.schemas : {},
    ).map(([name, schema]) => ({ name, schema: view(schema) })),
  };
}

/**
 * An operation's parameters: the path's own, then the operation's, which
 * replace a path parameter of the same name and place (OpenAPI's rule).
 */
function parametersOf(item: Json, operation: Json, document: Json): Field[] {
  const byKey = new Map<string, Json>();
  for (const value of [
    ...(Array.isArray(item.parameters) ? item.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ]) {
    const parameter = resolve(value, document);
    if (!text(parameter.name)) continue;
    byKey.set(`${text(parameter.in)}:${text(parameter.name)}`, parameter);
  }
  return [...byKey.values()].map((parameter) => ({
    name: text(parameter.name),
    type: typeOf(parameter.schema, document),
    required: parameter.required === true,
    note: [text(parameter.in), noteOf(resolve(parameter.schema, document))]
      .filter(Boolean)
      .join(" · "),
  }));
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

/** How deep references are followed: enough to read, never a loop. */
const DEPTH = 4;

/**
 * A value with its `$ref` followed, anywhere in the document (a JSON pointer
 * such as #/components/parameters/Id); {} for one that points nowhere.
 */
function resolve(value: unknown, document: Json, depth = 0): Json {
  if (!isObject(value)) return {};
  const ref = text(value.$ref);
  if (!ref) return value;
  if (depth >= DEPTH || !ref.startsWith("#/")) return {};
  const target = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>(
      (at, key) => (isObject(at) ? at[key] : undefined),
      document,
    );
  return resolve(target, document, depth + 1);
}

export function schemaView(schema: unknown, document: Json): SchemaView {
  const resolved = resolve(schema, document);
  const holder = merged(
    text(resolved.type) === "array"
      ? resolve(resolved.items, document)
      : resolved,
    document,
  );
  const required = new Set(strings(holder.required));
  const fields = isObject(holder.properties)
    ? Object.entries(holder.properties).map(([name, property]) => ({
        name,
        type: typeOf(property, document),
        required: required.has(name),
        note: noteOf(resolve(property, document)),
      }))
    : [];
  return { type: typeOf(schema, document), fields };
}

/** An allOf's parts as one object: every part's fields, and every requirement. */
function merged(schema: Json, document: Json): Json {
  if (!Array.isArray(schema.allOf)) return schema;
  const parts = [
    schema,
    ...schema.allOf.map((part) => merged(resolve(part, document), document)),
  ];
  return {
    ...schema,
    properties: Object.assign(
      {},
      ...parts.map((part) =>
        isObject(part.properties) ? part.properties : {},
      ),
    ),
    required: parts.flatMap((part) => strings(part.required)),
  };
}

/** "string", "Todo[]", "string | null", "Session": a type as a person names it. */
export function typeOf(schema: unknown, document: Json): string {
  if (!isObject(schema)) return "any";
  const ref = text(schema.$ref);
  if (ref) return ref.split("/").pop() ?? "object";
  // OpenAPI 3.0 says a null is allowed with nullable; 3.1 puts "null" in type.
  const nullable = schema.nullable === true ? " | null" : "";
  const either = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (either)
    return either.map((one) => typeOf(one, document)).join(" | ") + nullable;
  if (Array.isArray(schema.allOf))
    return schema.allOf.length === 1
      ? typeOf(schema.allOf[0], document) + nullable
      : "object" + nullable;
  if (Array.isArray(schema.type))
    return schema.type
      .map((one) =>
        one === "array"
          ? typeOf({ ...schema, type: "array" }, document)
          : String(one),
      )
      .join(" | ");
  const type = text(schema.type);
  if (type === "array") {
    const item = typeOf(schema.items, document);
    return `${item.includes(" | ") ? `(${item})` : item}[]${nullable}`;
  }
  if (Array.isArray(schema.enum))
    return schema.enum.map((one) => JSON.stringify(one)).join(" | ") + nullable;
  return (type || (isObject(schema.properties) ? "object" : "any")) + nullable;
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
  // A UI Spec is screens, each named and laid out; anything else is not one.
  if (
    !isObject(spec) ||
    !Array.isArray(spec.screens) ||
    spec.screens.length === 0 ||
    !spec.screens.every(
      (screen) =>
        isObject(screen) &&
        typeof screen.name === "string" &&
        Array.isArray(screen.elements),
    )
  )
    return null;
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
  // A page, by name or as { name, … }, and the screens drawn on it.
  const named =
    isObject(design) &&
    (typeof design.page === "string" ||
      (isObject(design.page) && typeof design.page.name === "string"));
  if (!named || !Array.isArray(design.screens)) return null;
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
