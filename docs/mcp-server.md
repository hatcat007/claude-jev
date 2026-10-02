# Jev MCP server

`src/mcp-server.ts` is a stdio [MCP](https://modelcontextprotocol.io) server that exposes Jev's typed judgments to any host that can launch an MCP server: [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), OpenCode, Cursor, Codex, and Claude Code itself. It is separate from the hooks: hooks are fences the agent cannot skip, these tools are lenses the agent chooses to use. It is opt-in and nothing in the hooks depends on it.

It uses the same client as the hooks, so it reads the same key variables (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`) and writes each call to `jev-calls.jsonl`, which the Stats row counts under the caller `mcp-server`. It has no dependencies beyond Node 22.18 or newer.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `jev_check` | `state`, `question`, optional `true_means` and `false_means` | `{"probability": 0..1}` |
| `jev_classify` | `state`, `question`, `options` (label to meaning, at least two) | `{"choice", "confidence", "probabilities"}` |
| `jev_score` | `state`, `question`, `scale` (ordered descriptions, lowest first) | `{"score": 0..1}` |
| `jev_decide` | `state`, `questions` (name to a `noul`, `choice` or `score` question, up to 16) | answers keyed by name |

A bad argument, a missing key, or a Jev failure comes back as a tool result with `isError: true` and a message. The server never exits on a bad request.

## Prime Agent

Add a stdio server to `~/.prime/agent/settings.json`, or `.prime/agent/settings.json` in a project. The `env` form reads the key from Prime Agent's own environment, so the secret stays out of the file:

```json
{
  "mcpServers": {
    "jev": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "/absolute/path/to/claude-jev/src/mcp-server.ts"],
      "env": { "TYPESAFE_API_KEY": { "env": "TYPESAFE_API_KEY" } },
      "callTimeoutMs": 30000
    }
  }
}
```

Or with its CLI:

```bash
prime-agent mcp add jev --env TYPESAFE_API_KEY=TYPESAFE_API_KEY -- node --experimental-strip-types /absolute/path/to/claude-jev/src/mcp-server.ts
prime-agent mcp list
```

Prime Agent's docs describe the settings shape above; this repository has not run Prime Agent against the server. The protocol is covered by `npm run test:pi`, and the live path by `npm run test:live`.

## Other hosts

Any host that takes a `command` and `args` works the same way. Claude Code:

```bash
claude mcp add jev -e TYPESAFE_API_KEY="$TYPESAFE_API_KEY" -- node --experimental-strip-types /absolute/path/to/claude-jev/src/mcp-server.ts
```

OpenCode can use this server in place of the third-party one in [opencode-setup.md](opencode-setup.md) by swapping the `command` array.

## Try it by hand

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"jev_check","arguments":{"state":"About to run rm -rf /","question":"Is this destructive?"}}}' \
  | node --experimental-strip-types src/mcp-server.ts
```
