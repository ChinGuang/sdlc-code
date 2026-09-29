import { describe, expect, it } from "vitest";
import type { UiCanvas } from "../agents/uiDesign/uiCanvas.js";
import { LazyUiCanvas, type Connected } from "./lazyCanvas.js";

/** A canvas that says which file it is on, and counts its connections. */
function connections(options: { failFirst?: boolean } = {}) {
  let made = 0;
  let closed = 0;
  let failNext = options.failFirst ?? false;
  const connect = async (): Promise<Connected> => {
    made++;
    if (failNext) {
      failNext = false;
      throw new Error("Penpot is not open.");
    }
    return {
      canvas: {
        checkConnection: async () => ({
          file: "sdlc-code runs",
          fileId: "file-1",
          page: "Page 1",
        }),
      } as unknown as UiCanvas,
      close: async () => {
        closed++;
      },
    };
  };
  // Tests depend on the interface; only this factory knows the class.
  const lazy = new LazyUiCanvas({ connect });
  const canvas: UiCanvas & { close: () => Promise<void> } = lazy;
  return { canvas, made: () => made, closed: () => closed };
}

describe("LazyUiCanvas", () => {
  it("does not connect until something is drawn", async () => {
    const { made } = connections();

    expect(made()).toBe(0);
  });

  it("connects once, and shares that connection between callers", async () => {
    const { canvas, made } = connections();

    await Promise.all([canvas.checkConnection(), canvas.checkConnection()]);
    await canvas.checkConnection();

    expect(made()).toBe(1);
  });

  // The person opens the tab, and the next attempt carries on.
  it("forgets a failed connection, so the next attempt tries again", async () => {
    const { canvas, made } = connections({ failFirst: true });

    await expect(canvas.checkConnection()).rejects.toThrow(/not open/);
    await expect(canvas.checkConnection()).resolves.toMatchObject({
      file: "sdlc-code runs",
    });
    expect(made()).toBe(2);
  });

  it("closes a connection it made, and makes none to close", async () => {
    const unused = connections();
    await unused.canvas.close();
    expect(unused.made()).toBe(0);

    const used = connections();
    await used.canvas.checkConnection();
    await used.canvas.close();
    expect(used.closed()).toBe(1);
  });

  // A Run still going when the process stops must not open a new connection
  // that nothing will close.
  it("stays closed once closed", async () => {
    const { canvas, made } = connections();
    await canvas.close();

    await expect(canvas.checkConnection()).rejects.toThrow(/closed/);
    expect(made()).toBe(0);
  });
});
