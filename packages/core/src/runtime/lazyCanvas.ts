/**
 * A UiCanvas that connects to Penpot the first time a Run actually draws
 * something (T21). The server starts before any browser tab exists, and a Run
 * that never reaches its Design Phase — one resumed halfway through building —
 * must not need one at all.
 *
 * The connection is made once and shared: one tab serves every Run (ADR 0002).
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type {
  DrawScreenRequest,
  DrawnBoard,
  PenpotFileInfo,
  RunPage,
  ScreenDescription,
  UiCanvas,
} from "../agents/uiDesign/uiCanvas.js";

export type Connected = {
  canvas: UiCanvas;
  /** Closes the connection; called by `close` if one was ever made. */
  close: () => Promise<void>;
};

export type LazyUiCanvasOptions = {
  /** Connects and returns the canvas; called at most once. */
  connect: () => Promise<Connected>;
};

export class LazyUiCanvas implements UiCanvas {
  #connect: () => Promise<Connected>;
  #connected: Promise<Connected> | null = null;
  #closed = false;

  constructor(options: LazyUiCanvasOptions) {
    this.#connect = options.connect;
  }

  checkConnection = async (): Promise<PenpotFileInfo> =>
    (await this.#canvas()).checkConnection();

  ensurePage = async (pageName: string): Promise<RunPage> =>
    (await this.#canvas()).ensurePage(pageName);

  drawScreen = async (request: DrawScreenRequest): Promise<DrawnBoard> =>
    (await this.#canvas()).drawScreen(request);

  sweepBoards = async (
    pageName: string,
    keepScreens: string[],
  ): Promise<string[]> =>
    (await this.#canvas()).sweepBoards(pageName, keepScreens);

  exportBoard = async (boardId: string): Promise<ExportedImage> =>
    (await this.#canvas()).exportBoard(boardId);

  describeScreen = async (
    pageName: string,
    screenName: string,
  ): Promise<ScreenDescription | null> =>
    (await this.#canvas()).describeScreen(pageName, screenName);

  /**
   * Closes the connection if one was made. A closed canvas stays closed: a Run
   * still going when its process shuts down must not open a new connection
   * that nothing will close.
   */
  close = async (): Promise<void> => {
    this.#closed = true;
    const connected = this.#connected;
    this.#connected = null;
    if (!connected) return;
    await connected.then(({ close }) => close()).catch(() => {});
  };

  async #canvas(): Promise<UiCanvas> {
    if (this.#closed) throw new Error("The Penpot connection is closed.");
    // A failed connection is not remembered: the person opens the tab and the
    // next attempt tries again, rather than the Run being stuck for ever.
    if (!this.#connected)
      this.#connected = this.#connect().catch((error: unknown) => {
        this.#connected = null;
        throw error;
      });
    return (await this.#connected).canvas;
  }
}
