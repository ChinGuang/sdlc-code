/**
 * Domain checks on a submitted design (spike T03 rule 5: validate in code).
 * Each problem is phrased for the model, which gets them back to fix.
 */
import { Validator } from "@seriousme/openapi-schema-validator";
import type { Design } from "./design.js";
import { mermaidProblem } from "./mermaid.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Every problem with `design`; empty when it is valid. */
export async function validateDesign(design: Design): Promise<string[]> {
  return [
    ...(await diagramProblems(design)),
    ...(await contractProblems(design)),
    ...slicePlanProblems(design),
  ];
}

async function diagramProblems(design: Design): Promise<string[]> {
  const problems = await Promise.all(
    design.systemDesign.diagrams.map(async (diagram) => {
      if (/^\s*```/.test(diagram.mermaid))
        return `Diagram "${diagram.title}": send Mermaid source without \`\`\` fences.`;
      const problem = await mermaidProblem(diagram.mermaid);
      return problem
        ? `Diagram "${diagram.title}" is not valid Mermaid: ${problem}`
        : null;
    }),
  );
  return problems.filter((problem) => problem !== null);
}

async function contractProblems(design: Design): Promise<string[]> {
  const contract = design.apiContract;
  if (
    typeof contract.openapi !== "string" ||
    !contract.openapi.startsWith("3.")
  )
    return ['API Contract: "openapi" must be "3.1.0" (OpenAPI 3.x).'];
  const result = await new Validator().validate(contract);
  if (result.valid) return [];
  const errors = Array.isArray(result.errors) ? result.errors : [result.errors];
  return errors.slice(0, 10).map((error) => {
    const { instancePath, message } = error as {
      instancePath?: string;
      message?: string;
    };
    return `API Contract is not valid OpenAPI at "${instancePath || "/"}": ${message ?? JSON.stringify(error)}`;
  });
}

/** "GET /todos" for every operation in the contract's paths. */
export function contractEndpoints(contract: Record<string, unknown>): string[] {
  const paths = (contract.paths ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.entries(paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item?.[method] !== undefined).map(
      (method) => `${method.toUpperCase()} ${path}`,
    ),
  );
}

function slicePlanProblems(design: Design): string[] {
  const problems: string[] = [];
  const slices = design.slicePlan;
  const [first] = slices;

  // CONTEXT.md "Walking Skeleton": always first, and only infrastructure.
  if (!first?.isWalkingSkeleton)
    problems.push(
      "Slice 1 must be the Walking Skeleton (isWalkingSkeleton: true).",
    );
  slices.slice(1).forEach((slice, index) => {
    if (slice.isWalkingSkeleton)
      problems.push(
        `Slice ${index + 2} "${slice.title}": only Slice 1 is the Walking Skeleton.`,
      );
  });
  if (first?.isWalkingSkeleton) {
    if (!first.endpoints.includes("GET /health"))
      problems.push('The Walking Skeleton must include "GET /health".');
    const features = first.endpoints.filter(
      (endpoint) => !/^GET \/health\b/.test(endpoint),
    );
    if (features.length > 0)
      problems.push(
        `The Walking Skeleton is infrastructure only (template, database, health check, one empty screen); move ${features.join(", ")} to a feature Slice.`,
      );
  }

  const titles = new Set<string>();
  for (const [index, slice] of slices.entries()) {
    if (titles.has(slice.title))
      problems.push(
        `Slice ${index + 1}: the title "${slice.title}" is used twice.`,
      );
    titles.add(slice.title);
    if (slice.endpoints.length === 0)
      problems.push(
        `Slice ${index + 1} "${slice.title}" has no API Contract endpoints.`,
      );
  }

  // Every endpoint a Slice builds is in the contract, and every contract
  // operation is built by exactly one Slice.
  const inContract = new Set(contractEndpoints(design.apiContract));
  const owners = new Map<string, string[]>();
  for (const slice of slices)
    for (const endpoint of slice.endpoints) {
      if (!inContract.has(endpoint))
        problems.push(
          `Slice "${slice.title}" lists ${endpoint}, which is not in the API Contract.`,
        );
      owners.set(endpoint, [...(owners.get(endpoint) ?? []), slice.title]);
    }
  for (const endpoint of inContract) {
    const sliceTitles = owners.get(endpoint) ?? [];
    if (sliceTitles.length === 0)
      problems.push(`API Contract operation ${endpoint} is not in any Slice.`);
    if (sliceTitles.length > 1)
      problems.push(
        `${endpoint} is in more than one Slice (${sliceTitles.join(", ")}); give it to exactly one.`,
      );
  }
  return problems;
}
