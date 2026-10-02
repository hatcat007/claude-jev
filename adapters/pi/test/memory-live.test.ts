import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { hasKey } from "../../afk/src/shared/jev-client.ts";
import { curateMemory, memoryDir } from "../../../src/compact/memory.ts";

const LINT = "Always run the linter before you commit anything in this repo.";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("curateMemory with the live Jev client keeps a lasting preference and drops a one-off task", { skip: process.env["JEV_LIVE_TESTS"] !== "1" || !hasKey() }, async () => {
  const previous = process.env["CLAUDE_CONFIG_DIR"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-live-"));

  tempDirs.push(dir);
  process.env["CLAUDE_CONFIG_DIR"] = dir;

  try {
    const cwd = "/tmp/proj-under-test";

    const result = await curateMemory(
      [
        { role: "user", text: LINT },
        { role: "user", text: "Please rename the function fooBar to bazQux in src/util.ts and rerun the tests." },
      ],
      cwd,
      (text) => text,
      "live1234"
    );

    assert.equal(result.asked, 2);
    assert.equal(result.saved.length, 1);
    assert.ok(fs.readFileSync(path.join(memoryDir(cwd), result.saved[0]!.file), "utf8").includes(LINT));
  } finally {
    if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previous;
  }
});
