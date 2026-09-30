import { describe, expect, it } from "vitest";
import { parseApiContract } from "./parse.js";

describe("parseApiContract", () => {
  // A contract whose schemas refer to each other must still be read, once.
  it("stops following references that go round in a loop", () => {
    const contract = parseApiContract(
      JSON.stringify({
        paths: {
          "/a": {
            get: {
              responses: {
                "200": {
                  description: "A",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/A" },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            A: { $ref: "#/components/schemas/B" },
            B: { $ref: "#/components/schemas/A" },
          },
        },
      }),
    );

    expect(contract?.operations[0]?.responses[0]?.body).toEqual({
      type: "A",
      fields: [],
    });
  });
});
