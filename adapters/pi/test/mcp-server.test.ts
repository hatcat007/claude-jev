import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildQuestions, toPayload } from "../../../src/mcp-server.ts";
import { type Questions } from "../../afk/src/shared/jev-client.ts";
import { isJsonArray, type JsonValue } from "../../afk/src/shared/json.ts";
import { at, exchange, SERVER } from "./mcp-helper.ts";

function keylessEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir };

  for (const key of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "EXPLABS_API_KEY", "CLAUDE_PLUGIN_OPTION_TYPESAFEAPIKEY", "AFK_HOOK_EVENT"]) delete env[key];

  return env;
}

test("initialize, tools/list and ping answer; a notification gets no reply", async () => {
  const replies = await exchange(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { jsonrpc: "2.0", id: 4, method: "nope" },
    ],
    keylessEnv()
  );

  assert.equal(replies.length, 4);
  assert.equal(at(replies[0], "result", "protocolVersion"), "2024-11-05");

  const tools = at(replies[1], "result", "tools");
  const names = isJsonArray(tools) ? tools.map((t) => at(t, "name")) : [];

  assert.deepEqual(names, ["jev_check", "jev_classify", "jev_score", "jev_decide"]);
  assert.deepEqual(at(replies[2], "result"), {});
  assert.equal(at(replies[3], "error", "code"), -32601);
});

test("bad input and a missing key come back as tool errors, and bad JSON as a parse error", async () => {
  const env = keylessEnv();

  const replies = await exchange(
    [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_classify", arguments: { state: "s", question: "q", options: { a: "x" } } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_check", arguments: { state: "s", question: "q" } } },
    ],
    env
  );

  assert.equal(at(replies[0], "result", "isError"), true);
  assert.equal(at(replies[1], "result", "isError"), true);
  assert.match(JSON.stringify(replies[1]), /No Jev API key/);

  const child = spawn("node", ["--experimental-strip-types", SERVER], { env, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";

  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.end("{not json\n");
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(at(JSON.parse(out), "error", "code"), -32700);
});

function wire(value: Questions): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

test("buildQuestions maps each tool to the typed question Jev expects", () => {
  assert.deepEqual(wire(buildQuestions("jev_check", { question: "Safe?", true_means: "safe", false_means: "unsafe" })), {
    answer: { type: "noul", instructions: "Safe?", criteria: { true: "safe", false: "unsafe" } },
  });
  assert.deepEqual(wire(buildQuestions("jev_classify", { question: "Which?", options: { a: "A", b: "B" } })), {
    answer: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } },
  });
  assert.deepEqual(wire(buildQuestions("jev_score", { question: "Risk?", scale: ["none", "high"] })), {
    answer: { type: "score", instructions: "Risk?", criteria: ["none", "high"] },
  });
  assert.throws(() => buildQuestions("jev_score", { question: "Risk?", scale: ["only"] }), /at least two/);
  assert.throws(() => buildQuestions("jev_decide", { questions: {} }), /between 1 and/);
  assert.throws(() => buildQuestions("other", {}), /unknown tool/);
});

test("toPayload turns a noul answer into a probability", () => {
  assert.deepEqual(toPayload("jev_check", { answer: { noul: 0.9 } }), { probability: 0.9 });
  assert.deepEqual(toPayload("jev_score", { answer: { score: 0.4 } }), { score: 0.4 });
  assert.throws(() => toPayload("jev_check", {}), /no answer/);
});

test("null-prototype maps keep a __proto__ option label and question name", () => {
  const options = JSON.parse('{"__proto__":"odd","b":"B"}');
  const built = buildQuestions("jev_classify", { question: "Which?", options });
  const sent = JSON.parse(JSON.stringify(built));

  assert.deepEqual(Object.keys(sent.answer.criteria).sort(), ["__proto__", "b"]);

  const decided = buildQuestions("jev_decide", JSON.parse('{"questions":{"__proto__":{"type":"noul","instructions":"Q?"}}}'));

  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(decided))), ["__proto__"]);
});

test("jev_decide keeps noul criteria, and jev_check rejects half a pair", () => {
  const built = buildQuestions("jev_decide", {
    questions: { safe: { type: "noul", instructions: "Safe?", criteria: { true: "safe", false: "unsafe" } } },
  });

  assert.deepEqual(built["safe"], { type: "noul", instructions: "Safe?", criteria: { true: "safe", false: "unsafe" } });
  assert.throws(() => buildQuestions("jev_check", { question: "Safe?", true_means: "safe" }), /together/);
  assert.throws(
    () => buildQuestions("jev_decide", { questions: { a: { type: "noul", instructions: "Q?", criteria: { true: "x" } } } }),
    /true and false/
  );
});

test("an id of null and a non-string method are invalid requests, and an absent id is silent", async () => {
  const replies = await exchange(
    [
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: 7, method: 5 },
      { jsonrpc: "2.0", method: "ping" },
    ],
    keylessEnv()
  );

  assert.equal(replies.length, 2);
  assert.equal(at(replies[0], "error", "code"), -32600);
  assert.equal(at(replies[0], "id"), null);
  assert.equal(at(replies[1], "error", "code"), -32600);
  assert.equal(at(replies[1], "id"), 7);
});

test("the server starts from a path containing # and ?", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-#odd?-"));

  try {
    const copy = path.join(dir, "mcp-server.ts");

    fs.symlinkSync(SERVER, copy);

    const child = spawn("node", ["--experimental-strip-types", copy], { env: keylessEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let out = "";

    child.stdout.on("data", (chunk) => (out += chunk));
    child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await new Promise((resolve) => child.on("close", resolve));
    assert.deepEqual(at(JSON.parse(out), "result"), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jev_decide advertises a typed variant for each question kind", async () => {
  const replies = await exchange([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], keylessEnv());
  const tools = at(replies[0], "result", "tools");
  const decide = isJsonArray(tools) ? tools[3] : undefined;
  const variants = at(decide, "inputSchema", "properties", "questions", "additionalProperties", "oneOf");

  assert.equal(isJsonArray(variants) ? variants.length : 0, 3);
});
