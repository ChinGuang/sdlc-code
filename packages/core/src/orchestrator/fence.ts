// SPDX-License-Identifier: MPL-2.0
/**
 * Text for a model prompt that came from the application under test or from
 * an agent, inside a fence the prompt tells the model is data. The text
 * cannot close its own fence, so nothing in it can speak as an instruction.
 */
export function fenced(tag: string, text: string): string {
  return `<${tag}>\n${text.replaceAll(`</${tag}>`, `</ ${tag}>`)}\n</${tag}>`;
}
