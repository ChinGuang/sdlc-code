/**
 * Turns a UI Spec into Penpot plugin code. The model designs the layout as
 * data; this module writes the JavaScript that runs in the user's browser, so
 * no model-written code is ever executed.
 *
 * Every snippet is self-contained (spike T02 finding 3: plugin state is lost on
 * reload) and finds-or-creates by name (finding 2: a call that failed on a
 * suspended tab may already have run).
 */
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type DesignTokens,
  type Screen,
} from "./uiSpec.js";

/** Gap between screen boards on the Run's page. */
const BOARD_GAP = 80;

/** Prefix of every screen board, so a sweep only touches boards we drew. */
const BOARD_PREFIX = "Screen: ";

/** The Run's page in the Penpot Workspace File (ADR 0002: one page per Run). */
export function runPageName(runId: string, requestTitle: string): string {
  const title = requestTitle.replace(/\s+/g, " ").trim().slice(0, 60);
  return `${runId} ${title}`.trim();
}

/**
 * U+2028 and U+2029 are valid in a JSON string but are line terminators in
 * JavaScript source, so generated code escapes them. Built with new RegExp
 * because the characters themselves cannot appear in a regex literal.
 */
const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");

/**
 * A JS literal for `value`, safe inside generated code: JSON.stringify escapes
 * quotes and backslashes, and the line separators above are escaped too.
 */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null).replace(
    LINE_SEPARATORS,
    (separator) => `\\u${separator.charCodeAt(0).toString(16)}`,
  );
}

/** Reads the connected file, to check the plugin is there before designing. */
export const CONNECTION_CHECK_CODE = `
const file = penpot.currentFile;
if (!file) throw new Error("No Penpot file is open in the plugin.");
return { file: file.name, fileId: file.id ?? null, page: penpot.currentPage?.name ?? null };
`;

/** Opens the Run's page, creating it if this Run has none yet. */
export function ensurePageCode(pageName: string): string {
  return `
const name = ${literal(pageName)};
let page = penpotUtils.getPageByName(name);
const created = !page;
if (!page) {
  page = penpot.createPage();
  page.name = name;
}
await penpot.openPage(page);
return { pageId: page.id, fileId: penpot.currentFile?.id ?? null, created };
`;
}

/**
 * Removes boards of screens the design no longer has, so a revision that
 * renames or drops a screen leaves nothing behind.
 */
export function sweepBoardsCode(
  pageName: string,
  keepScreens: string[],
): string {
  const keep = keepScreens.map((name) => `${BOARD_PREFIX}${name}`);
  return `
const pageName = ${literal(pageName)};
const keep = new Set(${literal(keep)});
const prefix = ${literal(BOARD_PREFIX)};
const page = penpotUtils.getPageByName(pageName);
if (!page) return { removed: [] };
const stale = [...(page.root.children ?? [])].filter(
  (shape) => shape.type === "board" && shape.name.startsWith(prefix) && !keep.has(shape.name),
);
for (const board of stale) board.remove();
return { removed: stale.map((board) => board.name) };
`;
}

/** The workspace link to a Run's page, for the Design Gate (ADR 0002). */
export function penpotPageUrl(
  origin: string,
  fileId: string,
  pageId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/#/workspace/${fileId}?page-id=${pageId}`;
}

