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
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import ralphExtension from "../index.ts";

function makeCtx(cwd, sessionId = "fresh-session") {
  const statuses = [];
  const branch = [{ id: "root", type: "custom" }];
  return {
    branch,
    cwd,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
    abort() {},
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
    sentMessages: [],
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
    sendMessage(message, options) {
      this.sentMessages.push({ message, options });
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
let nativeTimestamp = 0;
const inject = async (pi, ctx, prompt = "Continue", source = "interactive") => {
  await pi.events.get("input")({ text: prompt, source }, ctx);
  await pi.events.get("before_agent_start")({ prompt, systemPrompt: "base prompt" }, ctx);
  const message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: ++nativeTimestamp };
  await pi.events.get("message_start")({ message }, ctx);
  ctx.branch.push({ id: `native-${nativeTimestamp}`, type: "message", message });
  const result = await pi.events.get("context")({ messages: [message] }, ctx);
  const directive = result.messages.find((message) => message.customType === "ralph-iteration-context");
  return directive ? { systemPrompt: `base prompt\n${directive.content}` } : undefined;
};

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
  ownerBranchIds: ["root"],
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

  test("a matching session ID without a nonempty branch proof requires explicit resume", async () => {
    for (const proof of [undefined, []]) {
      const cwd = makeTempDir("ralph-session-proof-");
      const state = {
        ...baseState,
        name: "unbound",
        taskFile: ".ralph/unbound.md",
        ownerSessionId: "owner",
        ownerBranchIds: proof,
      };
      writeLoop(cwd, state);
      const { pi, ctx } = await boot(cwd, "owner");
      assert.equal(await inject(pi, ctx), undefined);
      await pi.commands.get("ralph").handler("resume unbound", ctx);
      assert.match(
        (await inject(pi, ctx, pi.sentUserMessages.at(-1).message, "extension"))?.systemPrompt ?? "",
        /RALPH LOOP - unbound/,
      );
    }
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
    assert.equal(fs.readFileSync(path.join(cwd, ".ralph", "started-loop.md"), "utf8"), "# Task\n");
    assert.equal(pi.sentUserMessages.length, 1);
    assert.equal(pi.sentUserMessages[0].options.deliverAs, "followUp");
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
  for (const stopReason of ["error", "aborted"]) {
    test(`${stopReason} at the maximum retains resumability, even with a partial completion marker`, async () => {
      const cwd = makeTempDir("ralph-max-interrupted-");
      writeLoop(cwd, {
        ...baseState,
        name: "final",
        taskFile: ".ralph/final.md",
        iteration: 3,
        maxIterations: 3,
        ownerSessionId: "owner",
      });
      const { pi, ctx } = await boot(cwd, "owner");
      await pi.events.get("agent_end")(
        {
          messages: [
            {
              role: "assistant",
              stopReason,
              content: [{ type: "text", text: "<promise>COMPLETE</promise>" }],
            },
          ],
        },
        ctx,
      );
      await pi.events.get("agent_settled")({ aborted: stopReason === "aborted" }, ctx);
      assert.equal(readLoop(cwd, "final").status, "active");
      assert.equal(readLoop(cwd, "final").completedAt, undefined);
      assert.equal(pi.sentUserMessages.length, 0, "sent a completed banner");
      assert.match((await inject(pi, ctx)).systemPrompt, /Iteration 3\/3/);
      // A subsequent successful retry can still finish the loop.
      await pi.events.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
      assert.equal(readLoop(cwd, "final").status, "active");
      await pi.events.get("agent_settled")({ aborted: false }, ctx);
      assert.equal(readLoop(cwd, "final").status, "completed");
    });
  }

  test("ralph_done's queued final iteration is not completed until delivered", async () => {
    const cwd = makeTempDir("ralph-max-queued-");
    writeLoop(cwd, {
      ...baseState,
      name: "final",
      taskFile: ".ralph/final.md",
      iteration: 2,
      maxIterations: 3,
      ownerSessionId: "owner",
    });
    const { pi, ctx } = await boot(cwd, "owner");
    await inject(pi, ctx);
    await pi.tools.get("ralph_done").execute("advance", {}, undefined, undefined, ctx);
    assert.equal(readLoop(cwd, "final").iteration, 3);
    assert.equal(pi.sentUserMessages.length, 1);
    ctx.hasPendingMessages = () => true;
    await pi.events.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    assert.equal(readLoop(cwd, "final").status, "active");
    assert.equal(pi.sentUserMessages.length, 1, "queued a premature terminal banner");
    ctx.hasPendingMessages = () => false;
    await inject(pi, ctx, pi.sentUserMessages.at(-1).message, "extension");
    await pi.events.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
    assert.equal(readLoop(cwd, "final").status, "active");
    await pi.events.get("agent_settled")({ aborted: false }, ctx);
    assert.equal(readLoop(cwd, "final").status, "completed");
    assert.equal(pi.sentUserMessages.length, 1);
    assert.equal(pi.sentMessages.length, 1);
    assert.equal(pi.sentMessages[0].options.triggerTurn, false);
  });

  test("a deferred RPC nuke settles on session abort and ignores a late yes without accessing the retired ctx", async () => {
    const cwd = makeTempDir("ralph-nuke-replaced-");
    const { pi, ctx } = await boot(cwd, "old-owner");
    const runner = new ExtensionRunner([], {}, cwd, {}, {});
    let answer;
    let dialogSignal;
    runner.setUIContext(
      {
        ...ctx.ui,
        confirm: (_title, _message, options) => {
          dialogSignal = options.signal;
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      },
      "rpc",
    );
    const rpcCtx = { ...ctx, mode: "rpc", ui: runner.getUIContext() };
    let retired = false;
    let retiredReads = 0;
    const oldCtx = new Proxy(rpcCtx, {
      get(target, key) {
        if (retired) {
          retiredReads++;
          throw new Error("Session context is no longer valid");
        }
        return Reflect.get(target, key);
      },
    });
    let settled = false;
    const command = pi.commands
      .get("ralph")
      .handler("nuke", oldCtx)
      .then(() => {
        settled = true;
      });
    assert.ok(answer, "confirmation was not opened");
    assert.equal(settled, false, "command detached its confirmation");
    await pi.events.get("session_shutdown")({}, oldCtx);
    retired = true;
    await pi.events.get("session_start")({}, makeCtx(cwd, "new-owner"));
    await command;
    assert.equal(dialogSignal.aborted, true);
    assert.equal(settled, true);
    assert.equal(fs.existsSync(path.join(cwd, ".ralph")), true);
    answer(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(path.join(cwd, ".ralph")), true);
    assert.equal(retiredReads, 0);
  });

  test("nuke catches confirmation failure and still deletes only after an awaited yes", async () => {
    const cwd = makeTempDir("ralph-nuke-confirm-");
    const { pi, ctx } = await boot(cwd, "owner");
    ctx.ui.confirm = async () => {
      throw new Error("RPC disconnected");
    };
    await pi.commands.get("ralph").handler("nuke", ctx);
    assert.equal(fs.existsSync(path.join(cwd, ".ralph")), true);
    ctx.ui.confirm = async () => true;
    await pi.commands.get("ralph").handler("nuke", ctx);
    assert.equal(fs.existsSync(path.join(cwd, ".ralph")), false);
  });
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

describe("activation and final settlement", () => {
  for (const task of ["", " \n\t", null]) {
    test(`invalid task ${JSON.stringify(task)} cannot change live or persisted activation`, async () => {
      const cwd = makeTempDir("ralph-invalid-activation-");
      writeLoop(cwd, { ...baseState, name: "valid", taskFile: ".ralph/valid.md", ownerSessionId: "owner" });
      writeLoop(cwd, {
        ...baseState,
        name: "invalid",
        taskFile: ".ralph/invalid.md",
        status: "paused",
        active: false,
        ownerSessionId: "foreign",
      });
      const file = path.join(cwd, ".ralph", "invalid.md");
      if (task === null) {
        fs.unlinkSync(file);
        fs.mkdirSync(file); // Deterministically unreadable as a UTF-8 file, even with privileged permissions.
      } else fs.writeFileSync(file, task);
      const { pi, ctx } = await boot(cwd, "owner");
      const snapshot = ["valid", "invalid"].map((name) =>
        fs.readFileSync(path.join(cwd, ".ralph", `${name}.state.json`)),
      );
      for (const command of ["start invalid", "resume invalid"]) {
        await pi.commands.get("ralph").handler(command, ctx);
        for (const [index, name] of ["valid", "invalid"].entries()) {
          assert.deepEqual(fs.readFileSync(path.join(cwd, ".ralph", `${name}.state.json`)), snapshot[index]);
        }
        assert.equal(pi.sentUserMessages.length, 0);
        assert.match((await inject(pi, ctx))?.systemPrompt ?? "", /RALPH LOOP - valid/);
        // Native acceptance may update the valid branch proof, not the failed activation.
        snapshot[0] = fs.readFileSync(path.join(cwd, ".ralph", "valid.state.json"));
      }
      for (const taskContent of ["", " \n\t"]) {
        await assert.rejects(
          pi.tools.get("ralph_start").execute("invalid", { name: "invalid", taskContent }, undefined, undefined, ctx),
          /non-whitespace/,
        );
        assert.deepEqual(fs.readFileSync(path.join(cwd, ".ralph", "invalid.state.json")), snapshot[1]);
      }
      assert.equal(pi.sentUserMessages.length, 0);
    });
  }

  test("a blank next task pauses without advancing the iteration", async () => {
    const cwd = makeTempDir("ralph-invalid-next-");
    const { pi, ctx } = await boot(cwd, "owner");
    await pi.tools
      .get("ralph_start")
      .execute("start", { name: "next", taskContent: "Task" }, undefined, undefined, ctx);
    await inject(pi, ctx, pi.sentUserMessages[0].message, "extension");
    fs.writeFileSync(path.join(cwd, ".ralph", "next.md"), " \n\t");
    await pi.tools.get("ralph_done").execute("done", {}, undefined, undefined, ctx);
    assert.equal(readLoop(cwd, "next").iteration, 1);
    assert.equal(readLoop(cwd, "next").status, "paused");
    assert.equal(pi.sentUserMessages.length, 1);
  });

  test("authorized recovery pauses only demonstrably same-session same-branch duplicates", async () => {
    const cwd = makeTempDir("ralph-duplicates-");
    for (const [name, ownerSessionId, ownerBranchIds] of [
      ["owned-a", "owner", ["root"]],
      ["owned-b", "owner", ["root"]],
      ["foreign", "other", ["root"]],
      ["sibling", "owner", ["sibling-root"]],
      ["unproved", "owner", []],
    ])
      writeLoop(cwd, { ...baseState, name, taskFile: `.ralph/${name}.md`, ownerSessionId, ownerBranchIds });
    const protectedNames = ["foreign", "sibling", "unproved"];
    const protectedBytes = protectedNames.map((name) =>
      fs.readFileSync(path.join(cwd, ".ralph", `${name}.state.json`)),
    );
    const { pi, ctx } = await boot(cwd, "owner");
    assert.deepEqual(["owned-a", "owned-b"].map((name) => readLoop(cwd, name).status).sort(), ["active", "paused"]);
    assert.equal(pi.sentUserMessages.length, 0, "recovery never dispatches a prompt");
    // Recover an additional duplicate not referenced by currentLoop on explicit activation.
    writeLoop(cwd, { ...baseState, name: "extra", taskFile: ".ralph/extra.md", ownerSessionId: "owner" });
    await pi.commands.get("ralph").handler("start new", ctx);
    for (const name of ["owned-a", "owned-b", "extra"]) assert.equal(readLoop(cwd, name).status, "paused");
    for (const [index, name] of protectedNames.entries()) {
      assert.deepEqual(fs.readFileSync(path.join(cwd, ".ralph", `${name}.state.json`)), protectedBytes[index]);
    }
  });

  for (const maxIterations of [1, 2, 0]) {
    test(`N=${maxIterations} preserves queued/executing identity and duplicate done is harmless`, async () => {
      const cwd = makeTempDir("ralph-settlement-");
      const { pi, ctx } = await boot(cwd, "owner");
      await pi.tools
        .get("ralph_start")
        .execute("start", { name: "bounded", taskContent: "Task", maxIterations }, undefined, undefined, ctx);
      const done = () => pi.tools.get("ralph_done").execute("done", {}, undefined, undefined, ctx);
      await inject(pi, ctx, pi.sentUserMessages[0].message, "extension");
      if (maxIterations !== 1) {
        await done();
        await done();
        assert.equal(pi.sentUserMessages.length, 2);
        assert.equal(readLoop(cwd, "bounded").iteration, 2);
        await pi.events.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
        await pi.events.get("agent_settled")({ aborted: false }, ctx);
        assert.equal(readLoop(cwd, "bounded").status, "active", "queued final prompt is not executed work");
        await inject(pi, ctx, pi.sentUserMessages[1].message, "extension");
      } else {
        await done();
        await done();
        assert.equal(pi.sentUserMessages.length, 1);
        assert.equal(readLoop(cwd, "bounded").status, "active");
      }
      const end = () =>
        pi.events.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", content: [] }] }, ctx);
      await end();
      assert.equal(readLoop(cwd, "bounded").status, "active", "agent_end cannot finalize");
      await pi.events.get("agent_settled")({ aborted: false }, ctx);
      assert.equal(readLoop(cwd, "bounded").status, maxIterations ? "completed" : "active");
      assert.equal(pi.sentMessages.length, maxIterations ? 1 : 0);
      if (maxIterations) assert.equal(pi.sentMessages[0].options.triggerTurn, false);
      else {
        await inject(pi, ctx, "Finish the unlimited loop");
        await pi.events.get("agent_end")(
          {
            messages: [
              {
                role: "assistant",
                stopReason: "stop",
                content: [{ type: "text", text: "<promise>COMPLETE</promise>" }],
              },
            ],
          },
          ctx,
        );
        assert.equal(readLoop(cwd, "bounded").status, "active");
        await pi.events.get("agent_settled")({ aborted: false }, ctx);
        assert.equal(readLoop(cwd, "bounded").status, "completed");
        assert.equal(pi.sentMessages.length, 1);
        assert.equal(pi.sentMessages[0].options.triggerTurn, false);
        assert.equal(pi.sentUserMessages.length, 2);
      }
    });
  }
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
