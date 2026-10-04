import { describe, expect, it } from "vitest";
import { quoteIsShown, shownByDiff } from "./reviewDiff.js";

// As `git diff --unified=5` writes it (WorkspaceManager.runDiff).
const DIFF = [
  "diff --git a/server/app.ts b/server/app.ts",
  "index 1111111..2222222 100644",
  "--- a/server/app.ts",
  "+++ b/server/app.ts",
  "@@ -10,6 +10,7 @@ export function createApp(register) {",
  "   const app = express();",
  "   app.use(express.json());",
  "-  app.get('/old', old);",
  "+  app.get('/health', health);",
  "+  app.get('/todos', todos);",
  "   register?.(app);",
  "   return app;",
  " }",
  "diff --git a/src/Todo.tsx b/src/Todo.tsx",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/Todo.tsx",
  "@@ -0,0 +1,3 @@",
  "+export function Todo() {",
  "+++ looks like a header but is a line",
  "+}",
  "\\ No newline at end of file",
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const old = 1;",
  "-export const older = 2;",
  "",
].join("\n");

describe("shownByDiff (T25a)", () => {
  const shown = shownByDiff(DIFF);

  it("numbers the added and context lines by the new file, skipping removed ones", () => {
    const app = shown.get("server/app.ts")!;

    expect(app.get(10)).toBe("  const app = express();");
    expect(app.get(12)).toBe("  app.get('/health', health);");
    expect(app.get(13)).toBe("  app.get('/todos', todos);");
    expect(app.get(14)).toBe("  register?.(app);");
    expect(app.has(15 + 2)).toBe(false);
    expect([...app.values()].join("\n")).not.toContain("/old");
  });

  it("shows a new file whole, and keeps a line that looks like a header", () => {
    const todo = shown.get("src/Todo.tsx")!;

    expect([...todo.entries()]).toEqual([
      [1, "export function Todo() {"],
      [2, "++ looks like a header but is a line"],
      [3, "}"],
    ]);
  });

  it("shows a deleted file as nothing", () => {
    expect([...shown.keys()]).toEqual(["server/app.ts", "src/Todo.tsx"]);
  });

  it("shows nothing for text that is not a diff", () => {
    expect(shownByDiff("")).toEqual(new Map());
    expect(shownByDiff("hello\nworld")).toEqual(new Map());
  });
});

describe("quoteIsShown (T25a)", () => {
  const app = shownByDiff(DIFF).get("server/app.ts")!;

  it("finds a quote at the cited line, and a line or two off", () => {
    expect(quoteIsShown(app, 12, "app.get('/health', health);")).toBe(true);
    expect(quoteIsShown(app, 14, "app.get('/health', health);")).toBe(true);
    expect(quoteIsShown(app, 15, "app.get('/health', health);")).toBe(false);
  });

  it("ignores runs of spaces and indentation, as a model re-indents what it quotes", () => {
    expect(quoteIsShown(app, 12, "app.get('/health',   health);")).toBe(true);
    expect(quoteIsShown(app, 12, "    app.get('/health', health);")).toBe(true);
    expect(quoteIsShown(app, 10, "const   app =  express();")).toBe(true);
    // Not tokens: different code is still different.
    expect(quoteIsShown(app, 12, "app.get( '/health', health);")).toBe(false);
  });

  it("takes any line of the file for line 0, and refuses an empty quote", () => {
    expect(quoteIsShown(app, 0, "register?.(app);")).toBe(true);
    expect(quoteIsShown(app, 0, "never written")).toBe(false);
    expect(quoteIsShown(app, 12, "   ")).toBe(false);
  });

  it("does not take code the diff removed", () => {
    expect(quoteIsShown(app, 12, "app.get('/old', old);")).toBe(false);
  });
});
