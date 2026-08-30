/**
 * workspace-containment.test.mjs — a task file never lands outside the project.
 *
 * `/ralph start <name|path>` takes a raw path, and this extension exists to
 * drive long unattended loops: the command is as likely to be issued by a model
 * as typed by a person. Without a containment check the path is resolved
 * straight against the session cwd, so `../../notes.md` would `mkdir -p` and
 * create a file outside the directory the user actually opened — silently, and
 * before the loop even starts.
 *
 * The persisted-state paths are covered too. A `.state.json` written before
 * this check existed, or edited by hand, must not become a way to read or move
 * files from outside the workspace either.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import ralphExtension from "../index.ts";

const tempDirs = [];

function makeTempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(cwd, sessionId = "session-1") {
  const notices = [];
  return {
    cwd,
    notices,
    sessionManager: { getSessionId: () => sessionId },
    hasUI: true,
    ui: {
      notify(message, level) {
        notices.push({ message, level });
      },
      setStatus() {},
      setWidget() {},
      confirm: async () => false,
      theme: { fg: (_n, t) => t, bold: (t) => t },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function makePi() {
  const events = new Map();
  return {
    events,
    commands: new Map(),
    tools: new Map(),
    sentUserMessages: [],
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

async function boot(cwd) {
  const pi = makePi();
  ralphExtension(pi);
  const ctx = makeCtx(cwd);
  await pi.events.get("session_start")({}, ctx);
  return { pi, ctx };
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("task files stay inside the workspace", () => {
  test("/ralph start refuses a path that escapes the project", async () => {
    // A sibling of the workspace, which the extension has no business touching.
    const parent = makeTempDir("ralph-parent-");
    const cwd = path.join(parent, "project");
    fs.mkdirSync(cwd, { recursive: true });
    const outside = path.join(parent, "escaped", "notes.md");

    const { pi, ctx } = await boot(cwd);
    await pi.commands.get("ralph").handler("start ../escaped/notes.md", ctx);

    assert.equal(fs.existsSync(outside), false, "created a file outside the workspace");
    assert.equal(fs.existsSync(path.dirname(outside)), false, "created a directory outside the workspace");
    assert.ok(
      ctx.notices.some((n) => n.level === "error" && /inside the workspace/.test(n.message)),
      `expected a containment error, got: ${JSON.stringify(ctx.notices)}`,
    );
    // Refused before any state was recorded, so nothing resumes it later.
    assert.equal(fs.existsSync(path.join(cwd, ".ralph")), false);
  });

  test("/ralph start still accepts a path inside the project", async () => {
    const cwd = makeTempDir("ralph-inside-");
    const { pi, ctx } = await boot(cwd);
    await pi.commands.get("ralph").handler("start docs/plan.md", ctx);

    assert.equal(fs.existsSync(path.join(cwd, "docs", "plan.md")), true);
    assert.equal(
      ctx.notices.some((n) => n.level === "error"),
      false,
      `unexpected error: ${JSON.stringify(ctx.notices)}`,
    );
  });

  test("an absolute path outside the project is refused", async () => {
    const outsideDir = makeTempDir("ralph-abs-");
    const cwd = makeTempDir("ralph-abs-cwd-");
    const target = path.join(outsideDir, "plan.md");

    const { pi, ctx } = await boot(cwd);
    await pi.commands.get("ralph").handler(`start ${target}`, ctx);

    assert.equal(fs.existsSync(target), false);
    assert.ok(ctx.notices.some((n) => n.level === "error" && /inside the workspace/.test(n.message)));
  });

  test("a filename that merely starts with two dots is not an escape", async () => {
    // `path.relative` returns "..notes.md" here, which a bare
    // `startsWith("..")` reads as a traversal. It is an ordinary file sitting
    // in the workspace, and refusing it would be a containment check that
    // blocks legitimate work while proving nothing. The leading `./` is what
    // makes `start` treat the argument as a path rather than a loop name.
    const cwd = makeTempDir("ralph-dotdot-");
    const { pi, ctx } = await boot(cwd);
    await pi.commands.get("ralph").handler("start ./..notes.md", ctx);

    assert.equal(fs.existsSync(path.join(cwd, "..notes.md")), true);
    assert.equal(
      ctx.notices.some((n) => n.level === "error"),
      false,
      `unexpected error: ${JSON.stringify(ctx.notices)}`,
    );
  });

  test("a symlink inside the workspace cannot smuggle a path out of it", async () => {
    // A lexical containment check passes this: every segment of
    // `linked/plan.md` is under the workspace. Only canonicalizing shows that
    // `linked` is a door into the sibling directory.
    const parent = makeTempDir("ralph-symlink-");
    const cwd = path.join(parent, "project");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, "linked"), "dir");

    const { pi, ctx } = await boot(cwd);
    await pi.commands.get("ralph").handler("start linked/plan.md", ctx);

    assert.equal(fs.existsSync(path.join(outside, "plan.md")), false, "wrote through a symlink out of the workspace");
    assert.ok(
      ctx.notices.some((n) => n.level === "error" && /inside the workspace/.test(n.message)),
      `expected a containment error, got: ${JSON.stringify(ctx.notices)}`,
    );
  });

  test("the ralph_start tool refuses an escaping name rather than writing", async () => {
    const parent = makeTempDir("ralph-tool-");
    const cwd = path.join(parent, "project");
    fs.mkdirSync(cwd, { recursive: true });

    const { pi, ctx } = await boot(cwd);
    // `sanitize` already strips separators from a tool-supplied name, so this
    // asserts the invariant holds rather than that the gate is reachable: the
    // name lands under .ralph/ and nothing appears beside the workspace.
    const result = await pi.tools.get("ralph_start").execute(
      "call-1",
      {
        name: "../escape",
        taskContent: "# task\n",
      },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(fs.existsSync(path.join(parent, "escape.md")), false);
    assert.ok(result, "tool returned nothing");
  });

  test("a tampered state file cannot feed an outside task into the loop", async () => {
    // `/ralph resume` reads the task file named by persisted state. A state
    // file written before this check existed, or edited by hand, must not be a
    // way to pull a file from outside the workspace into the loop prompt.
    const parent = makeTempDir("ralph-state-");
    const cwd = path.join(parent, "project");
    fs.mkdirSync(cwd, { recursive: true });
    const outside = path.join(parent, "outside.md");
    fs.writeFileSync(outside, "# not for the loop\n", "utf8");

    const { pi, ctx } = await boot(cwd);
    const ralph = pi.commands.get("ralph").handler;

    // Start legitimately, then pause so resume has something to reopen.
    await ralph("start contained", ctx);
    await ralph("pause", ctx);

    // Repoint the persisted task file outside the workspace.
    const statePath = path.join(cwd, ".ralph", "contained.state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.taskFile = "../outside.md";
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

    ctx.notices.length = 0;
    await ralph("resume contained", ctx);

    const sent = JSON.stringify(pi.sentUserMessages);
    assert.equal(sent.includes("not for the loop"), false, "leaked a file from outside the workspace");
    assert.ok(
      ctx.notices.some((n) => n.level === "error" && /Could not read task file/.test(n.message)),
      `expected the read to be refused, got: ${JSON.stringify(ctx.notices)}`,
    );
  });
});
