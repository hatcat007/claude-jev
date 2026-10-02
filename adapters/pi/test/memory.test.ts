import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Answers } from "../../afk/src/shared/jev-client.ts";
import {
  candidates,
  memoryDir,
  memoryQuestions,
  noteFile,
  verdict,
  MAX_CANDIDATES,
} from "../../../src/compact/memory.ts";
import { decide, lastTurn } from "../../../src/completion.ts";

const user = (text: string) => ({ role: "user", text });

test("candidates keep only mid-length user messages", () => {
  const out = candidates([
    user("short"),
    { role: "assistant", text: "an assistant reply that is long enough to count" },
    user("<command-name>/compact</command-name> long enough text"),
    user("I always want tests written before the implementation in this repo."),
    user("x".repeat(2000)),
  ]);

  assert.deepEqual(out.map((c) => c.i), [3]);
});

test("candidates cap at the most recent MAX_CANDIDATES", () => {
  const many = Array.from({ length: MAX_CANDIDATES + 10 }, (_, i) => user(`standing preference number ${i} for this project`));
  const out = candidates(many);

  assert.equal(out.length, MAX_CANDIDATES);
  assert.equal(out[0]!.i, 10);
});

test("memoryQuestions makes a noul and a choice per candidate", () => {
  const qs = memoryQuestions([{ i: 0, text: "a" }, { i: 5, text: "b" }]);

  assert.deepEqual(Object.keys(qs), ["memory_0", "mtype_0", "memory_1", "mtype_1"]);
  assert.equal(qs["memory_1"]!.type, "noul");
  assert.equal(qs["mtype_1"]!.type, "choice");
});

test("verdict clamps the noul and falls back to feedback", () => {
  const answers: Answers = {
    memory_0: { noul: 1.4 },
    mtype_0: { choice: "reference", confidence: 0.9 },
    memory_1: { noul: 0.3 },
  };

  assert.deepEqual(verdict(answers, 0), { p: 1, type: "reference" });
  assert.deepEqual(verdict(answers, 1), { p: 0.3, type: "feedback" });
  assert.deepEqual(verdict(answers, 2), { p: 0, type: "feedback" });
});

test("noteFile writes verbatim text with frontmatter", () => {
  const [name, body] = noteFile("Never use emojis in commits: ever.", "feedback", "abcdef123456", "2026-10-02");

  assert.match(name, /^never-use-emojis-in-commits-ever-[0-9a-f]{6}$/);
  assert.ok(body.startsWith(`---\nname: ${name}\n`));
  assert.ok(body.includes("Never use emojis in commits: ever.\n"));
  assert.ok(body.includes("session abcdef12"));
  assert.ok(!body.split("\n")[2]!.slice("description: ".length).includes(":"));
});

test("memoryDir follows the project slug", () => {
  assert.ok(memoryDir("/home/u/my.proj").endsWith(path.join("projects", "-home-u-my-proj", "memory")));
});

function transcript(lines: unknown[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jev-")), "t.jsonl");

  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  return file;
}

test("lastTurn pairs the last real prompt with the last assistant text", () => {
  const file = transcript([
    { type: "user", uuid: "u0", message: { content: "older request" } },
    { type: "assistant", message: { content: [{ type: "text", text: "older reply" }] } },
    { type: "user", uuid: "u1", message: { content: "do the real thing please" } },
    { type: "assistant", message: { content: [{ type: "text", text: "starting now" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "all done, tests pass" }] } },
  ]);

  const turn = lastTurn(file);

  assert.equal(turn?.uuid, "u1");
  assert.equal(turn?.task, "do the real thing please");
  assert.equal(turn?.reply, "all done, tests pass");
});

test("lastTurn skips sidechain and command entries and returns null with no prompt", () => {
  assert.equal(lastTurn(undefined), null);
  assert.equal(lastTurn("/nonexistent/file"), null);

  const file = transcript([
    { type: "user", uuid: "c", message: { content: "<command-name>/x</command-name>" } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "side" }] } },
  ]);

  assert.equal(lastTurn(file), null);
});

test("decide exempts legitimate stops and bands the rest", () => {
  const ans = (p: number, reason: string): Answers => ({
    stopped_short: { noul: p },
    stop_reason: { choice: reason, confidence: 0.9 },
  });

  assert.equal(decide(ans(0.95, "partial")).band, "act");
  assert.equal(decide(ans(0.7, "partial")).band, "flag");
  assert.equal(decide(ans(0.3, "partial")).band, "none");
  assert.equal(decide(ans(0.99, "blocked")).band, "none");
  assert.equal(decide(ans(0.99, "needs_user")).band, "none");
  assert.equal(decide({}).band, "none");
});
