import { describe, expect, it } from "vitest";
import {
  fakePenpot,
  runPenpotCode,
  type FakeShape,
} from "./fixtures/fakePenpot.js";
import { goodUiSpec } from "./fixtures/goodUiSpec.js";
import {
  CONNECTION_CHECK_CODE,
  describeScreenCode,
  ensurePageCode,
  penpotPageUrl,
  runPageName,
  screenCode,
  sweepBoardsCode,
} from "./penpotRender.js";
import type { ScreenDescription } from "./uiCanvas.js";
import { BOARD_WIDTH } from "./uiSpec.js";

const PAGE = "#run-1 Todo app";
const spec = goodUiSpec();
const drawScreen = (index: number) =>
  screenCode({
    pageName: PAGE,
    index,
    screen: spec.screens[index]!,
    tokens: spec.tokens,
  });

describe("runPageName", () => {
  it("names the Run's page after the Run and its request (ADR 0002)", () => {
    expect(runPageName("#014", "  Todo   app\n")).toBe("#014 Todo app");
  });

  it("keeps the name short", () => {
    expect(runPageName("#1", "x".repeat(200))).toHaveLength(63);
  });
});

describe("CONNECTION_CHECK_CODE", () => {
  it("reports the connected file", async () => {
    const fake = fakePenpot("sdlc-code runs");

    expect(await runPenpotCode(fake, CONNECTION_CHECK_CODE)).toEqual({
      file: "sdlc-code runs",
      fileId: "file-abc",
      page: null,
    });
  });
});

describe("ensurePageCode", () => {
  it("creates the Run's page and opens it", async () => {
    const fake = fakePenpot();

    const result = await runPenpotCode(fake, ensurePageCode(PAGE));

    expect(result).toMatchObject({ created: true, fileId: "file-abc" });
    expect(fake.pages.map((page) => page.name)).toEqual([PAGE]);
    expect(fake.currentPageName()).toBe(PAGE);
  });

  it("reuses the page when the Run is designed again", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));

    const result = await runPenpotCode(fake, ensurePageCode(PAGE));

    expect(result).toMatchObject({ created: false });
    expect(fake.pages).toHaveLength(1);
  });
});

describe("describeScreenCode", () => {
  it("reads a drawn screen back with each element relative to its board", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));
    await runPenpotCode(fake, drawScreen(0));
    await runPenpotCode(fake, drawScreen(1));

    const described = (await runPenpotCode(
      fake,
      describeScreenCode(PAGE, "Todo list"),
    )) as ScreenDescription;

    expect(described).toMatchObject({
      name: "Todo list",
      width: BOARD_WIDTH,
      height: 800,
    });
    const button = described.elements.find(
      (element) => element.name === "button: Add",
    );
    // Board 2 sits at x = 1360; the element's position is the spec's.
    expect(button).toMatchObject({ x: 560, y: 128 });
    expect(described.elements.some((element) => element.text === "Add")).toBe(
      true,
    );
  });

  it("is null when the screen or the page is not drawn", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));

    expect(
      await runPenpotCode(fake, describeScreenCode(PAGE, "Todo list")),
    ).toBeNull();
    expect(
      await runPenpotCode(fake, describeScreenCode("#other", "Todo list")),
    ).toBeNull();
  });

  it("changes nothing in the design", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));
    await runPenpotCode(fake, drawScreen(1));
    // Shapes point back at their parent; leave that out of the snapshot.
    const snapshot = () =>
      JSON.stringify(fake.boards(PAGE)[0]!.children, (key, value: unknown) =>
        key === "parent" ? undefined : value,
      );
    const before = snapshot();

    await runPenpotCode(fake, describeScreenCode(PAGE, "Todo list"));

    expect(snapshot()).toBe(before);
  });

  it("keeps a hostile screen name inert in the generated code", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));

    await expect(
      runPenpotCode(
        fake,
        describeScreenCode(PAGE, '"); throw new Error("injected'),
      ),
    ).resolves.toBeNull();
  });
});

