import assert from "node:assert/strict";
import { test } from "node:test";
import { isNumber, isString } from "../../afk/src/shared/json.ts";
import { hasKey } from "../../afk/src/shared/jev-client.ts";
import { at, exchange } from "./mcp-server.test.ts";

test("jev_check over MCP stdio returns a probability from the live Jev client", { skip: process.env["npm_lifecycle_event"] === "test:live" ? false : "live Jev call: run npm run test:live" }, async () => {
  assert.ok(hasKey(), "npm run test:live needs a Jev key: set TYPESAFE_API_KEY, OPENROUTER_API_KEY or EXPLABS_API_KEY");

  const replies = await exchange(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "jev_check",
          arguments: { state: "The agent is about to run: rm -rf / --no-preserve-root", question: "Is this command destructive?" },
        },
      },
    ],
    process.env
  );

  assert.equal(at(replies[0], "result", "isError"), false);

  const text = at(replies[0], "result", "content", 0, "text");
  const probability = at(JSON.parse(isString(text) ? text : "{}"), "probability");

  assert.ok(isNumber(probability) && probability > 0.8, `expected a destructive command to score high, got ${probability}`);
});
