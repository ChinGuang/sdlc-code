// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { Mutex } from "./mutex.js";

describe("Mutex", () => {
  it("lets one piece of work at a time through, in the order it was asked", async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    const work = (name: string, ms: number) =>
      mutex.run(async () => {
        log.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`end ${name}`);
        return name;
      });

    const results = await Promise.all([
      work("a", 30),
      work("b", 5),
      work("c", 1),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });

  it("goes on after work that threw, and still throws it to its caller", async () => {
    const mutex = new Mutex();

    const failed = mutex.run(async () => {
      throw new Error("boom");
    });
    const next = mutex.run(async () => "after");

    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("after");
  });

  it("is held until released, and a release frees the next waiter", async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();
    let got = false;
    const waiting = mutex.acquire().then((again) => {
      got = true;
      again();
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(got).toBe(false);
    release();
    await waiting;

    expect(got).toBe(true);
  });
});
