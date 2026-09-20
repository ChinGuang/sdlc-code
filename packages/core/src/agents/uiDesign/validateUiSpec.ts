/**
 * Domain checks on a UI Spec: it must agree with the Approved Documents, since
 * the Coding Agents build from both (CONTEXT.md "API Contract", "UI Spec").
 */
import type { DesignSlice } from "../systemDesign/design.js";
import { contractEndpoints } from "../systemDesign/validateDesign.js";
import { BOARD_HEIGHT, BOARD_WIDTH, type UiSpec } from "./uiSpec.js";

export type UiSpecContext = {
  slicePlan: DesignSlice[];
  apiContract: Record<string, unknown>;
};

/** Every problem with `spec`; empty when it is valid. */
export function uiSpecProblems(spec: UiSpec, context: UiSpecContext): string[] {
  const problems: string[] = [];
  const inContract = new Set(contractEndpoints(context.apiContract));
  const sliceTitles = new Set(context.slicePlan.map((slice) => slice.title));
  const names = new Set<string>();
  const routes = new Set<string>();

  for (const screen of spec.screens) {
    const where = `Screen "${screen.name}"`;
    if (names.has(screen.name))
      problems.push(`${where}: two screens have this name.`);
    names.add(screen.name);
    if (routes.has(screen.route))
      problems.push(`${where}: route ${screen.route} is used twice.`);
    routes.add(screen.route);

    if (!sliceTitles.has(screen.sliceTitle))
      problems.push(
        `${where}: sliceTitle "${screen.sliceTitle}" is not a Slice in the Slice Plan (${[...sliceTitles].join(", ")}).`,
      );

    for (const endpoint of screen.endpoints)
      if (!inContract.has(endpoint))
        problems.push(`${where}: ${endpoint} is not in the API Contract.`);

    for (const element of screen.elements) {
      if (element.x + element.width > BOARD_WIDTH)
        problems.push(
          `${where}: "${element.label}" runs past the right edge (x ${element.x} + width ${element.width} > ${BOARD_WIDTH}).`,
        );
      if (element.y + element.height > BOARD_HEIGHT)
        problems.push(
          `${where}: "${element.label}" runs past the bottom edge (y ${element.y} + height ${element.height} > ${BOARD_HEIGHT}).`,
        );
    }
  }

  // Every Slice that has endpoints needs a screen; the Walking Skeleton needs one too.
  for (const slice of context.slicePlan) {
    const screens = spec.screens.filter(
      (screen) => screen.sliceTitle === slice.title,
    );
    if (screens.length === 0)
      problems.push(`Slice "${slice.title}" has no screen.`);
  }

  // Every feature endpoint is called by some screen (GET /health is infrastructure).
  const used = new Set(spec.screens.flatMap((screen) => screen.endpoints));
  for (const endpoint of inContract)
    if (endpoint !== "GET /health" && !used.has(endpoint))
      problems.push(`No screen calls ${endpoint}.`);

  return problems;
}
