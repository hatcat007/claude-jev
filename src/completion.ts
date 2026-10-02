#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { writeOutput, type StopOutput } from "../adapters/afk/src/shared/stdout.ts";
import { jevAsk, asNoul, asChoice, type Answers } from "../adapters/afk/src/shared/jev-client.ts";
import { completionBundle } from "../adapters/afk/src/shared/questions.ts";
import {
  isJsonObject,
  isString,
  isNumber,
  parseJsonObject,
  textOf,
  type Json,
} from "../adapters/afk/src/shared/json.ts";
import { appendLogLine, configDir, enabled, ROUTER_LOG } from "../adapters/afk/src/shared/config.ts";

export const ACT_BAND = 0.85;

export const FLAG_BAND = 0.6;

const MAX_BLOCKS = 2;

const MAX_TRANSCRIPT_BYTES = 64_000_000;

const TASK_HEAD_CHARS = 900;

const TASK_TAIL_CHARS = 600;

const MAX_REPLY_CHARS = 2400;

const MIN_REPLY_CHARS = 20;

const BUDGET_MS = 8000;

const EXEMPT_REASONS = new Set(["blocked", "needs_user", "chat"]);

const STATE_DIR = path.join(configDir(), "jev-completion");

interface HookEvent {
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  cwd?: string;
}

interface Turn {
  uuid: string;
  task: string;
  reply: string;
}

function statePath(sessionId: string): string {
  return path.join(STATE_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

function readBlocks(sessionId: string): number {
  try {
    const data = parseJsonObject(fs.readFileSync(statePath(sessionId), "utf8"));
    const n = data?.["blocks"];

    return isNumber(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeBlocks(sessionId: string, blocks: number): boolean {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(sessionId), JSON.stringify({ blocks }));

    return true;
  } catch {
    return false;
  }
}

function realPrompt(data: Json): string {
  if (data["type"] !== "user" || data["isSidechain"] === true) return "";
  const message = isJsonObject(data["message"]) ? data["message"] : undefined;
  const text = textOf(message).trim();

  return text.startsWith("<") ? "" : text;
}

export function clipTask(task: string): string {
  if (task.length <= TASK_HEAD_CHARS + TASK_TAIL_CHARS) return task;

  return `${task.slice(0, TASK_HEAD_CHARS)}\n[... middle of the request omitted ...]\n${task.slice(-TASK_TAIL_CHARS)}`;
}

export function lastTurn(transcriptPath: string | undefined): Turn | null {
  if (!transcriptPath) return null;
  let lines: string[];

  try {
    if (fs.statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) return null;
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return null;
  }

  let reply = "";

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;

    if (line.length > 500_000) continue;
    const data = parseJsonObject(line);

    if (data === null) continue;
    const task = realPrompt(data);

    if (task) {
      return { uuid: isString(data["uuid"]) ? data["uuid"] : "", task: clipTask(task), reply };
    }

    if (!reply && data["type"] === "assistant" && data["isSidechain"] !== true) {
      const message = isJsonObject(data["message"]) ? data["message"] : undefined;

      reply = textOf(message).trim();
    }
  }

  return null;
}

interface CompletionRow {
  turn?: string;
  p?: number;
  reason?: string;
  band?: Band;
  blocked?: boolean;
  capped?: boolean;
  ms?: number;
  error?: string;
}

function log(event: HookEvent, row: CompletionRow): void {
  try {
    appendLogLine(
      ROUTER_LOG,
      JSON.stringify({ ts: new Date().toISOString(), kind: "completion", session_id: event.session_id, cwd: event.cwd, ...row })
    );
  } catch {
  }
}

type Band = "act" | "flag" | "none";

interface Decision {
  p: number;
  reason: string;
  band: Band;
}

export function decide(answers: Answers): Decision {
  const raw = asNoul(answers["stopped_short"])?.noul;
  const p = isNumber(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  const reason = asChoice(answers["stop_reason"])?.choice ?? "";
  const exempt = EXEMPT_REASONS.has(reason);
  const band: Band = exempt ? "none" : p >= ACT_BAND ? "act" : p >= FLAG_BAND ? "flag" : "none";

  return { p, reason, band };
}

async function main(): Promise<void> {
  let event: HookEvent = {};

  try {
    if (!enabled("completionCheck")) return;
    event = await readStdinJson<HookEvent>();

    if (event.stop_hook_active === true) return;
    const sid = event.session_id ?? "unknown";
    const turn = lastTurn(event.transcript_path);

    if (!turn) return;
    const reply = (isString(event.last_assistant_message) && event.last_assistant_message.trim()) || turn.reply;

    if (reply.length < MIN_REPLY_CHARS) return;

    const state = `The user's request: ${turn.task}\n\nThe assistant's final reply this turn (end of reply):\n${reply.slice(-MAX_REPLY_CHARS)}`;
    const t0 = performance.now();
    const answers = await jevAsk(state, completionBundle(), BUDGET_MS);
    const ms = Math.round(performance.now() - t0);
    const { p, reason, band } = decide(answers);
    const used = readBlocks(sid);
    const wantsBlock = band === "act";
    const capped = wantsBlock && used >= MAX_BLOCKS;
    const blocking = wantsBlock && !capped && writeBlocks(sid, used + 1);

    log(event, { turn: turn.uuid, p, reason, band, blocked: blocking, capped, ms });

    const out: StopOutput = {};

    if (blocking) {
      out.decision = "block";
      out.reason =
        "Your last reply ended before the request was finished. " +
        "Continue the work the user asked for, or state the concrete blocker that stops you.";
    } else if (band !== "none") {
      out.systemMessage = `[jev completion] reply may have stopped short (p=${p.toFixed(2)}, ${reason || "unclassified"})`;
    }

    if (Object.keys(out).length > 0) writeOutput(out);
  } catch (e) {
    log(event, { error: String(e).slice(0, 300) });
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "completion.ts") {
  try {
    await main();
  } catch {
  }
}
