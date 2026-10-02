import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { jevAsk, type Answer, type Answers, type Question, type Questions } from "../adapters/afk/src/shared/jev-client.ts";
import { isJsonArray, isJsonObject, isString, type Json, type JsonValue } from "../adapters/afk/src/shared/json.ts";

const SERVER = { name: "claude-jev", version: "0.1.0" };

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TIMEOUT_MS = 20000;

const MAX_QUESTIONS = 16;

const TEXT = { type: "string" } as const;

const TRUE_FALSE = {
  type: "object",
  properties: { true: TEXT, false: TEXT },
  required: ["true", "false"],
} as const;

const QUESTION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "noul" }, instructions: TEXT, criteria: TRUE_FALSE },
      required: ["type", "instructions"],
    },
    {
      type: "object",
      properties: {
        type: { const: "choice" },
        instructions: TEXT,
        criteria: { type: "object", additionalProperties: TEXT },
      },
      required: ["type", "instructions", "criteria"],
    },
    {
      type: "object",
      properties: { type: { const: "score" }, instructions: TEXT, criteria: { type: "array", items: TEXT } },
      required: ["type", "instructions", "criteria"],
    },
  ],
} as const;

const TOOLS = [
  {
    name: "jev_check",
    description: "Calibrated yes/no probability for a situation. Use for gates, filters and guardrails.",
    inputSchema: {
      type: "object",
      properties: {
        state: { ...TEXT, description: "The situation to judge, in plain text" },
        question: { ...TEXT, description: "A yes/no question about the state" },
        true_means: { ...TEXT, description: "What a yes means (optional)" },
        false_means: { ...TEXT, description: "What a no means (optional)" },
      },
      required: ["state", "question"],
    },
  },
  {
    name: "jev_classify",
    description: "Pick one labelled option for a situation, with confidence and per-option probabilities.",
    inputSchema: {
      type: "object",
      properties: {
        state: TEXT,
        question: TEXT,
        options: {
          type: "object",
          description: "Map of option label to what that option means",
          additionalProperties: TEXT,
        },
      },
      required: ["state", "question", "options"],
    },
  },
  {
    name: "jev_score",
    description: "Rate a situation on an ordered scale you define. Returns a score from 0 to 1.",
    inputSchema: {
      type: "object",
      properties: {
        state: TEXT,
        question: TEXT,
        scale: {
          type: "array",
          description: "Ordered descriptions of the scale, lowest first",
          items: TEXT,
        },
      },
      required: ["state", "question", "scale"],
    },
  },
  {
    name: "jev_decide",
    description: "Several typed questions about one situation in one round trip.",
    inputSchema: {
      type: "object",
      properties: {
        state: TEXT,
        questions: {
          type: "object",
          description: "Map of name to a noul, choice or score question",
          additionalProperties: QUESTION_SCHEMA,
        },
      },
      required: ["state", "questions"],
    },
  },
] as const;

type ChoiceCriteria = Extract<Question, { type: "choice" }>["criteria"];

class ToolInputError extends Error {}

function requireString(args: Json, key: string): string {
  const value = args[key];

  if (!isString(value) || value.trim() === "") throw new ToolInputError(`${key} must be a non-empty string`);

  return value;
}

function trueFalse(value: JsonValue | undefined, label: string): { true: string; false: string } | undefined {
  if (value === undefined) return undefined;

  if (!isJsonObject(value) || !isString(value["true"]) || !isString(value["false"])) {
    throw new ToolInputError(`${label} must have string true and false entries`);
  }

  return { true: value["true"], false: value["false"] };
}

function stringList(value: JsonValue | undefined, label: string): string[] {
  const items = isJsonArray(value) ? value.filter(isString) : [];

  if (!isJsonArray(value) || items.length !== value.length || items.length < 2) {
    throw new ToolInputError(`${label} must be an array of at least two strings`);
  }

  return items;
}

function stringMap(args: Json, key: string): ChoiceCriteria {
  const value = args[key];

  if (!isJsonObject(value) || Object.keys(value).length < 2) {
    throw new ToolInputError(`${key} must be an object with at least two entries`);
  }

  const out: ChoiceCriteria = Object.create(null);

  for (const [label, meaning] of Object.entries(value)) {
    if (!isString(meaning)) throw new ToolInputError(`${key}.${label} must be a string`);
    out[label] = meaning;
  }

  return out;
}

