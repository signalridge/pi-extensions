/**
 * session-boundary.test.mjs — who owns a Ralph loop, and what that ownership
 * permits.
 *
 * Loop state lives in the repository (`.ralph/*.state.json`), but a loop is
 * driven by one pi session. Those two facts are the whole hazard: repo-local
 * state is visible to every session in the directory, so without an owner
 * recorded in the file, an unrelated session opened in the same repo would
 * silently start injecting another session's loop prompt into its own turns.
 *
 * The ownership rules are therefore asserted as behaviour rather than as state:
 * what a session injects, what its tools will do, and what its `/ralph-stop`
 * is allowed to touch.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import ralphExtension from "../index.ts";

function makeCtx(cwd, sessionId = "fresh-session") {
  const statuses = [];
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    hasUI: true,
    /** Every status line this session has drawn, newest last. */
    statuses,
    ui: {
      notify() {},
      setStatus(_key, value) {
        statuses.push(value);
      },
      setWidget() {},
      confirm: async () => false,
      theme: {
        fg(_name, text) {
          return text;
        },
        bold(text) {
          return text;
        },
      },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function makePi() {
  const events = new Map();
  return {
    events,
    sentUserMessages: [],
    commands: new Map(),
    tools: new Map(),
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, command) {
      this.commands.set(name, command);
    },
    registerTool(tool) {
      this.tools.set(tool.name, tool);
    },
    sendUserMessage(message, options) {
      this.sentUserMessages.push({ message, options });
    },
  };
}

const tempDirs = [];

function makeTempDir(name) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tempDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, ".ralph"), { recursive: true });
  return cwd;
}

function writeLoop(cwd, state) {
  fs.writeFileSync(path.join(cwd, ".ralph", `${state.name}.md`), `# ${state.name}\n`, "utf8");
  fs.writeFileSync(path.join(cwd, ".ralph", `${state.name}.state.json`), JSON.stringify(state, null, 2), "utf8");
}

function readLoop(cwd, name) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".ralph", `${name}.state.json`), "utf8"));
}

/** Boot the extension against `cwd` as `sessionId` and run `session_start`. */
async function boot(cwd, sessionId) {
  const pi = makePi();
  ralphExtension(pi);
  const ctx = makeCtx(cwd, sessionId);
  await pi.events.get("session_start")({}, ctx);
  return { pi, ctx };
}

/** What this session would inject into the next turn's system prompt. */
const inject = (pi, ctx) => pi.events.get("before_agent_start")({ systemPrompt: "base prompt" }, ctx);

const baseState = {
  iteration: 1,
  maxIterations: 50,
  itemsPerIteration: 1,
  reflectEvery: 0,
  reflectInstructions: "reflect",
  active: true,
  status: "active",
  startedAt: "2026-07-08T11:54:18.989Z",
  lastReflectionAt: 0,
};

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("loop ownership across sessions", () => {
  // State written before ownership was recorded has no owner at all. Binding it
  // to whichever session happens to open the repo next would hijack that
  // session's prompts for a loop nobody asked it to run.
  test("a fresh session does not adopt unowned repo-local state", async () => {
    const cwd = makeTempDir("ralph-session-boundary-");
    writeLoop(cwd, {
      ...baseState,
      name: "old-loop",
      taskFile: ".ralph/old-loop.md",
      iteration: 12,
      maxIterations: 1000,
      itemsPerIteration: 3,
      reflectEvery: 10,
    });

    const { pi, ctx } = await boot(cwd, "fresh-session");
    assert.equal(await inject(pi, ctx), undefined);
  });

  test("the owning session rehydrates its loop after a reload or compaction", async () => {
    const cwd = makeTempDir("ralph-session-owned-");
    writeLoop(cwd, {
      ...baseState,
      name: "owned-loop",
      taskFile: ".ralph/owned-loop.md",
      iteration: 4,
      ownerSessionId: "same-session",
    });

    const { pi, ctx } = await boot(cwd, "same-session");
    assert.match((await inject(pi, ctx))?.systemPrompt ?? "", /RALPH LOOP - owned-loop - Iteration 4\/50/);
  });

  test("an unrelated session in the same repo injects nothing", async () => {
    const cwd = makeTempDir("ralph-session-other-");
    writeLoop(cwd, {
      ...baseState,
      name: "owned-loop",
      taskFile: ".ralph/owned-loop.md",
      ownerSessionId: "someone-else",
    });

    const { pi, ctx } = await boot(cwd, "not-the-owner");
    assert.equal(await inject(pi, ctx), undefined);
  });

  test("`/ralph resume` transfers ownership and advances the iteration", async () => {
    const cwd = makeTempDir("ralph-session-claim-");
    writeLoop(cwd, {
      ...baseState,
      name: "owned-loop",
      taskFile: ".ralph/owned-loop.md",
      iteration: 4,
      ownerSessionId: "original",
    });

    const { pi, ctx } = await boot(cwd, "claimant-session");
    await pi.commands.get("ralph").handler("resume owned-loop", ctx);

    assert.equal(readLoop(cwd, "owned-loop").ownerSessionId, "claimant-session");
    assert.equal(readLoop(cwd, "owned-loop").iteration, 5);
  });

  test("`ralph_start` records the starting session as the owner", async () => {
    const cwd = makeTempDir("ralph-session-start-");
    const { pi, ctx } = await boot(cwd, "starter-session");
    await pi.tools
      .get("ralph_start")
      .execute("call", { name: "started-loop", taskContent: "# Task\n", maxIterations: 3 }, undefined, undefined, ctx);

    assert.equal(readLoop(cwd, "started-loop").ownerSessionId, "starter-session");
  });
});

