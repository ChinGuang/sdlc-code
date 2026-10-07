# The Sandbox as an MCP server (S6)

The isolated Nebius sandboxes that sdlc-code runs its tests in are also a small MCP server, so any MCP client (Claude Code, an IDE, another agent) can run a command in one. It is a separate tool from a Run: it does not start Runs or touch their code. It is the sandbox, and nothing else.

> **Verified.** Over a real stdio connection, with an MCP client and the Nebius key from `.env`, the server listed its four tools, reported the key's access, listed the images, uploaded a file and ran `node` on it in a disposable sandbox (0.5 s, about 0.0005 credit), and gave the output back. The protocol and every limit below are also covered by tests. Not tried: any client other than the MCP SDK's own.

## Tools

| Tool | What it does | Reads only? |
|---|---|---|
| `sandbox_whoami` | Which Sandbox permissions and limits the key has | yes |
| `sandbox_list_images` | The images a run can start from, as `tag uuid` lines, narrowed by `tagPrefix` | yes |
| `sandbox_import_image` | Imports a public image from a `docker://` URL, once, so runs can start from its tag | no |
| `sandbox_run` | Runs a shell command in a fresh sandbox started from an image, with optional text files put in first, and returns the exit code, duration, cost, stdout and stderr | no |

`sandbox_run` takes `image` (`tag:<name>` or an image id), `command`, and optionally `files` (absolute path to text contents), `cwd`, `timeoutSeconds` (default 120) and `networking`. **Every run is disposable**: nothing it writes is kept, so a later call cannot depend on an earlier one. A command that exits non-zero is an answer, not an error; a sandbox that did not run is an error.

## Start it

You need `NEBIUS_API_KEY` and `NEBIUS_AI_PROJECT` in the repository's `.env`, as for the rest of sdlc-code. The server talks over **stdio**: the client starts it, and nothing else can reach it.

```bash
pnpm --silent --filter @sdlc-code/clients sandbox:mcp
```

`--silent` matters: without it pnpm prints a banner on stdout, which is where the protocol is. To add it to Claude Code, from the repository's folder:

```bash
claude mcp add sdlc-sandbox -- pnpm --silent --filter @sdlc-code/clients sandbox:mcp
```

Any other client takes the same command, in its own configuration:

```json
{
  "mcpServers": {
    "sdlc-sandbox": {
      "command": "pnpm",
      "args": ["--silent", "--filter", "@sdlc-code/clients", "sandbox:mcp"],
      "cwd": "/path/to/sdlc-code"
    }
  }
}
```

The key comes from the repository's `.env` through the script, not from the client's configuration, so it is not copied anywhere else.

## What it protects

This puts a credit-spending tool in front of whatever model is driving the client, so it is bounded on the server side, whatever the client asks for:

| Limit | Default |
|---|---|
| Commands per server session | 50 |
| Image imports per session | 5 |
| Seconds one command may run | 600 (default 120) |
| Files uploaded with one command | 50, 200,000 bytes each, 1,000,000 together |
| Output given back | 20,000 characters each of stdout and stderr (the sandbox is asked to cut it too), then cut and said so; an error message is cut at 2,000 |
| Command length | 20,000 characters |

- **Image names are checked**: a tag or an image id; imports only from `docker://`.
- **File paths are checked**: absolute, no `..`.
- **The key never reaches the model**: it is never sent into the sandbox, and it is taken out of every reply, errors included.
- **A refused call costs nothing**: a call that fails a check does not use up a run. The server never sends a request twice (no retry), so one call is one run. The price is that a network blip fails the call (seen once in four real runs) rather than being retried: call again.
- **No state**: every run is disposable, so no image or file outlives a call.

## What it does not protect

- **The sandbox's network.** Unless a call says `networking: false`, the command may reach the network, as sdlc-code's own test runs do (they need `npm install`). A model that runs code can send what is in the sandbox, which is only what it uploaded, to anywhere.
- **Credit.** The limits bound a session, not a day: start the server again and the counters start again. Nebius's own account limits are the real ceiling.
- **Who is driving.** There is no sign-in: whoever can start the process, or the client that starts it, can use the key. Treat it as you treat the `.env` file.
- **Output as instructions.** What a command prints comes back to the model as text; a command that prints instructions is the client's problem to treat as data.
