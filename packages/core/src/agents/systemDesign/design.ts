/**
 * What the System Design Agent hands back: the System Design (Mermaid), the
 * Slice Plan and the API Contract (OpenAPI). The agent submits all three in one
 * `submit_design` tool call, validated against this schema and validateDesign.
 */
import { z } from "zod";

/** An API Contract operation as Slices reference it, e.g. "GET /todos/{id}". */
export const ENDPOINT_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;

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

export const DesignSubmission = z.object({
  systemDesign: z.object({
    overview: z
      .string()
      .min(1)
      .describe("Architecture in a few paragraphs of Markdown"),
    diagrams: z.array(Diagram).min(1),
  }),
  slicePlan: z
    .array(DesignSlice)
    .min(1)
    .describe("Ordered Slices; the first is always the Walking Skeleton"),
  apiContract: z
    .record(z.string(), z.unknown())
    .describe("OpenAPI 3.1 document covering every endpoint of every Slice"),
});

export type Design = z.infer<typeof DesignSubmission>;
export type DesignSlice = z.infer<typeof DesignSlice>;
