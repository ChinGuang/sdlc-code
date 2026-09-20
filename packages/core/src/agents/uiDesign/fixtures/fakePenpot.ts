/**
 * A small stand-in for the Penpot plugin API, enough to run the code
 * penpotRender.ts generates. Tests execute the real generated code against it,
 * so board reuse and layout are checked, not just the text of the code.
 */
export type FakeFill = { fillColor: string; fillOpacity: number };

export type FakeShape = {
  id: string;
  type: "board" | "rect" | "text";
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fills: FakeFill[];
  characters?: string;
  fontSize?: string;
  fontFamily?: string;
  growType?: string;
  borderRadius?: number;
  children: FakeShape[];
  parent: FakeShape | null;
  appendChild: (child: FakeShape) => void;
  resize: (width: number, height: number) => void;
  remove: () => void;
};

export type FakePage = { id: string; name: string; root: FakeShape };

export type FakePenpot = {
  penpot: Record<string, unknown>;
  penpotUtils: Record<string, unknown>;
  pages: FakePage[];
  currentPageName: () => string | null;
  boards: (pageName: string) => FakeShape[];
  find: (pageName: string, name: string) => FakeShape | undefined;
};

export function fakePenpot(fileName = "sdlc-code runs"): FakePenpot {
  let nextId = 0;
  const pages: FakePage[] = [];
  let current: FakePage | null = null;

  const makeShape = (type: FakeShape["type"], name: string): FakeShape => {
    const shape: FakeShape = {
      id: `shape-${++nextId}`,
      type,
      name,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fills: [],
      children: [],
      parent: null,
      appendChild: (child) => {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = shape;
        shape.children.push(child);
      },
      resize: (width, height) => {
        shape.width = width;
        shape.height = height;
      },
      remove: () => {
        const siblings = shape.parent?.children;
        if (siblings) siblings.splice(siblings.indexOf(shape), 1);
        shape.parent = null;
      },
    };
    return shape;
  };

  const orphans: FakeShape[] = [];
  const adopt = (shape: FakeShape): FakeShape => {
    // Penpot adds new shapes to the current page until they are re-parented.
    if (current) current.root.appendChild(shape);
    else orphans.push(shape);
    return shape;
  };

  const walk = (shape: FakeShape): FakeShape[] => [
    shape,
    ...shape.children.flatMap(walk),
  ];

  const penpot = {
    get currentFile() {
      return { name: fileName, id: "file-abc" };
    },
    get currentPage() {
      return current;
    },
    get root() {
      return current?.root ?? null;
    },
    createPage: () => {
      const page: FakePage = {
        id: `page-${++nextId}`,
        name: "Page",
        root: makeShape("board", "Root"),
      };
      pages.push(page);
      return page;
    },
    openPage: async (page: FakePage) => {
      current = page;
    },
    createBoard: () => adopt(makeShape("board", "Board")),
    createRectangle: () => adopt(makeShape("rect", "Rectangle")),
    createText: (text: string) => {
      const shape = adopt(makeShape("text", "Text"));
      shape.characters = text;
      return shape;
    },
  };

  const penpotUtils = {
    getPageByName: (name: string) =>
      pages.find((page) => page.name === name) ?? null,
    getPages: () => pages.map(({ id, name }) => ({ id, name })),
    findShape: (
      predicate: (shape: FakeShape) => boolean,
      root?: FakeShape | null,
    ) => {
      const roots = root ? [root] : pages.map((page) => page.root);
      return roots.flatMap(walk).find(predicate) ?? null;
    },
  };

  const pageByName = (name: string) => pages.find((page) => page.name === name);

  return {
    penpot,
    penpotUtils,
    pages,
    currentPageName: () => current?.name ?? null,
    boards: (pageName) => {
      const page = pageByName(pageName);
      return page ? page.root.children.filter((s) => s.type === "board") : [];
    },
    find: (pageName, name) => {
      const page = pageByName(pageName);
      return page
        ? walk(page.root).find((shape) => shape.name === name)
        : undefined;
    },
  };
}

/** Runs generated Penpot plugin code against the fake API. */
export async function runPenpotCode(
  fake: FakePenpot,
  code: string,
): Promise<unknown> {
  const run = new Function(
    "penpot",
    "penpotUtils",
    `return (async () => {\n${code}\n})();`,
  ) as (
    penpot: Record<string, unknown>,
    penpotUtils: Record<string, unknown>,
  ) => Promise<unknown>;
  return run(fake.penpot, fake.penpotUtils);
}
