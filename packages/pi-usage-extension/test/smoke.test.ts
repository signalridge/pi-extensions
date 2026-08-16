import { test } from "bun:test";
import assert from "node:assert/strict";
import usage from "../index.js";

test("registers the /usage command", () => {
  const commands: string[] = [];
  usage({ registerCommand: (name: string) => commands.push(name) } as never);
  assert.deepEqual(commands, ["usage"]);
});
