import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { jevAsk, asNoul, asChoice, type Answers, type Questions } from "../../adapters/afk/src/shared/jev-client.ts";
import { configDir } from "../../adapters/afk/src/shared/config.ts";
import { isNumber } from "../../adapters/afk/src/shared/json.ts";
import type { Block } from "./types.ts";

export const MEMORY_THRESHOLD = 0.8;

export const MAX_CANDIDATES = 40;

export const MAX_SAVED = 5;

const CHUNK = 10;

const MIN_CHARS = 25;

const MAX_CHARS = 1200;

export const TIMEOUT_MS = 2500;

const TYPES = ["user", "feedback", "project", "reference"] as const;

type MemoryType = (typeof TYPES)[number];

export interface Candidate {
  i: number;
  text: string;
}

export interface Saved {
  file: string;
  type: MemoryType;
  p: number;
}

export interface MemoryResult {
  asked: number;
  saved: Saved[];
}

export function memoryDir(cwd: string): string {
  return path.join(configDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
}

export function candidates(blocks: Block[]): Candidate[] {
  const out: Candidate[] = [];

  blocks.forEach((b, i) => {
    const text = b.text.trim();

    if (b.role !== "user" || text.length < MIN_CHARS || text.length > MAX_CHARS) return;

    if (text.startsWith("<") || text.startsWith("/")) return;
    out.push({ i, text });
  });

  return out.slice(-MAX_CANDIDATES);
}

export function memoryQuestions(chunk: Candidate[]): Questions {
  const questions: Questions = {};

  chunk.forEach((c, k) => {
    questions[`memory_${k}`] = {
      type: "noul",
      instructions:
        `Does user message [${k}] state something that will still matter in a future session of this project: ` +
        "a lasting preference about how the assistant should work, a correction of the assistant's behavior, " +
        "or a standing fact about the user, the project or where to find things? " +
        "Answer no for a one-off task instruction, a question, a status remark, or anything only true for this session.",
      criteria: {
        true: "A durable preference, correction or standing fact",
        false: "A one-off instruction, question or session-only remark",
      },
    };
    questions[`mtype_${k}`] = {
      type: "choice",
      instructions: `What kind of lasting note is user message [${k}]?`,
      criteria: {
        user: "A fact about the user: their role, skills or working style",
        feedback: "Guidance on how the assistant should or should not work, or a correction of it",
        project: "A fact about ongoing work, goals or constraints of this project",
        reference: "A pointer to an external resource such as a URL, dashboard or ticket",
      },
    };
  });

  return questions;
}

export function memoryState(chunk: Candidate[]): string {
  const body = chunk.map((c, k) => `[${k}] ${c.text}`).join("\n\n");

  return `User messages from an AI coding-assistant session being compacted, numbered from [0].\n\n${body}`;
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const NOTE_BODY = /^---\n[\s\S]*?\n---\n\n([\s\S]*?)\n\n\*\*Source:\*\*/;

function existingNotes(dir: string): Set<string> {
  const known = new Set<string>();

  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "MEMORY.md") continue;
      const raw = fs.readFileSync(path.join(dir, f), "utf8");

      known.add(normalize(NOTE_BODY.exec(raw)?.[1] ?? raw));
    }
  } catch {
  }

  return known;
}

function slugOf(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .map((w) => w.slice(0, 24))
    .join("-");

  const hash = crypto.createHash("sha256").update(normalize(text)).digest("hex").slice(0, 6);

  return `${words || "note"}-${hash}`;
}

function oneLine(text: string, n: number): string {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length > n ? line.slice(0, n - 1) + "…" : line;
}

export function noteFile(text: string, type: MemoryType, sessionId: string | undefined, date: string): [string, string] {
  const name = slugOf(text);

  const body = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(oneLine(text, 120))}`,
    "metadata:",
    `  type: ${type}`,
    "---",
    "",
    text.trim(),
    "",
    `**Source:** the user's own words, saved verbatim by claude-jev at compaction on ${date}${sessionId ? ` (session ${sessionId.slice(0, 8)})` : ""}.`,
    "",
  ].join("\n");

  return [name, body];
}

export function appendIndex(dir: string, name: string, text: string): void {
  const index = path.join(dir, "MEMORY.md");
  const label = oneLine(text, 60).replace(/[\\[\]()]/g, (c) => `\\${c}`);
  const line = `- [${label}](${name}.md) — ${oneLine(text, 100)}\n`;
  let current = "";

  try {
    current = fs.readFileSync(index, "utf8");
  } catch {
  }

  const sep = current === "" || current.endsWith("\n") ? "" : "\n";

  fs.appendFileSync(index, sep + line);
}

interface MemoryVerdict {
  p: number;
  type: MemoryType;
}

export function verdict(answers: Answers, k: number): MemoryVerdict {
  const raw = asNoul(answers[`memory_${k}`])?.noul;
  const p = isNumber(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  const choice = asChoice(answers[`mtype_${k}`])?.choice ?? "";
  const type = TYPES.find((t) => t === choice) ?? "feedback";

  return { p, type };
}

export interface Pick {
  c: Candidate;
  p: number;
  type: MemoryType;
}

export function saveNotes(
  picks: Pick[],
  cwd: string,
  redact: (text: string) => string,
  sessionId: string | undefined
): Saved[] {
  const dir = memoryDir(cwd);
  const known = existingNotes(dir);
  const date = new Date().toISOString().slice(0, 10);
  const saved: Saved[] = [];

  for (const pick of [...picks].sort((a, b) => b.p - a.p)) {
    if (saved.length >= MAX_SAVED) break;
    const text = redact(pick.c.text);

    if (text !== pick.c.text) continue;

    if (known.has(normalize(text))) continue;
    const [name, body] = noteFile(text, pick.type, sessionId, date);

    fs.mkdirSync(dir, { recursive: true });

    try {
      fs.writeFileSync(path.join(dir, `${name}.md`), body, { flag: "wx" });
    } catch {
      continue;
    }

    appendIndex(dir, name, text);
    known.add(normalize(text));
    saved.push({ file: `${name}.md`, type: pick.type, p: pick.p });
  }

  return saved;
}

export async function curateMemory(
  blocks: Block[],
  cwd: string,
  redact: (text: string) => string,
  sessionId: string | undefined
): Promise<MemoryResult> {
  const cands = candidates(blocks);

  if (cands.length === 0) return { asked: 0, saved: [] };

  const chunks: Candidate[][] = [];

  for (let i = 0; i < cands.length; i += CHUNK) chunks.push(cands.slice(i, i + CHUNK));

  const answered = await Promise.all(
    chunks.map((chunk) => jevAsk(memoryState(chunk), memoryQuestions(chunk), TIMEOUT_MS).catch(() => null))
  );

  const picks: Pick[] = [];

  chunks.forEach((chunk, n) => {
    const answers = answered[n];

    if (!answers) return;

    chunk.forEach((c, k) => {
      const { p, type } = verdict(answers, k);

      if (p >= MEMORY_THRESHOLD) picks.push({ c, p, type });
    });
  });

  return { asked: cands.length, saved: saveNotes(picks, cwd, redact, sessionId) };
}
