import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildQuestions, toPayload } from "../../../src/mcp-server.ts";
import { isJsonArray, isJsonObject, isNumber, isString, type JsonValue } from "../../afk/src/shared/json.ts";

const SERVER = path.resolve(import.meta.dirname, "../../../src/mcp-server.ts");

export function at(value: JsonValue | undefined, ...keys: (string | number)[]): JsonValue | undefined {
  let cur = value;

  for (const key of keys) {
    if (isNumber(key) && isJsonArray(cur)) cur = cur[key];
    else if (isString(key) && isJsonObject(cur)) cur = cur[key];
    else return undefined;
  }

  return cur;
}

export async function exchange(requests: object[], env: NodeJS.ProcessEnv): Promise<JsonValue[]> {
  const child = spawn("node", ["--experimental-strip-types", SERVER], { env, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";

  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await new Promise((resolve) => child.on("close", resolve));

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function keylessEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: dir };

  for (const key of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "EXPLABS_API_KEY"]) delete env[key];

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

test("buildQuestions maps each tool to the typed question Jev expects", () => {
  assert.deepEqual(buildQuestions("jev_check", { question: "Safe?", true_means: "safe", false_means: "unsafe" }), {
    answer: { type: "noul", instructions: "Safe?", criteria: { true: "safe", false: "unsafe" } },
  });
  assert.deepEqual(buildQuestions("jev_classify", { question: "Which?", options: { a: "A", b: "B" } }), {
    answer: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } },
  });
  assert.deepEqual(buildQuestions("jev_score", { question: "Risk?", scale: ["none", "high"] }), {
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
