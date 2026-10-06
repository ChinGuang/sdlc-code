// SPDX-License-Identifier: MPL-2.0
/**
 * Lets one piece of async work at a time through (S5): Slices built at the same
 * time take turns at the parts that change the run branch, so each is merged
 * and tested on top of what the others already committed.
 */
export class Mutex {
  #last: Promise<void> = Promise.resolve();

  /**
   * Waits for every earlier holder, then is held until the returned function
   * is called, which must happen on every path (use try/finally).
   */
  acquire = async (): Promise<() => void> => {
    const previous = this.#last;
    let release!: () => void;
    this.#last = new Promise<void>((resolve) => (release = resolve));
    await previous;
    return release;
  };

  /** Runs `work` after every earlier call has finished, whether it threw or not. */
  run = async <T>(work: () => Promise<T>): Promise<T> => {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
}