function parseQuestion(name: string, raw: JsonValue | undefined): Question {
  if (!isJsonObject(raw) || !isString(raw["instructions"]) || raw["instructions"].trim() === "") {
    throw new ToolInputError(`questions.${name} needs instructions`);
  }

  const instructions = raw["instructions"];

  if (raw["type"] === "noul") {
    const criteria = trueFalse(raw["criteria"], `questions.${name}.criteria`);

    return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
  }

  if (raw["type"] === "choice") return { type: "choice", instructions, criteria: stringMap(raw, "criteria") };

  if (raw["type"] === "score") {
    return { type: "score", instructions, criteria: stringList(raw["criteria"], `questions.${name}.criteria`) };
  }

  throw new ToolInputError(`questions.${name}.type must be noul, choice or score`);
}

export function buildQuestions(tool: string, args: Json): Questions {
  if (tool === "jev_check") {
    const question: Question = { type: "noul", instructions: requireString(args, "question") };
    const yes = args["true_means"];
    const no = args["false_means"];

    if ((yes === undefined) !== (no === undefined)) {
      throw new ToolInputError("true_means and false_means must be given together");
    }

    const criteria = trueFalse(yes === undefined ? undefined : { true: yes, false: no ?? null }, "true_means and false_means");

    if (criteria) question.criteria = criteria;

    return { answer: question };
  }

  if (tool === "jev_classify") {
    return {
      answer: { type: "choice", instructions: requireString(args, "question"), criteria: stringMap(args, "options") },
    };
  }

  if (tool === "jev_score") {
    return {
      answer: { type: "score", instructions: requireString(args, "question"), criteria: stringList(args["scale"], "scale") },
    };
  }

  if (tool === "jev_decide") {
    const raw = args["questions"];

    if (!isJsonObject(raw) || Object.keys(raw).length === 0 || Object.keys(raw).length > MAX_QUESTIONS) {
      throw new ToolInputError(`questions must hold between 1 and ${MAX_QUESTIONS} entries`);
    }

    const out: Questions = Object.create(null);

    for (const [name, value] of Object.entries(raw)) out[name] = parseQuestion(name, value);

    return out;
  }

  throw new ToolInputError(`unknown tool: ${tool}`);
}

export type ToolPayload = Answers | Answer | { probability: number };

export function toPayload(tool: string, answers: Answers): ToolPayload {
  if (tool === "jev_decide") return answers;

  const only = answers["answer"];

  if (!only) throw new Error("Jev returned no answer");

  if ("noul" in only) return { probability: only.noul };

  return only;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

type Reply = { jsonrpc: "2.0"; id: JsonValue; result?: object; error?: { code: number; message: string } };

function fail(id: JsonValue, code: number, message: string): Reply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(text: string, isError: boolean): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(params: Json): Promise<ToolResult> {
  const name = isString(params["name"]) ? params["name"] : "";
  const args = isJsonObject(params["arguments"]) ? params["arguments"] : {};

  try {
    const questions = buildQuestions(name, args);
    const answers = await jevAsk(requireString(args, "state"), questions, TIMEOUT_MS);

    return toolResult(JSON.stringify(toPayload(name, answers)), false);
  } catch (e) {
    return toolResult(e instanceof Error ? e.message : String(e), true);
  }
}

export async function handleMessage(message: Json): Promise<Reply | null> {
  const hasId = "id" in message;
  const id = message["id"] ?? null;

  if (!hasId) return null;

  if (id === null) return fail(null, -32600, "request id must not be null");

  if (!isString(message["method"])) return fail(id, -32600, "method must be a string");

  const method = message["method"];
  const params = isJsonObject(message["params"]) ? message["params"] : {};

  if (method === "initialize") {
    const asked = params["protocolVersion"];
    const protocolVersion = isString(asked) && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];

    return {
      jsonrpc: "2.0",
      id,
      result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER },
    };
  }

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

  if (method === "tools/call") return { jsonrpc: "2.0", id, result: await callTool(params) };

  return fail(id, -32601, `method not found: ${method}`);
}

async function serve(): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();

  lines.on("line", (line) => {
    if (!line.trim()) return;

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify(fail(null, -32700, "parse error")) + "\n");

      return;
    }

    if (!isJsonObject(parsed)) {
      process.stdout.write(JSON.stringify(fail(null, -32600, "invalid request")) + "\n");

      return;
    }

    const job = handleMessage(parsed)
      .then((reply) => {
        if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
      })
      .catch((e) => {
        const id = parsed["id"] ?? null;

        process.stdout.write(JSON.stringify(fail(id, -32603, e instanceof Error ? e.message : String(e))) + "\n");
      })
      .finally(() => pending.delete(job));

    pending.add(job);
  });

  await new Promise<void>((resolve) => lines.on("close", resolve));
  await Promise.all(pending);
}

function isEntry(): boolean {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] ?? "")) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  await serve();
}
