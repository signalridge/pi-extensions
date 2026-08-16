import { test } from "bun:test";
import assert from "node:assert/strict";
import codeActions from "../index.js";

test("registers the /code command", () => {
  const commands: string[] = [];
  codeActions({ registerCommand: (name: string) => commands.push(name) } as never);
  assert.deepEqual(commands, ["code"]);
});
