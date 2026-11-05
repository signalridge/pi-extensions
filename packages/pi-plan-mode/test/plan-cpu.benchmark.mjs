// Synthetic only. Run from the prepared checkout, never against a live session:
// mise exec bun@1.3.14 -- bun packages/pi-plan-mode/test/plan-cpu.benchmark.mjs [baseline|current]
// Timings have NO stringify instrumentation; counts are a separate replay.
import { heapStats } from "bun:jsc";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CanonicalFingerprints } from "../src/canonical-fingerprint.ts";
import { createMockContext, createMockPi } from "./support.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageRoot, "../..");
const base = "b70497c3087e028112f549e6bc2452f357af4b4c";
const variant = process.argv[2] ?? "current";
assert.ok(["baseline", "current"].includes(variant));
const temporary = mkdtempSync(join(tmpdir(), "pi-plan-cpu-synthetic-"));
let source = join(packageRoot, "src/plan-mode.ts");
if (variant === "baseline") {
  // Reproduce the exact staged BASE implementation, with only module locations
  // rewritten. No hashing/guard branches are changed in the measured baseline.
  symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"));
  for (const name of ["input-ownership", "plan-mode"]) {
    let original = execFileSync("git", ["show", `${base}:packages/pi-plan-mode/src/${name}.ts`], {
      cwd: root,
      encoding: "utf8",
    });
    original = original.replace(/from "\.\/([^"]+)"/gu, (_all, path) => {
      const target =
        path === "input-ownership.js"
          ? join(temporary, "input-ownership.ts")
          : join(packageRoot, "src", path.replace(/\.js$/u, ".ts"));
      return `from ${JSON.stringify(target)}`;
    });
    writeFileSync(join(temporary, `${name}.ts`), original);
  }
  source = join(temporary, "plan-mode.ts");
}
// This import is variable only in this unshipped benchmark, to load exact BASE.
const planMode = (await import(pathToFileURL(source).href)).default;

function seeded(entries, megabyteStrings, exotic = false) {
  const manager = SessionManager.inMemory(temporary);
  const opaque = [];
  for (let index = 0; index < entries; index++) {
    const body = `${index}:${"synthetic-output-".repeat(96)}`;
    if (index % 3 === 0) {
      const data = { nested: { value: index, text: body, flags: [true, false] } };
      opaque.push(data);
      manager.appendCustomEntry("synthetic-opaque", data);
    } else {
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `synthetic-${index}`,
        toolName: "synthetic",
        content: [{ type: "text", text: body }],
        details: { lane: index },
        isError: false,
        timestamp: index + 1,
      });
    }
  }
  for (let index = 0; index < megabyteStrings; index++)
    manager.appendCustomEntry("synthetic-large-opaque", { text: `${index}:${"x".repeat(1024 * 1024)}` });
  if (exotic)
    for (const entry of manager.getBranch())
      Object.defineProperty(entry, "benchmarkAccessor", { enumerable: true, get: () => "synthetic" });
  return { manager, opaque };
}

async function fixture(entries = 3000, megabyteStrings = 4, exotic = false) {
  const seededBranch = seeded(entries, megabyteStrings, exotic);
  const mock = createMockPi({ activeTools: ["read", "bash", "edit", "write"] });
  const { ctx } = createMockContext({ cwd: temporary, mode: "json", sessionManager: seededBranch.manager });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" }) });
  const context = () => mock.events.get("context")[0]({ messages: [] }, ctx);
  const start = () => mock.events.get("session_start")[0]({ reason: "startup" }, ctx);
  return { ...seededBranch, context, start };
}

async function measure(name, operation, iterations = 1) {
  const heap = process.memoryUsage().heapUsed;
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) await operation(index);
  const wallMs = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  return {
    name,
    iterations,
    wallMs,
    cpuMs: (usage.user + usage.system) / 1000,
    heapDeltaBytes: process.memoryUsage().heapUsed - heap,
  };
}

