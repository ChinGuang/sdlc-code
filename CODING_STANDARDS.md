# Coding standards

Rules for code in this repository. Code review checks every change against this file; T04 turns what it can into lint rules.

Terms follow [CONTEXT.md](CONTEXT.md).

## Services and clients

A **service or client** is anything that holds configuration or state and talks to something else: API clients (Token Factory, Sandboxes, Penpot MCP, GitHub), agents, the Orchestrator, repositories, the workspace manager.

### SC-1 Class behind an exported interface

Export an `interface` describing what callers need, and a `class` that `implements` it. Callers, other modules and tests depend on the **interface**; only the composition root (or a single test factory) names the class.

```ts
export interface PenpotClient {
  executeCode: <T = unknown>(code: string) => Promise<T>;
}

export class McpPenpotClient implements PenpotClient { … }
```

Name the class after what backs it (`McpPenpotClient`, `NebiusSandboxClient`), not `…Impl`.

### SC-2 Private state uses `#private`

Private fields and helper methods use JavaScript `#private` members, **never** TypeScript's `private` keyword. `#private` is enforced at runtime: the value is not reachable through `obj.field`, `Object.keys`, `JSON.stringify`, logging, or a debugger's property list, and TypeScript's `private` is erased at compile time.

This is **mandatory for tokens, API keys and URLs that embed credentials**.

```ts
class NebiusSandboxClient implements SandboxClient {
  #token: string;
  #request = …          // or: async #request(…) { … }
}
```

Do not use TypeScript parameter properties (`constructor(private readonly x)`); assign `#fields` in the constructor body.

### SC-3 Public methods are arrow-function properties

Write public methods as arrow-function class properties, so they keep `this` when passed as callbacks (`items.map(client.run)`, `{ executeCode } = client`) without `.bind`.

```ts
executeCode = async <T = unknown>(code: string): Promise<T> => { … };
```

Private `#methods` may be ordinary methods; they are never handed out as callbacks.

### SC-4 Pure helpers stay functions

Stateless, pure helpers (parsing, formatting, classification, redaction) remain plain exported functions, e.g. `redactToken`, `classifyPenpotError`, `decodeStream`. Do not wrap them in a class.

### SC-5 Tests

- Tests type their subject as the interface (`const client: PenpotClient = new McpPenpotClient(…)`) and inject fakes for transport, time and sleep through constructor options.
- A client that holds secrets has a test proving they are not exposed (`Object.keys`, `JSON.stringify`, `in`).

## Formatting

Prettier with default settings (the repository stores LF line endings; Windows checkouts may show CRLF).

## Enforcement

| Rule | Enforced by (proved in `tests/codingStandards.test.ts`) |
|---|---|
| SC-2 no `private` / parameter properties | ESLint `no-restricted-syntax` on `[accessibility="private"]` and `TSParameterProperty` |
| SC-3 public methods are arrow properties | ESLint `no-restricted-syntax` on public `MethodDefinition[kind="method"]` in classes that implement an interface (constructors and `#private` methods excluded) |
| SC-1, SC-4, SC-5 | Code review |
| Formatting | `pnpm format:check` in CI (`.github/workflows/ci.yml`) |
