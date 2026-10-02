import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Answers } from "../../afk/src/shared/jev-client.ts";
import {
  appendIndex,
  candidates,
  curateMemory,
  saveNotes,
  normalize,
  memoryDir,
  memoryQuestions,
  noteFile,
  verdict,
  MAX_CANDIDATES,
} from "../../../src/compact/memory.ts";
import { clipTask, decide, lastTurn } from "../../../src/completion.ts";

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
  assert.equal(body.split("\n")[2], 'description: "Never use emojis in commits: ever."');
});

test("memoryDir follows the project slug", () => {
  assert.ok(memoryDir("/home/u/my.proj").endsWith(path.join("projects", "-home-u-my-proj", "memory")));
});

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  tempDirs.push(dir);

  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: unknown[]): string {
  const file = path.join(tempDir("jev-"), "t.jsonl");

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

test("noteFile quotes a description that starts with a bracket", () => {
  const [, body] = noteFile("[priority] always run the linter first", "feedback", undefined, "2026-10-02");

  assert.equal(body.split("\n")[2], 'description: "[priority] always run the linter first"');
});

test("appendIndex escapes the label so text cannot rewrite the link", () => {
  const dir = tempDir("jev-mem-");

  appendIndex(dir, "note-abc123", "see [docs](http://evil.example) for the rule");
  const line = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");

  assert.ok(line.startsWith("- [see \\[docs\\]\\(http://evil.example\\) for the rule]"));
  assert.ok(line.includes("](note-abc123.md)"));
});

test("normalize makes case and spacing differences equal", () => {
  assert.equal(normalize("Always  RUN\nthe linter"), normalize("always run the linter"));
});

test("clipTask keeps the head and tail of a long request", () => {
  const long = "A".repeat(900) + "M".repeat(2000) + "Z".repeat(600);
  const out = clipTask(long);

  assert.ok(out.startsWith("A".repeat(900)));
  assert.ok(out.endsWith("Z".repeat(600)));
  assert.ok(out.includes("omitted"));
  assert.equal(clipTask("short request"), "short request");
});

test("lastTurn keeps a request that starts with a heading or a path", () => {
  const file = transcript([
    { type: "user", uuid: "old", message: { content: "an older request about something" } },
    { type: "user", uuid: "h1", message: { content: "# Refactor the API into modules" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Refactored the API into three modules." }] } },
  ]);

  assert.equal(lastTurn(file)?.uuid, "h1");
});

test("noteFile bounds the filename for a single very long word", () => {
  const [name] = noteFile("x".repeat(1200), "feedback", undefined, "2026-10-02");

  assert.ok(name.length <= 60);
});

test("lastTurn finds the request however many lines the turn spans", () => {
  const filler = Array.from({ length: 1500 }, () => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash" }] },
  }));

  const file = transcript([
    { type: "user", uuid: "old", message: { content: "an older request about something else" } },
    { type: "assistant", message: { content: [{ type: "text", text: "older reply" }] } },
    { type: "user", uuid: "cur", message: { content: "the current long running request" } },
    ...filler,
    { type: "assistant", message: { content: [{ type: "text", text: "finished the current request" }] } },
  ]);

  assert.equal(lastTurn(file)?.uuid, "cur");
});

test("decide does not exempt a permission request", () => {
  const answers: Answers = {
    stopped_short: { noul: 0.95 },
    stop_reason: { choice: "asked_permission", confidence: 0.9 },
  };

  assert.equal(decide(answers).band, "act");
});

async function withConfigDir<T>(run: (cwd: string) => T | Promise<T>): Promise<T> {
  const previous = process.env["CLAUDE_CONFIG_DIR"];

  process.env["CLAUDE_CONFIG_DIR"] = tempDir("jev-cfg-");

  try {
    return await run("/tmp/proj-under-test");
  } finally {
    if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previous;
  }
}

const identity = (text: string) => text;

const pick = (text: string, p = 0.95) => ({ c: { i: 0, text }, p, type: "feedback" as const });

const LINT = "Always run the linter before you commit anything in this repo.";

test("saveNotes saves a note once and skips it on the next compaction", async () => {
  await withConfigDir((cwd) => {
    const first = saveNotes([pick(LINT)], cwd, identity, "sess1234");
    const second = saveNotes([pick(LINT)], cwd, identity, "sess1234");

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(fs.readdirSync(memoryDir(cwd)).filter((f) => f !== "MEMORY.md").length, 1);
  });
});

test("saveNotes dedupes picks that differ only in case and spacing", async () => {
  await withConfigDir((cwd) => {
    const saved = saveNotes([pick(LINT), pick(LINT.toUpperCase().replace(" ", "  "), 0.9)], cwd, identity, undefined);

    assert.equal(saved.length, 1);
  });
});

test("saveNotes does not overwrite a file that already holds the name", async () => {
  await withConfigDir((cwd) => {
    const [name] = noteFile(LINT, "feedback", undefined, "2026-10-02");
    const file = path.join(memoryDir(cwd), `${name}.md`);

    fs.mkdirSync(memoryDir(cwd), { recursive: true });
    fs.writeFileSync(file, "someone else's note");

    assert.equal(saveNotes([pick(LINT)], cwd, identity, undefined).length, 0);
    assert.equal(fs.readFileSync(file, "utf8"), "someone else's note");
    assert.ok(!fs.existsSync(path.join(memoryDir(cwd), "MEMORY.md")));
  });
});

test("saveNotes saves a short note that is only a substring of an older one", async () => {
  await withConfigDir((cwd) => {
    const longer = `${LINT} Also run the type checker.`;
    const [name, body] = noteFile(longer, "feedback", undefined, "2026-10-02");

    fs.mkdirSync(memoryDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(memoryDir(cwd), `${name}.md`), body);

    assert.equal(saveNotes([pick("run the linter before you commit anything in this repo")], cwd, identity, undefined).length, 1);
  });
});

test("saveNotes skips a message the redactor would change", async () => {
  await withConfigDir((cwd) => {
    const secret = "Deploy with the token ghp_abcdefghijklmnopqrstuvwxyz0123 for every future session.";

    assert.equal(saveNotes([pick(secret)], cwd, (t) => t.replace(/ghp_\w+/g, "gh_[REDACTED]"), undefined).length, 0);
  });
});

test("saveNotes keeps at most five notes, highest confidence first", async () => {
  await withConfigDir((cwd) => {
    const many = Array.from({ length: 8 }, (_, n) => pick(`Standing rule number ${n} for every session of this project.`, 0.8 + n / 100));
    const saved = saveNotes(many, cwd, identity, undefined);

    assert.equal(saved.length, 5);
    assert.deepEqual(saved.map((x) => x.p), saved.map((x) => x.p).sort((a, b) => b - a));
    assert.equal(Math.max(...saved.map((x) => x.p)), saved[0]!.p);
  });
});

test("curateMemory sends nothing to Jev for a message the redactor would change", async () => {
  await withConfigDir(async (cwd) => {
    const secret = "Deploy with the token ghp_abcdefghijklmnopqrstuvwxyz0123 for every future session.";
    const result = await curateMemory([user(secret)], cwd, (t) => t.replace(/ghp_\w+/g, "gh_[REDACTED]"), undefined);

    assert.deepEqual(result, { asked: 0, saved: [] });
  });
});

test("saveNotes removes the note when the index cannot be appended", async () => {
  await withConfigDir((cwd) => {
    fs.mkdirSync(path.join(memoryDir(cwd), "MEMORY.md"), { recursive: true });

    assert.equal(saveNotes([pick(LINT)], cwd, identity, undefined).length, 0);
    assert.deepEqual(fs.readdirSync(memoryDir(cwd)), ["MEMORY.md"]);
  });
});

test("saveNotes leaves no temporary files behind", async () => {
  await withConfigDir((cwd) => {
    saveNotes([pick(LINT), pick("Never push directly to main in this project, open a pull request instead.")], cwd, identity, undefined);

    assert.deepEqual(fs.readdirSync(memoryDir(cwd)).filter((f) => f.endsWith(".tmp")), []);
  });
});
