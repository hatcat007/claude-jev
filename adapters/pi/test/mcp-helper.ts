import { spawn } from "node:child_process";
import path from "node:path";
import { isJsonArray, isJsonObject, isNumber, isString, type JsonValue } from "../../afk/src/shared/json.ts";

export const SERVER = path.resolve(import.meta.dirname, "../../../src/mcp-server.ts");

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
