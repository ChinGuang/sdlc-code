import type { ChatMessage } from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { trimToolResults } from "./trimMessages.js";

let callId = 0;

/** One turn: the model calls a tool, the tool answers. */
function turn(
  name: string,
  args: Record<string, unknown>,
  result: string,
): ChatMessage[] {
  const id = `call-${++callId}`;
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

const task: ChatMessage[] = [
  { role: "system", content: "You are the Backend Coding Agent." },
  { role: "user", content: "Your Task: build the backend of Slice 1." },
];

const contents = (messages: ChatMessage[]) =>
  messages
    .filter((message) => message.role === "tool")
    .map((message) => (message.role === "tool" ? message.content : ""));

describe("trimToolResults", () => {
  it("keeps the newest results in full and notes the older ones", () => {
    const messages = [
      ...task,
      ...turn("read_file", { path: "a.ts" }, "contents of a"),
      ...turn("read_file", { path: "b.ts" }, "contents of b"),
      ...turn("read_file", { path: "c.ts" }, "contents of c"),
    ];

    expect(contents(trimToolResults(messages, 2))).toEqual([
      expect.stringMatching(/read_file .*a\.ts.* returned 1 line, dropped/),
      "contents of b",
      "contents of c",
    ]);
  });

  it("never touches the Task or the model's own replies", () => {
    const messages = [...task, ...turn("list_files", {}, "a.ts\nb.ts")];

    const trimmed = trimToolResults(messages, 0);

    expect(trimmed[0]).toEqual(messages[0]);
    expect(trimmed[1]).toEqual(messages[1]);
    expect(trimmed[2]).toEqual(messages[2]);
    expect(trimmed).toHaveLength(messages.length);
  });

  it("keeps every message's tool_call_id, so the calls still pair up", () => {
    const messages = [
      ...task,
      ...turn("read_file", { path: "a.ts" }, "a"),
      ...turn("read_file", { path: "b.ts" }, "b"),
    ];

    const trimmed = trimToolResults(messages, 1);

    expect(trimmed.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    for (const [at, message] of trimmed.entries())
      if (message.role === "tool")
        expect(message.tool_call_id).toBe(
          (messages[at] as { tool_call_id: string }).tool_call_id,
        );
  });

  // The agent is told not to re-read a file, and does it anyway.
  it("drops a result a later identical call has already answered", () => {
    const messages = [
      ...task,
      ...turn("read_file", { path: "a.ts" }, "old contents of a"),
      ...turn("read_file", { path: "a.ts" }, "new contents of a"),
    ];

    expect(contents(trimToolResults(messages, 8))).toEqual([
      expect.stringMatching(/dropped here/),
      "new contents of a",
    ]);
  });

  it("tells the agent it may ask again, and says how much was dropped", () => {
    const messages = [
      ...task,
      ...turn("read_file", { path: "server/app.ts" }, "one\ntwo\nthree"),
      ...turn("list_files", {}, "a.ts"),
    ];

    const [dropped] = contents(trimToolResults(messages, 1));

    expect(dropped).toContain("read_file");
    expect(dropped).toContain("server/app.ts");
    expect(dropped).toContain("3 lines");
    expect(dropped).toContain("Call it again if you still need it.");
  });

  it("leaves a conversation with nothing to trim as it is", () => {
    expect(trimToolResults(task, 8)).toEqual(task);
  });
});
