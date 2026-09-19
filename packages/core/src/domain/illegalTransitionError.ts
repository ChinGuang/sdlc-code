/** A lifecycle event that the Run, Document or Slice diagram has no arrow for. */
export class IllegalTransitionError extends Error {
  constructor(entity: string, status: string, event: string) {
    super(`${entity} cannot handle "${event}" while "${status}"`);
    this.name = "IllegalTransitionError";
  }
}
