/**
 * What the System Design Agent hands back: the System Design (Mermaid), the
 * Slice Plan and the API Contract (OpenAPI). The agent submits each part with its
 * own tool (the *Part schemas below); validateDesign checks a whole design.
 */
import { z } from "zod";

/** HTTP methods an OpenAPI path item can hold, as Slices write them. */
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

/** An API Contract operation as Slices reference it, e.g. "GET /todos/{id}". */
export const ENDPOINT_PATTERN = new RegExp(
  String.raw`^(${HTTP_METHODS.join("|")}) /\S*$`,
);

/** The Walking Skeleton's one endpoint (CONTEXT.md "Walking Skeleton"). */
export const HEALTH_ENDPOINT = "GET /health";

const Diagram = z.object({
  title: z.string().min(1).describe('e.g. "Components"'),
  mermaid: z
    .string()
    .min(1)
    .describe(
      'Mermaid source only, without ``` fences (flowchart, classDiagram, sequenceDiagram, erDiagram or stateDiagram-v2). Quote labels with punctuation: A["API client (fetch)"]',
    ),
});

const DesignSlice = z.object({
  title: z.string().min(1),
  goal: z
    .string()
    .min(1)
    .describe("What a user can do once this Slice is built"),
  isWalkingSkeleton: z
    .boolean()
    .default(false)
    .describe("true only for Slice 1"),
  endpoints: z
    .array(z.string().regex(ENDPOINT_PATTERN, 'must look like "GET /todos"'))
    .describe(
      'API Contract operations this Slice builds, e.g. ["GET /todos", "POST /todos"]',
    ),
});

/** Input of submit_system_design. */
export const SystemDesignPart = z.object({
  overview: z
    .string()
    .min(1)
    .describe("Architecture in a few paragraphs of Markdown"),
  diagrams: z.array(Diagram).min(1),
});

/** Input of submit_slice_plan. */
export const SlicePlanPart = z.object({
  slices: z
    .array(DesignSlice)
    .min(1)
    .describe("Ordered Slices; the first is always the Walking Skeleton"),
});

/**
 * Input of submit_api_contract. The contract travels as text: Nemotron breaks
 * large JSON objects nested inside tool arguments (seen live in T09), and YAML
 * has no braces to balance.
 */
export const ApiContractPart = z.object({
  openapi: z
    .string()
    .min(1)
    .describe(
      "The OpenAPI 3.1.0 document as YAML (preferred) or JSON text, covering every endpoint of every Slice",
    ),
});

export const DesignSchema = z.object({
  systemDesign: SystemDesignPart,
  slicePlan: SlicePlanPart.shape.slices,
  apiContract: z.record(z.string(), z.unknown()),
});

export type Design = z.infer<typeof DesignSchema>;
export type DesignSlice = z.infer<typeof DesignSlice>;
