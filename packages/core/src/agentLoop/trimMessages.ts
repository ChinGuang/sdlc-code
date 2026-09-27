/**
 * Keeps a Step's prompt from growing quadratically. Every turn re-sends the
 * whole conversation, so a 45-turn Step with twenty file contents in it pays
 * for those contents twenty-odd times (seen live: 322 coding turns cost 4M
 * tokens, about 12,400 per turn, for three Slices).
 *
 * Only tool results are trimmed, and only the older ones: the system prompt,
 * the Task and the model's own replies are always sent in full, so the agent
 * keeps its instructions and its train of thought. A trimmed result says what
 * it was, so the agent can read it again if it turns out to need it.
 */
import type { ChatMessage } from "@sdlc-code/clients";

/** Tool results kept in full, counting back from the newest. */
export const DEFAULT_KEEP_RECENT_RESULTS = 8;

/** What a dropped result is replaced by, so the model knows it existed. */
export function droppedNote(call: Call | null, content: string): string {
  const lines = content.split("\n").length;
  const what = call ? `${call.name} ${shortArguments(call.arguments)}` : "This";
  return `(${what} returned ${lines} line${lines === 1 ? "" : "s"}, dropped here to keep this Task short. Call it again if you still need it.)`;
}

type Call = { name: string; arguments: string };

/**
 * The messages to send this turn: the newest `keepRecent` tool results in full,
 * and every older one replaced by a note. A result that a later call has
 * already replaced (the same tool with the same arguments) is dropped whether
 * it is recent or not, because the newer one answers the same question.
 */
export function trimToolResults(
  messages: readonly ChatMessage[],
  keepRecent = DEFAULT_KEEP_RECENT_RESULTS,
): ChatMessage[] {
  const calls = callsById(messages);
  const positions = messages.flatMap((message, at) =>
    message.role === "tool" ? [at] : [],
  );
  const keep = new Set(positions.slice(-keepRecent));
  // A repeated call answers the same question, so only its last result is kept.
  const lastAsked = new Map<string, number>();
  for (const at of positions) {
    const call = calls.get(toolCallId(messages[at]!));
    if (call) lastAsked.set(`${call.name}\u0000${call.arguments}`, at);
  }

  return messages.map((message, at) => {
    if (message.role !== "tool") return message;
    const call = calls.get(message.tool_call_id) ?? null;
    const superseded = call
      ? lastAsked.get(`${call.name}\u0000${call.arguments}`) !== at
      : false;
    if (keep.has(at) && !superseded) return message;
    return { ...message, content: droppedNote(call, message.content) };
  });
}

function callsById(messages: readonly ChatMessage[]): Map<string, Call> {
  const calls = new Map<string, Call>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? [])
      calls.set(call.id, {
        name: call.function.name,
        arguments: call.function.arguments,
      });
  }
  return calls;
}

function toolCallId(message: ChatMessage): string {
  return message.role === "tool" ? message.tool_call_id : "";
}

/** Enough of the arguments to recognise the call, never a whole file. */
function shortArguments(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "{}") return "";
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}
