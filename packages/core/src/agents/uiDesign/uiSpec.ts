/**
 * The UI Spec (CONTEXT.md): the text description of every screen, and the
 * source of truth for frontend work. Each screen also carries its layout as
 * data, which the renderer turns into a Penpot board; the model never writes
 * the plugin code that runs.
 */
import { z } from "zod";
import { ENDPOINT_PATTERN } from "../systemDesign/design.js";

/** What a screen element is; the renderer draws each kind. */
export const ELEMENT_KINDS = [
  "heading",
  "text",
  "button",
  "input",
  "list",
  "card",
  "image",
  "nav",
] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** Board size every screen is designed on (desktop). */
export const BOARD_WIDTH = 1280;
export const BOARD_HEIGHT = 800;

const Element = z.object({
  kind: z.enum(ELEMENT_KINDS),
  label: z.string().describe("The text shown, or a short placeholder"),
  x: z.number().min(0).max(BOARD_WIDTH),
  y: z.number().min(0).max(BOARD_HEIGHT),
  width: z.number().positive().max(BOARD_WIDTH),
  height: z.number().positive().max(BOARD_HEIGHT),
});

const Screen = z.object({
  name: z.string().min(1).describe('e.g. "Todo list"'),
  route: z.string().regex(/^\//, 'must start with "/"'),
  purpose: z
    .string()
    .min(1)
    .describe("What the user does here, in one sentence"),
  sliceTitle: z.string().min(1).describe("The Slice this screen belongs to"),
  endpoints: z
    .array(z.string().regex(ENDPOINT_PATTERN, 'must look like "GET /todos"'))
    .describe("API Contract operations this screen calls"),
  states: z
    .array(z.string())
    .describe('States the screen has, e.g. ["loading", "empty", "error"]'),
  elements: z.array(Element).min(1).describe("Layout on a 1280x800 board"),
});

/** Colours and type the renderer uses, shared by every screen. */
const DesignTokens = z.object({
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  fontFamily: z.string().min(1).describe('e.g. "Inter"'),
});

export const UiSpecSchema = z.object({
  tokens: DesignTokens,
  screens: z.array(Screen).min(1),
});

export type UiSpec = z.infer<typeof UiSpecSchema>;
export type Screen = z.infer<typeof Screen>;
export type UiElement = z.infer<typeof Element>;
export type DesignTokens = z.infer<typeof DesignTokens>;