describe("screenCode", () => {
  it("draws a board per screen, side by side, in the Run's page", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));

    await runPenpotCode(fake, drawScreen(0));
    const second = await runPenpotCode(fake, drawScreen(1));

    const boards = fake.boards(PAGE);
    expect(boards.map((board) => board.name)).toEqual([
      "Screen: Health",
      "Screen: Todo list",
    ]);
    expect(boards.map((board) => [board.x, board.width])).toEqual([
      [0, BOARD_WIDTH],
      [BOARD_WIDTH + 80, BOARD_WIDTH],
    ]);
    expect(second).toMatchObject({ name: "Screen: Todo list" });
    expect(boards[0]?.fills).toEqual([
      { fillColor: spec.tokens.background, fillOpacity: 1 },
    ]);
  });

  it("draws each element inside its board, positioned relative to it", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));

    await runPenpotCode(fake, drawScreen(1));

    const board = fake.boards(PAGE)[0]!;
    const names = board.children.map((child) => child.name);
    expect(names).toContain("heading: Your todos");
    expect(names).toContain("button: Add");
    expect(names).toContain("input: What needs doing?");

    const button = fake.find(PAGE, "button: Add")!;
    expect([button.x, button.y, button.width, button.height]).toEqual([
      board.x + 560,
      128,
      120,
      48,
    ]);
    expect(button.fills).toEqual([
      { fillColor: spec.tokens.accent, fillOpacity: 1 },
    ]);
    const heading = fake.find(PAGE, "heading: Your todos")!;
    expect(heading).toMatchObject({
      characters: "Your todos",
      fontSize: "32",
      fontFamily: spec.tokens.fontFamily,
      growType: "auto-width",
    });
  });

  it("gives a list rows and keeps them inside the list", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));

    await runPenpotCode(fake, drawScreen(1));

    const board = fake.boards(PAGE)[0]!;
    const list = spec.screens[1]!.elements[3]!;
    const rows = board.children.filter((child) =>
      child.name.startsWith("row "),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.x).toBeGreaterThanOrEqual(board.x + list.x);
      expect(row.x + row.width).toBeLessThanOrEqual(
        board.x + list.x + list.width,
      );
      expect(row.y + row.height).toBeLessThanOrEqual(list.y + list.height);
    }
  });

  it("captions the board with the route and states", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));

    await runPenpotCode(fake, drawScreen(0));

    const board = fake.boards(PAGE)[0]!;
    const captions = board.children.filter(
      (child) => child.characters?.includes("/health") === true,
    );
    expect(captions[0]?.characters).toBe("/health  ·  loading / ok / error");
  });

  it("redraws a screen in place: no duplicate boards, no leftover shapes", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));
    await runPenpotCode(fake, drawScreen(1));
    const first = fake.boards(PAGE)[0]!;
    const before = countShapes(first);

    await runPenpotCode(fake, drawScreen(1));

    const boards = fake.boards(PAGE);
    expect(boards).toHaveLength(1);
    expect(boards[0]?.id).toBe(first.id);
    expect(countShapes(boards[0]!)).toBe(before);
  });

  it("fails the Step when Penpot cannot create a text shape", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));
    (fake.penpot as { createText: unknown }).createText = () => null;

    await expect(runPenpotCode(fake, drawScreen(0))).rejects.toThrow(
      /could not create the text/,
    );
  });

  it("refuses to draw when the Run's page is missing", async () => {
    const fake = fakePenpot();

    await expect(runPenpotCode(fake, drawScreen(0))).rejects.toThrow(
      /Page .* is missing/,
    );
  });
});

describe("sweepBoardsCode", () => {
  it("removes boards of screens the design no longer has", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));
    await runPenpotCode(fake, drawScreen(0));
    await runPenpotCode(fake, drawScreen(1));

    const result = await runPenpotCode(
      fake,
      sweepBoardsCode(PAGE, ["Todo list"]),
    );

    expect(result).toEqual({ removed: ["Screen: Health"] });
    expect(fake.boards(PAGE).map((board) => board.name)).toEqual([
      "Screen: Todo list",
    ]);
  });

  it("leaves boards nobody drew for this Run alone", async () => {
    const fake = fakePenpot();
    await runPenpotCode(fake, ensurePageCode(PAGE));
    await runPenpotCode(fake, drawScreen(0));
    await runPenpotCode(
      fake,
      `const page = penpotUtils.getPageByName(${JSON.stringify(PAGE)});
       const board = penpot.createBoard();
       board.name = "Notes by the designer";
       return null;`,
    );

    await runPenpotCode(fake, sweepBoardsCode(PAGE, ["Health"]));

    expect(fake.boards(PAGE).map((board) => board.name)).toEqual([
      "Screen: Health",
      "Notes by the designer",
    ]);
  });

  it("does nothing when the page does not exist", async () => {
    const fake = fakePenpot();

    expect(await runPenpotCode(fake, sweepBoardsCode(PAGE, []))).toEqual({
      removed: [],
    });
  });
});

describe("penpotPageUrl", () => {
  it("links to the Run's page in the workspace", () => {
    expect(
      penpotPageUrl("https://design.penpot.app/", "file-1", "page-2"),
    ).toBe("https://design.penpot.app/#/workspace/file-1?page-id=page-2");
  });
});

function countShapes(board: FakeShape): number {
  return board.children.length;
}