// Ownership transfer is the sharp edge: the previous owner is still running,
// still has the tools registered, and must go quiet the moment it loses the
// loop — including not being able to end or roll back the new owner's work.
describe("after ownership transfers away", () => {
  /** Set up an owner, then have a second session claim its loop. */
  async function transferred() {
    const cwd = makeTempDir("ralph-session-transfer-");
    writeLoop(cwd, {
      ...baseState,
      name: "owned-loop",
      taskFile: ".ralph/owned-loop.md",
      iteration: 4,
      ownerSessionId: "same-session",
    });

    const owner = await boot(cwd, "same-session");
    await inject(owner.pi, owner.ctx); // the owner binds its loop
    const claimant = await boot(cwd, "claimant-session");
    await claimant.pi.commands.get("ralph").handler("resume owned-loop", claimant.ctx);
    return { cwd, owner, claimant };
  }

  test("the former owner stops injecting immediately", async () => {
    const { owner } = await transferred();
    assert.equal(await inject(owner.pi, owner.ctx), undefined);
  });

  test("the former owner's `ralph_done` refuses instead of advancing the loop", async () => {
    const { owner } = await transferred();
    const result = await owner.pi.tools.get("ralph_done").execute("call", {}, undefined, undefined, owner.ctx);
    assert.match(result.content[0].text, /No active Ralph loop owned by this session/);
  });

  test("the former owner's `/ralph-stop` cannot stop the new owner's loop", async () => {
    const { cwd, owner } = await transferred();
    await owner.pi.commands.get("ralph-stop").handler("", owner.ctx);
    assert.equal(readLoop(cwd, "owned-loop").status, "active");
    assert.equal(readLoop(cwd, "owned-loop").iteration, 5);
  });

  test("the new owner injects and advances normally", async () => {
    const { cwd, claimant } = await transferred();
    assert.match(
      (await inject(claimant.pi, claimant.ctx))?.systemPrompt ?? "",
      /RALPH LOOP - owned-loop - Iteration 5\/50/,
    );
    await claimant.pi.tools.get("ralph_done").execute("call", {}, undefined, undefined, claimant.ctx);
    assert.equal(readLoop(cwd, "owned-loop").iteration, 6);
  });
});

