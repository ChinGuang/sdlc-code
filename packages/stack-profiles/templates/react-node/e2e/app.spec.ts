import { expect, test } from "@playwright/test";

/**
 * The template's browser smoke test: the app opens in a real browser and
 * reaches its API through the dev server's proxy. It checks what every
 * version of the app must keep true, not what any one screen says.
 */
test("the app renders without an uncaught error and reaches its API", async ({
  page,
}) => {
  // The stack, not only the message: it names the file that threw.
  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(error.stack ?? error.message));

  await page.goto("/");
  // Not "networkidle": a screen that polls or streams is never idle.
  const rendered = await expect(page.locator("#root"))
    .not.toBeEmpty()
    .then(
      () => true,
      () => false,
    );

  // First: an uncaught error is the cause, and an empty page only its effect.
  expect(uncaught).toEqual([]);
  expect(rendered, "#root stayed empty").toBe(true);

  const health = await page.request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok", database: "up" });
});
