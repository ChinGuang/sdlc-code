/**
 * Domain checks on a design (spike T03 rule 5: validate in code), one function
 * per part so each submit tool reports only its own problems. Each problem is
 * phrased for the model, which gets them back to fix.
 */
import { Validator } from "@seriousme/openapi-schema-validator";
import { parse as parseYaml } from "yaml";
import {
  HEALTH_ENDPOINT,
  HTTP_METHODS,
  type Design,
  type DesignSlice,
} from "./design.js";
import { mermaidProblem } from "./mermaid.js";

type ApiContract = Record<string, unknown>;

/** Every problem with a whole design; empty when it is valid. */
export async function validateDesign(design: Design): Promise<string[]> {
  return [
    ...(await systemDesignProblems(design.systemDesign)),
    ...(await apiContractProblems(design.apiContract)),
    ...slicePlanProblems(design.slicePlan),
    ...sliceContractProblems(design.slicePlan, design.apiContract),
  ];
}

/** Diagram kinds every System Design needs, by their Mermaid keyword. */
const REQUIRED_DIAGRAMS: Record<string, RegExp> = {
  "a component flowchart": /^\s*(flowchart|graph)\b/,
  "a classDiagram of the domain": /^\s*classDiagram\b/,
};

export async function systemDesignProblems(
  systemDesign: Design["systemDesign"],
): Promise<string[]> {
  // A fenced diagram gets its own problem below, not a second "missing" one.
  const sources = systemDesign.diagrams.map((diagram) =>
    diagram.mermaid.replace(/^\s*```\w*\s*/, ""),
  );
  const missing = Object.entries(REQUIRED_DIAGRAMS)
    .filter(([, keyword]) => !sources.some((source) => keyword.test(source)))
    .map(([kind]) => `The System Design needs ${kind}.`);
  const problems = await Promise.all(
    systemDesign.diagrams.map(async (diagram) => {
      if (/^\s*```/.test(diagram.mermaid))
        return `Diagram "${diagram.title}": send Mermaid source without \`\`\` fences.`;
      const problem = await mermaidProblem(diagram.mermaid);
      return problem
        ? `Diagram "${diagram.title}" is not valid Mermaid: ${problem}`
        : null;
    }),
  );
  return [...missing, ...problems.filter((problem) => problem !== null)];
}

/** Reads the contract text the model sent (YAML or JSON). */
export function parseApiContract(
  text: string,
): { contract: ApiContract } | { problem: string } {
  try {
    const parsed: unknown = parseYaml(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return { contract: parsed as ApiContract };
    return {
      problem: "The API Contract must be an OpenAPI document (a mapping).",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      problem: `The API Contract is not valid YAML or JSON: ${message.split("\n")[0]}`,
    };
  }
}

export async function apiContractProblems(
  contract: ApiContract,
): Promise<string[]> {
  if (
    typeof contract.openapi !== "string" ||
    !contract.openapi.startsWith("3.")
  )
    return [
      'API Contract: "openapi" must be an OpenAPI 3 version; use "3.1.0".',
    ];
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
export function contractEndpoints(contract: ApiContract): string[] {
  const paths = (contract.paths ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.entries(paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter(
      (method) => item?.[method.toLowerCase()] !== undefined,
    ).map((method) => `${method} ${path}`),
  );
}

/** Rules on the Slice Plan alone. */
export function slicePlanProblems(slices: DesignSlice[]): string[] {
  const problems: string[] = [];
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
    if (!first.endpoints.includes(HEALTH_ENDPOINT))
      problems.push(`The Walking Skeleton must include "${HEALTH_ENDPOINT}".`);
    const features = first.endpoints.filter(
      (endpoint) => endpoint !== HEALTH_ENDPOINT,
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
  return problems;
}

/**
 * Every endpoint a Slice builds is in the contract, and every contract
 * operation is built by exactly one Slice.
 */
export function sliceContractProblems(
  slices: DesignSlice[],
  contract: ApiContract,
): string[] {
  const problems: string[] = [];
  const inContract = new Set(contractEndpoints(contract));
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
