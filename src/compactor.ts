#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson } from "../adapters/afk/src/shared/stdin.ts";
import { appendLogLine } from "../adapters/afk/src/shared/config.ts";
import { isJsonObject, isJsonArray, isString, type JsonValue } from "../adapters/afk/src/shared/json.ts";
import {
  blockText,
  judgeable,
  selectBlocks,
  DIRECTIVE_CHARS,
  MAX_BLOCKS,
  RESCUE_BLOCKS,
  type Block,
  type Kept,
  type Stats,
} from "./compact/strategy.ts";
import { curateMemory } from "./compact/memory.ts";

export const ROWS_HEADER =
  "This session's history was compacted by Jev. Every message below " +
  "was judged still needed and kept verbatim, or as a head with an " +
  "elision note; everything else was dropped. Continue the last task " +
  "without asking the user to repeat anything.";

const STATS_LOG = "jev-compact-log.jsonl";

const MEMORY_LOG = "jev-memory-log.jsonl";

export interface CompactRow {
  role?: JsonValue;
  text?: JsonValue;
  toolUses?: JsonValue;
  toolResults?: JsonValue;
  handle?: JsonValue;
}

interface ClaudeBlock extends Block {
  row?: CompactRow;
}

interface LoggedStats extends Stats {
  trigger?: string;
  rows_in?: number;
  rows_out?: number;
  passed_through?: number;
  memory_asked?: number;
  memory_saved?: number;
}

export function rowText(row: CompactRow): string | null {
  const content: JsonValue[] = [{ type: "text", text: row.text ?? "" }];

  for (const u of isJsonArray(row.toolUses) ? row.toolUses : []) {
    if (!isJsonObject(u)) continue;

    content.push({ type: "tool_use", name: u["tool"] ?? "?", input: u["input"] ?? {} });
  }

  for (const r of isJsonArray(row.toolResults) ? row.toolResults : []) {
    if (!isJsonObject(r)) continue;

    content.push({ type: "tool_result", content: r["text"] });
  }

  return judgeable(isString(row.role) ? row.role : "", blockText(content).trim());
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bxpl_[A-Za-z0-9]{16,}/g, "xpl_[REDACTED]"],
  [/\bsk-or-[A-Za-z0-9_-]{16,}/g, "sk-or-[REDACTED]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "sk-ant-[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{32,}/g, "sk-[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[REDACTED]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws-[REDACTED]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox-[REDACTED]"],
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, "AIza[REDACTED]"],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "stripe-[REDACTED]"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "npm_[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "jwt-[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[PRIVATE KEY REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [REDACTED]"],
];

export function redactSecrets(text: string): string {
  let out = text;

  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);

  return out;
}

function plainRow(row: CompactRow): boolean {
  return !row.toolUses && !row.toolResults;
}

function hasItems(value: JsonValue | undefined): boolean {
  return isJsonArray(value) ? value.length > 0 : Boolean(value);
}

function noToolActivity(row: CompactRow): boolean {
  return !hasItems(row.toolUses) && !hasItems(row.toolResults);
}

function textRow(role: string, text: string): CompactRow {
  return { role, text, toolUses: [], toolResults: [] };
}

function rowsOut(blocks: ClaudeBlock[], kept: Kept[]): CompactRow[] {
  const out: CompactRow[] = [textRow("user", ROWS_HEADER)];

  for (const k of kept) {
    const block = blocks[k.i]!;
    const row = block.row;

    const text = redactSecrets(k.text);

    if (row && plainRow(row) && k.text === block.text) {
      out.push(isString(row.text) ? { ...row, text: redactSecrets(row.text) } : row);
    } else out.push(textRow(block.role, text));
  }

  return out;
}

function fallback(reason: string): number {
  process.stdout.write(JSON.stringify({ fallback: reason }) + "\n");

  return 0;
}

function logStats(sessionId: string | undefined, stats: LoggedStats): void {
  try {
    const row = {
      ts: new Date().toISOString(),
      session_id: sessionId ?? null,
      source: "rows",
      ...stats,
      rows: stats.rows.map((r) => ({ ...r, ref: redactSecrets(r.ref) })),
    };

    appendLogLine(STATS_LOG, JSON.stringify(row));
  } catch {
  }
}

