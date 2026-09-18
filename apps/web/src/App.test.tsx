import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("App", () => {
  it("renders the product name and the Runs heading", () => {
    const html = renderToString(<App />);

    expect(html).toContain("sdlc-code");
    expect(html).toMatch(/<h1[^>]*>Runs<\/h1>/);
  });
});