async function timed() {
  const f = await fixture();
  const result = [];
  result.push(
    await measure("first-start-and-context", async () => {
      await f.start();
      await f.context();
    }),
  );
  result.push(await measure("repeat-context", f.context, 20));
  result.push(
    await measure(
      "append-and-context",
      async (index) => {
        f.manager.appendCustomEntry("synthetic-append", { index, text: "append".repeat(100) });
        await f.context();
      },
      5,
    ),
  );
  result.push(
    await measure("deep-mutation-and-context", async () => {
      f.opaque[0].nested.value = -1;
      await f.context();
    }),
  );
  const over = await fixture(6000, 4);
  await over.start();
  await over.context();
  result.push(await measure("over-entry-cap-repeat", over.context, 5));
  const byteCap = await fixture(3000, 24);
  await byteCap.start();
  await byteCap.context();
  result.push(await measure("over-byte-cap-repeat", byteCap.context, 3));
  const unsafe = await fixture(3000, 4, true);
  await unsafe.start();
  await unsafe.context();
  result.push(await measure("accessor-fallback-repeat", unsafe.context, 3));
  return result;
}

async function counted() {
  const original = JSON.stringify;
  const output = [];
  async function count(name, action, iterations = 1) {
    let hashes = 0;
    let bytes = 0;
    JSON.stringify = function (...args) {
      const serialized = Reflect.apply(original, this, args);
      hashes++;
      bytes += serialized === undefined ? 9 : Buffer.byteLength(serialized);
      return serialized;
    };
    try {
      for (let index = 0; index < iterations; index++) await action(index);
    } finally {
      JSON.stringify = original;
    }
    output.push({ name, iterations, canonicalHashes: hashes, jsonBytes: bytes });
  }
  const f = await fixture();
  await count("first-start-and-context", async () => {
    await f.start();
    await f.context();
  });
  await count("repeat-context", f.context, 20);
  await count(
    "append-and-context",
    async (index) => {
      f.manager.appendCustomEntry("synthetic-append", { index, text: "append".repeat(100) });
      await f.context();
    },
    5,
  );
  await count("deep-mutation-and-context", async () => {
    f.opaque[0].nested.value = -1;
    await f.context();
  });
  const over = await fixture(6000, 4);
  await over.start();
  await over.context();
  await count("over-entry-cap-repeat", over.context, 5);
  const byteCap = await fixture(3000, 24);
  await byteCap.start();
  await byteCap.context();
  await count("over-byte-cap-repeat", byteCap.context, 3);
  const unsafe = await fixture(3000, 4, true);
  await unsafe.start();
  await unsafe.context();
  await count("accessor-fallback-repeat", unsafe.context, 3);
  return output;
}

try {
  const time = await timed();
  const counts = await counted();
  const memory = seeded(6000, 24);
  // Force pre-existing synthetic ropes/strings before measuring memo metadata.
  JSON.stringify(memory.manager.getBranch());
  await new Promise(setImmediate);
  Bun.gc(true);
  const heapBeforeMemo = heapStats().heapSize;
  const memo = new CanonicalFingerprints();
  for (let pass = 0; pass < 3; pass++) for (const entry of memory.manager.getBranch()) memo.key(entry);
  await new Promise(setImmediate);
  Bun.gc(true);
  const retained = { ...memo.retention, observedHeapDeltaBytes: heapStats().heapSize - heapBeforeMemo };
  assert.ok(retained.entries <= 4096 && retained.bytes <= 32 * 1024 * 1024 && retained.nodes <= 131072);
  memo.clear();
  await new Promise(setImmediate);
  Bun.gc(true);
  const cleared = { ...memo.retention, observedHeapDeltaBytes: heapStats().heapSize - heapBeforeMemo };
  assert.equal(memory.manager.getBranch().length, 6024);
  console.log(
    JSON.stringify(
      {
        variant,
        base,
        runtime: {
          bun: Bun.version,
          nodeCompatibility: process.versions.node,
          sdk: JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"))
            .version,
        },
        workload: {
          entries: 3004,
          megabyteStrings: 4,
          historyJSONBytes: Buffer.byteLength(JSON.stringify(seeded(3000, 4).manager.getBranch())),
          context:
            "actual registered Plan context hook, Plan off, no provider requests; startup includes first fingerprint reads",
          iterations: "one timed pass and independent instrumented count replay; not idle or live CPU percentages",
        },
        measurements: time.map((row) => ({ ...row, ...counts.find((count) => count.name === row.name) })),
        boundedMemo: { retained, cleared },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