interface CompactEvent {
  trigger?: string;
  instructions?: string;
  cwd?: string;
  session_id?: string;
  messages?: JsonValue;
  memory?: boolean;
}

function incomingRows(messages: JsonValue | undefined): CompactRow[] {
  const out: CompactRow[] = [];

  for (const r of isJsonArray(messages) ? messages : []) {
    if (isJsonObject(r)) out.push(r);
  }

  return out;
}

function claudeBlocks(incoming: CompactRow[]): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = [];

  for (let i = incoming.length - 1; i >= 0; i--) {
    if (blocks.length === MAX_BLOCKS + RESCUE_BLOCKS) break;
    const r = incoming[i]!;
    const text = rowText(r);

    if (text !== null) blocks.push({ role: isString(r.role) ? r.role : "assistant", text, row: r });
  }

  return blocks.reverse();
}

export async function memoryOnly(): Promise<number> {
  try {
    const event = await readStdinJson<CompactEvent>();

    const blocks = claudeBlocks(incomingRows(event.messages)).filter(
      (b) => b.row !== undefined && noToolActivity(b.row)
    );

    if (event.cwd && blocks.length > 0) {
      const result = await curateMemory(blocks, event.cwd, redactSecrets, event.session_id);

      appendLogLine(
        MEMORY_LOG,
        JSON.stringify({
          ts: new Date().toISOString(),
          session_id: event.session_id ?? null,
          source: "memory",
          trigger: event.trigger,
          memory_asked: result.asked,
          memory_saved: result.saved.length,
        })
      );
    }
  } catch {
  }

  process.stdout.write("{}\n");

  return 0;
}

export async function rows(): Promise<number> {
  let event: CompactEvent;

  try {
    event = await readStdinJson<CompactEvent>();
  } catch (e) {
    return fallback(`unreadable event: ${String(e)}`);
  }

  const directive = (event.instructions ?? "").trim().slice(0, DIRECTIVE_CHARS) || null;

  const incoming = incomingRows(event.messages);
  const blocks = claudeBlocks(incoming);

  if (blocks.length === 0) return fallback("no judgeable rows");

  const memoryRun =
    event.memory === true && event.cwd
      ? curateMemory(blocks.filter((b) => b.row !== undefined && noToolActivity(b.row)), event.cwd, redactSecrets, event.session_id).catch(() => null)
      : Promise.resolve(null);

  let kept: Kept[];
  let stats: LoggedStats;

  try {
    [kept, stats] = await selectBlocks(blocks, event.cwd ?? null, directive);
  } catch (e) {
    return fallback(`jev: ${String(e)}`);
  }

  const memory = await memoryRun;

  if (memory) {
    stats.memory_asked = memory.asked;
    stats.memory_saved = memory.saved.length;
  }

  stats.trigger = event.trigger;
  stats.rows_in = incoming.length;
  const out = rowsOut(blocks, kept);
  stats.rows_out = out.length;
  stats.passed_through = out.filter((r) => r["handle"] !== undefined).length;
  logStats(event.session_id, stats);
  const what = event.trigger ? `${event.trigger} compaction` : "compaction";
  process.stdout.write(
    JSON.stringify({
      messages: out,
      summary: `${what} replaced by ${out.length} rows (kept ${stats.kept}, ${stats.truncated} truncated, ${Math.round(stats.reduction * 100)}% smaller, ${stats.ms} ms)`,
    }) + "\n"
  );

  return 0;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv[2] === "rows") {
    rows()
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stdout.write(JSON.stringify({ fallback: `compactor: ${String(e)}` }) + "\n");
        process.exit(0);
      });
  } else if (process.argv[2] === "memory") {
    memoryOnly().then((code) => process.exit(code));
  } else {
    process.stderr.write("usage: compactor.ts rows|memory  (reads a session.compact event on stdin)\n");
    process.exit(2);
  }
}