describe("loop lifecycle", () => {
  test("`/ralph-stop` marks the owner's own loop completed", async () => {
    const cwd = makeTempDir("ralph-stop-");
    writeLoop(cwd, { ...baseState, name: "mine", taskFile: ".ralph/mine.md", ownerSessionId: "owner" });
    const { pi, ctx } = await boot(cwd, "owner");
    await inject(pi, ctx);

    await pi.commands.get("ralph-stop").handler("", ctx);
    assert.equal(readLoop(cwd, "mine").status, "completed");
    assert.equal(readLoop(cwd, "mine").active, false);
  });

  test("a completed loop is not rehydrated on the next session start", async () => {
    const cwd = makeTempDir("ralph-completed-");
    writeLoop(cwd, {
      ...baseState,
      name: "done",
      taskFile: ".ralph/done.md",
      ownerSessionId: "owner",
      active: false,
      status: "completed",
    });

    const { pi, ctx } = await boot(cwd, "owner");
    assert.equal(await inject(pi, ctx), undefined);
  });

  test("a paused loop is not rehydrated until it is resumed", async () => {
    const cwd = makeTempDir("ralph-paused-");
    writeLoop(cwd, {
      ...baseState,
      name: "held",
      taskFile: ".ralph/held.md",
      ownerSessionId: "owner",
      active: false,
      status: "paused",
    });

    const { pi, ctx } = await boot(cwd, "owner");
    assert.equal(await inject(pi, ctx), undefined);
  });

  test("an unbounded loop renders its iteration without a maximum", async () => {
    const cwd = makeTempDir("ralph-unbounded-");
    writeLoop(cwd, {
      ...baseState,
      name: "forever",
      taskFile: ".ralph/forever.md",
      ownerSessionId: "owner",
      iteration: 7,
      maxIterations: 0,
    });

    const { pi, ctx } = await boot(cwd, "owner");
    const injected = (await inject(pi, ctx))?.systemPrompt ?? "";
    assert.match(injected, /RALPH LOOP - forever - Iteration 7/);
    assert.doesNotMatch(injected, /Iteration 7\//);
  });

  test("the injected prompt keeps the caller's base prompt", async () => {
    const cwd = makeTempDir("ralph-baseprompt-");
    writeLoop(cwd, { ...baseState, name: "l", taskFile: ".ralph/l.md", ownerSessionId: "owner" });
    const { pi, ctx } = await boot(cwd, "owner");
    assert.match((await inject(pi, ctx))?.systemPrompt ?? "", /base prompt/);
  });
});

// State files written by older versions must keep loading: the fields were
// renamed, and a loop that silently stopped resuming would look like the
// feature had simply lost the user's work.
describe("legacy state migration", () => {
  test("derives a missing status from the `active` flag", async () => {
    const cwd = makeTempDir("ralph-legacy-status-");
    const legacy = { ...baseState, name: "legacy", taskFile: ".ralph/legacy.md", ownerSessionId: "owner" };
    delete legacy.status;
    writeLoop(cwd, legacy);

    const { pi, ctx } = await boot(cwd, "owner");
    assert.notEqual(await inject(pi, ctx), undefined);
  });

  test("treats a legacy inactive loop as paused rather than active", async () => {
    const cwd = makeTempDir("ralph-legacy-inactive-");
    const legacy = {
      ...baseState,
      name: "legacy",
      taskFile: ".ralph/legacy.md",
      ownerSessionId: "owner",
      active: false,
    };
    delete legacy.status;
    writeLoop(cwd, legacy);

    const { pi, ctx } = await boot(cwd, "owner");
    assert.equal(await inject(pi, ctx), undefined);
  });

  // Asserted through the status line rather than the file on disk: the
  // migration runs in memory on load, and nothing rewrites the state file just
  // for reading it. The countdown is what the renamed field actually drives.
  test("carries the old `reflectEveryItems` field into the reflection countdown", async () => {
    const cwd = makeTempDir("ralph-legacy-reflect-");
    const legacy = {
      ...baseState,
      name: "legacy",
      taskFile: ".ralph/legacy.md",
      ownerSessionId: "owner",
      iteration: 3,
    };
    delete legacy.reflectEvery;
    legacy.reflectEveryItems = 4;
    writeLoop(cwd, legacy);

    const { pi, ctx } = await boot(cwd, "owner");
    await inject(pi, ctx);
    // 4 - ((3 - 1) % 4) = 2 iterations until the next reflection.
    assert.match(ctx.statuses.at(-1) ?? "", /reflect in 2/);
  });

  test("shows no countdown when the legacy cadence was unset", async () => {
    const cwd = makeTempDir("ralph-legacy-noreflect-");
    const legacy = {
      ...baseState,
      name: "legacy",
      taskFile: ".ralph/legacy.md",
      ownerSessionId: "owner",
      iteration: 3,
    };
    delete legacy.reflectEvery;
    writeLoop(cwd, legacy);

    const { pi, ctx } = await boot(cwd, "owner");
    await inject(pi, ctx);
    assert.doesNotMatch(ctx.statuses.at(-1) ?? "", /reflect in/);
  });
});
