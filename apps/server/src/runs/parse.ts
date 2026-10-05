// SPDX-License-Identifier: MPL-2.0
/**
 * A request body checked against its schema, or a 400 that names every problem
 * with the field it is in.
 */
import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

export function parse<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new BadRequestException({
    message: "The request does not fit.",
    problems: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`,
    ),
  });
}