/** Draws one screen as a board, replacing what an earlier attempt left behind. */
export function screenCode(request: {
  pageName: string;
  index: number;
  screen: Screen;
  tokens: DesignTokens;
}): string {
  const { pageName, index, screen, tokens } = request;
  return `
const pageName = ${literal(pageName)};
const screen = ${literal(screen)};
const tokens = ${literal(tokens)};
const prefix = ${literal(BOARD_PREFIX)};
const boardX = ${index * (BOARD_WIDTH + BOARD_GAP)};
const boardWidth = ${BOARD_WIDTH};
const boardHeight = ${BOARD_HEIGHT};

const page = penpotUtils.getPageByName(pageName);
if (!page) throw new Error("Page " + pageName + " is missing; create it first.");
await penpot.openPage(page);

const boardName = prefix + screen.name;
let board = penpotUtils.findShape((s) => s.type === "board" && s.name === boardName, page.root);
if (board) {
  // Redraw from scratch: a partly finished attempt must not leave old shapes.
  for (const child of [...(board.children ?? [])]) child.remove();
} else {
  board = penpot.createBoard();
  board.name = boardName;
}
board.resize(boardWidth, boardHeight);
board.x = boardX;
board.y = 0;
board.fills = [{ fillColor: tokens.background, fillOpacity: 1 }];

const fill = (color) => [{ fillColor: color, fillOpacity: 1 }];

function place(shape, element) {
  board.appendChild(shape);
  shape.x = boardX + element.x;
  shape.y = element.y;
}

function addText(element, text, size, color) {
  const content = String(text == null ? "" : text).trim();
  // Penpot refuses to create an empty text (seen live); an element whose
  // label is blank is drawn without one, rather than failing the design.
  if (!content) return null;
  const shape = penpot.createText(content);
  // A screen missing its text must fail the Step, not be reported as drawn.
  if (!shape) throw new Error("Penpot could not create the text " + JSON.stringify(content));
  shape.name = element.kind + ": " + element.label;
  place(shape, element);
  shape.growType = "auto-width";
  shape.fontSize = String(size);
  shape.fontFamily = tokens.fontFamily;
  shape.fills = fill(color);
  return shape;
}

function addBox(element, color, radius) {
  const shape = penpot.createRectangle();
  shape.name = element.kind + ": " + element.label;
  place(shape, element);
  shape.resize(element.width, element.height);
  shape.fills = fill(color);
  shape.borderRadius = radius;
  return shape;
}

function addLabel(element, text, size, color, insetX, insetY) {
  return addText(
    { ...element, x: element.x + insetX, y: element.y + insetY },
    text,
    size,
    color,
  );
}

for (const element of screen.elements) {
  switch (element.kind) {
    case "heading":
      addText(element, element.label, 32, tokens.text);
      break;
    case "text":
      addText(element, element.label, 16, tokens.text);
      break;
    case "button":
      addBox(element, tokens.accent, 8);
      addLabel(element, element.label, 16, tokens.background, 16, Math.max(0, element.height / 2 - 10));
      break;
    case "input":
      addBox(element, tokens.surface, 8);
      addLabel(element, element.label, 16, tokens.text, 16, Math.max(0, element.height / 2 - 10));
      break;
    case "nav":
    case "card":
    case "image":
      addBox(element, tokens.surface, 12);
      addLabel(element, element.label, 16, tokens.text, 16, 12);
      break;
    case "list": {
      addBox(element, tokens.surface, 12);
      addLabel(element, element.label, 16, tokens.text, 16, 12);
      const rowHeight = 56;
      const rows = Math.max(0, Math.floor((element.height - 48) / (rowHeight + 8)));
      for (let row = 0; row < Math.min(rows, 4); row++) {
        const rowShape = penpot.createRectangle();
        rowShape.name = "row " + (row + 1);
        const rowElement = {
          x: element.x + 16,
          y: element.y + 48 + row * (rowHeight + 8),
          width: element.width - 32,
          height: rowHeight,
        };
        place(rowShape, rowElement);
        rowShape.resize(rowElement.width, rowElement.height);
        rowShape.fills = fill(tokens.background);
        rowShape.borderRadius = 8;
      }
      break;
    }
    default:
      addBox(element, tokens.surface, 8);
  }
}

const caption = addText(
  { kind: "caption", label: screen.route, x: 64, y: boardHeight - 56 },
  screen.route + "  ·  " + screen.states.join(" / "),
  14,
  tokens.text,
);
if (caption) caption.name = "caption";

return { boardId: board.id, name: boardName };
`;
}

/** Most elements read back from one screen; a drawn screen has far fewer. */
const MAX_DESCRIBED_ELEMENTS = 300;

/**
 * Reads a drawn screen back, read-only, for a Coding Agent: every element
 * with its text, position relative to the board, size and first fill. A human
 * may have adjusted the board since it was drawn. Null if it is not there.
 */
export function describeScreenCode(
  pageName: string,
  screenName: string,
): string {
  return `
const pageName = ${literal(pageName)};
const boardName = ${literal(BOARD_PREFIX + screenName)};
const limit = ${MAX_DESCRIBED_ELEMENTS};
const page = penpotUtils.getPageByName(pageName);
if (!page) return null;
const board = penpotUtils.findShape((s) => s.type === "board" && s.name === boardName, page.root);
if (!board) return null;
const elements = [];
const walk = (shape) => {
  for (const child of shape.children ?? []) {
    if (elements.length >= limit) return;
    elements.push({
      type: child.type,
      name: child.name,
      text: child.type === "text" ? (child.characters ?? null) : null,
      x: Math.round(child.x - board.x),
      y: Math.round(child.y - board.y),
      width: Math.round(child.width),
      height: Math.round(child.height),
      fill: child.fills?.[0]?.fillColor ?? null,
    });
    walk(child);
  }
};
walk(board);
return {
  name: ${literal(screenName)},
  width: Math.round(board.width),
  height: Math.round(board.height),
  elements,
};
`;
}
