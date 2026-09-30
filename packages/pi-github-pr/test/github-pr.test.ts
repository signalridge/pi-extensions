import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { afterAll, onTestFinished, test, vi } from "vitest";
import githubPr, {
  formatCompactStatus,
  formatLinkedStatus,
  ghPrViewInvocation,
  isPullRequestVisible,
  normalizeGhPrView,
  runGhPrView,
} from "../src/github-pr.js";
import { createMockContext, createMockPi } from "./support.js";

type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };
type ExecCall = { command: string; args: string[]; options?: ExecOptions };
type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const ambientGhHost = process.env.GH_HOST;
delete process.env.GH_HOST;
afterAll(() => {
  if (ambientGhHost !== undefined) process.env.GH_HOST = ambientGhHost;
});

const okResult = (stdout: unknown): ExecResult => ({
  stdout: JSON.stringify(stdout),
  stderr: "",
  code: 0,
  killed: false,
});

const textResult = (stdout: string, code = 0, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  code,
  killed: false,
});

const sampleCounts = {
  data: {
    repository: {
      pullRequest: {
        comments: { totalCount: 2 },
        reviews: { totalCount: 3 },
      },
    },
  },
};

const samplePr = {
  number: 123,
  state: "OPEN",
  closedAt: null,
  mergedAt: null,
  isDraft: false,
  url: "https://github.com/signalridge/pi-extensions/pull/123",
  reviewDecision: "APPROVED",
  latestReviews: [
    { state: "APPROVED", author: { login: "alice" } },
    { state: "COMMENTED", author: { login: "bob" } },
  ],
  reviews: [
    { state: "COMMENTED", author: { login: "alice" } },
    { state: "APPROVED", author: { login: "alice" } },
    { state: "COMMENTED", author: { login: "bob" } },
  ],
  comments: [{}, {}],
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "FAILURE" }, { status: "IN_PROGRESS" }],
};

test("github-pr registers only passive lifecycle events", () => {
  const mock = createMockPi();
  githubPr(mock.pi);

  assert.equal(mock.commands.size, 0);
  assert.deepEqual(mock.tools, []);
  assert.deepEqual([...mock.events.keys()].sort(), ["agent_end", "session_shutdown", "session_start"]);
});

test("normalizeGhPrView summarizes approved reviews, failing checks, and comments", () => {
  const status = normalizeGhPrView(samplePr);

  assert.deepEqual(status.checks, { passed: 1, failed: 1, pending: 1, total: 3 });
  assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
  assert.deepEqual(status.review.approvedBy, ["alice"]);
  assert.equal(formatCompactStatus(status), "PR #123: checks failing (1), approved, 5 comments");
  assert.equal(
    formatLinkedStatus(status),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );
});

test("formatLinkedStatus falls back to plain text when the PR url is missing", () => {
  const status = normalizeGhPrView({ ...samplePr, url: undefined });

  assert.equal(status.url, "");
  assert.equal(formatLinkedStatus(status), formatCompactStatus(status));
});

test("formatLinkedStatus rejects invalid and non-http PR urls", () => {
  const status = normalizeGhPrView(samplePr);

  for (const url of ["not a url", "javascript:alert(1)"]) {
    const candidate = { ...status, url };
    assert.equal(formatLinkedStatus(candidate), formatCompactStatus(candidate));
  }
});

test("formatLinkedStatus strips terminal controls from OSC 8 url and text", () => {
  const status = normalizeGhPrView({ ...samplePr, url: `${samplePr.url}\x1b` });
  const unsafeNumber = { toString: () => "12\x1b\n3" } as unknown as number;
  const rendered = formatLinkedStatus({ ...status, number: unsafeNumber });

  const controls = [...rendered]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
    .join("");
  assert.equal(controls, "\x1b\x07\x1b\x07");
  assert.ok(rendered.includes("#123"));
  assert.ok(!rendered.includes("#12\x1b\n3"));
});

test("normalizeGhPrView summarizes pending, changes-requested, draft, and commented reviews", () => {
  const changesRequested = normalizeGhPrView({
    ...samplePr,
    reviewDecision: "CHANGES_REQUESTED",
    latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
    comments: undefined,
    statusCheckRollup: [{ status: "QUEUED" }],
  });
  const draft = normalizeGhPrView({
    ...samplePr,
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
    latestReviews: [],
    reviews: [],
    comments: undefined,
    statusCheckRollup: [],
  });
  const commented = normalizeGhPrView({
    ...samplePr,
    reviewDecision: "REVIEW_REQUIRED",
    latestReviews: [{ state: "COMMENTED", author: { login: "copilot" } }],
    comments: [],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  });

  assert.deepEqual(changesRequested.comments, { issue: 0, reviews: 3, total: 3 });
  assert.equal(formatCompactStatus(changesRequested), "PR #123: checks pending (1), changes requested, 3 comments");
  assert.deepEqual(draft.comments, { issue: 0, reviews: 0, total: 0 });
  assert.equal(formatCompactStatus(draft), "PR #123: no checks, draft, no comments");
  assert.equal(formatCompactStatus(commented), "PR #123: checks passing, review required, 3 comments");
});

test("terminal pull requests use their terminal state and expire after 24 hours", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const merged = normalizeGhPrView({
    ...samplePr,
    state: "MERGED",
    mergedAt: "2026-06-25T12:00:00.001Z",
  });
  const closed = normalizeGhPrView({
    ...samplePr,
    state: "CLOSED",
    closedAt: "2026-06-25T12:00:00.000Z",
  });

  assert.equal(formatCompactStatus(merged), "PR #123: merged");
  assert.equal(formatCompactStatus(closed), "PR #123: closed");
  assert.equal(isPullRequestVisible(merged, now), true);
  assert.equal(isPullRequestVisible(closed, now), false);
  assert.equal(isPullRequestVisible({ ...merged, mergedAt: undefined }, now), false);
  assert.equal(isPullRequestVisible({ ...closed, closedAt: "invalid" }, now), false);
  assert.equal(isPullRequestVisible(normalizeGhPrView(samplePr), now), true);
  assert.equal(isPullRequestVisible(normalizeGhPrView({ ...samplePr, closedAt: "invalid" }), now), true);
});

test("normalizeGhPrView accepts count-only review and comment payloads", () => {
  const status = normalizeGhPrView({
    ...samplePr,
    reviews: { totalCount: 3 },
    comments: { totalCount: 2 },
  });

  assert.deepEqual(status.comments, { issue: 2, reviews: 3, total: 5 });
});

test("gh pr view resolves the repository host on POSIX and Windows", () => {
  const args = [
    "pr",
    "view",
    "--json",
    "number,isDraft,url,state,closedAt,mergedAt,reviewDecision,latestReviews,statusCheckRollup",
  ];

  assert.deepEqual(ghPrViewInvocation(undefined, "linux"), { command: "gh", args });
  assert.deepEqual(ghPrViewInvocation("git.example.com", "darwin"), {
    command: "env",
    args: ["-u", "GH_HOST", "gh", ...args],
  });
  assert.deepEqual(ghPrViewInvocation("git.example.com", "win32", "C:\\Windows\\cmd.exe"), {
    command: "C:\\Windows\\cmd.exe",
    args: ["/d", "/s", "/c", `set "GH_HOST=" && gh ${args.join(" ")}`],
  });
});

test("runGhPrView calls gh pr view for the current branch and reports actionable failures", async () => {
  const calls: ExecCall[] = [];
  const ghHosts: Array<string | undefined> = [];
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      ghHosts.push(process.env.GH_HOST);
      if (command === "gh" && args[0] === "pr" && process.env.GH_HOST) {
        return textResult("", 1, "none of the git remotes configured for this repository correspond to GH_HOST");
      }
      return okResult(calls.length === 1 ? samplePr : sampleCounts);
    },
  } satisfies { exec: ExecFunction };
  const previousGhHost = process.env.GH_HOST;
  process.env.GH_HOST = "github.netflix.net";

  let status: Awaited<ReturnType<typeof runGhPrView>>;
  let restoredGhHost: string | undefined;
  try {
    status = await runGhPrView(pi, "/repo");
    restoredGhHost = process.env.GH_HOST;
  } finally {
    if (previousGhHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previousGhHost;
  }

  assert.equal(status.number, 123);
  assert.deepEqual(ghHosts, ["github.netflix.net", "github.netflix.net"]);
  assert.equal(restoredGhHost, "github.netflix.net");
  assert.equal(calls.length, 2);
  const prArgs = [
    "pr",
    "view",
    "--json",
    "number,isDraft,url,state,closedAt,mergedAt,reviewDecision,latestReviews,statusCheckRollup",
  ];
  assert.deepEqual(
    calls[0],
    process.platform === "win32"
      ? {
          command: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", `set "GH_HOST=" && gh ${prArgs.join(" ")}`],
          options: { cwd: "/repo", signal: undefined, timeout: 10_000 },
        }
      : {
          command: "env",
          args: ["-u", "GH_HOST", "gh", ...prArgs],
          options: { cwd: "/repo", signal: undefined, timeout: 10_000 },
        },
  );
  assert.deepEqual(calls[1]?.options, { cwd: "/repo", signal: undefined, timeout: 10_000 });
  assert.deepEqual(calls[1]?.args.slice(0, 6), ["api", "graphql", "--hostname", "github.com", "-f", calls[1]?.args[5]]);
  assert.match(calls[1]?.args[5] ?? "", /^query=\s*query PullRequestCounts/);
  assert.deepEqual(calls[1]?.args.slice(6), [
    "-F",
    "owner=signalridge",
    "-F",
    "name=pi-extensions",
    "-F",
    "number=123",
  ]);

  await assert.rejects(
    runGhPrView(
      {
        exec: async () => {
          throw new Error("spawn gh ENOENT");
        },
      },
      "/repo",
    ),
    /GitHub CLI not found/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => {
          throw new Error("operation aborted");
        },
      },
      "/repo",
    ),
    /gh pr view could not start: operation aborted/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => {
          throw new Error("spawn gh EACCES");
        },
      },
      "/repo",
    ),
    /gh pr view could not start: spawn gh EACCES/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({ stdout: "", stderr: "not logged in", code: 1, killed: false }),
      },
      "/repo",
    ),
    /gh auth login/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({
          stdout: "",
          stderr: "not a GitHub repository",
          code: 1,
          killed: false,
        }),
      },
      "/repo",
    ),
    /No GitHub pull request found/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({
          stdout: "",
          stderr: "no pull requests found",
          code: 1,
          killed: false,
        }),
      },
      "/repo",
    ),
    /No GitHub pull request found/,
  );
  await assert.rejects(
    runGhPrView(
      {
        exec: async () => ({
          stdout: "",
          stderr: "HTTP 404: Not Found",
          code: 1,
          killed: false,
        }),
      },
      "/repo",
    ),
    /gh pr view failed/,
  );
});

test("runGhPrView sends gh api graphql to the enterprise PR host", async () => {
  const calls: ExecCall[] = [];
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return okResult(
        args[0] === "pr" ? { ...samplePr, url: "https://github.example.com:8443/org/repo/pull/123" } : sampleCounts,
      );
    },
  } satisfies { exec: ExecFunction };

  await runGhPrView(pi, "/repo");

  assert.deepEqual(calls[1]?.args.slice(0, 4), ["api", "graphql", "--hostname", "github.example.com:8443"]);
  assert.deepEqual(calls[1]?.args.slice(6), ["-F", "owner=org", "-F", "name=repo", "-F", "number=123"]);
});

test("session startup returns before slow GitHub calls complete, then publishes their result", async () => {
  const mock = createMockPi();
  const prView = deferred<ExecResult>();
  let initialSignal: AbortSignal | undefined;
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      initialSignal = options?.signal;
      return prView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, context.ctx), undefined);
    await waitForMicrotasks(
      () => initialSignal !== undefined,
      "initial GitHub request starts without blocking startup",
    );
    assert.ok(initialSignal);
    assert.equal(initialSignal.aborted, false);
    assert.equal(context.statuses.get("github-pr"), undefined);

    prView.resolve(okResult(samplePr));
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial status appears");
  } finally {
    prView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("a one-shot startup status-clear failure still discovers Git, refreshes, and polls", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const mock = createMockPi();
  let gitCalls = 0;
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") {
      gitCalls += 1;
      return textResult("", 128, "not a git repository");
    }
    if (args[0] === "pr") {
      prViews += 1;
      return okResult({ ...samplePr, number: prViews === 1 ? 123 : 456 });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  context.statuses.set("github-pr", "stale status");
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);
  const originalSetStatus = context.ctx.ui.setStatus.bind(context.ctx.ui);
  let clearAttempts = 0;
  context.ctx.ui.setStatus = (key, value) => {
    if (key === "github-pr" && value === undefined && ++clearAttempts === 1) {
      throw new Error("statusline temporarily unavailable");
    }
    originalSetStatus(key, value);
  };

  try {
    assert.equal(sessionStart({}, context.ctx), undefined);
    await waitForMicrotasks(() => gitCalls === 1, "Git discovery survives the failed status clear");
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "first PR status");
    assert.equal(clearAttempts, 1, "startup does not loop on a failed UI clear");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "polling remains armed");
    vi.advanceTimersByTime(100);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#456"), "poll status");
    assert.equal(prViews, 2);
    assert.equal(vi.getTimerCount(), 1, "the next poll is armed after recovery");
  } finally {
    context.ctx.ui.setStatus = originalSetStatus;
    await sessionShutdown({}, context.ctx);
  }
});

test("a turn abort during Git discovery still installs the branch watcher and refreshes", async () => {
  const { root, headPath } = createGitHeadFixture();

  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const gitSettled = deferred<void>();
  let gitSignal: AbortSignal | undefined;
  let prViews = 0;
  installExec(mock, async (command, args, options) => {
    if (command === "git") {
      gitSignal = options?.signal;
      const result = await gitResult.promise;
      gitSettled.resolve();
      return result;
    }
    if (args[0] === "pr") {
      prViews += 1;
      return okResult(prViews === 1 ? samplePr : { ...samplePr, number: 456, url: "https://github.com/o/r/pull/456" });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 10_000 });
  const turn = new AbortController();
  const context = createMockContext({ cwd: root, signal: turn.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, context.ctx), undefined);
    assert.ok(gitSignal);
    turn.abort();
    assert.equal(gitSignal.aborted, false, "session-owned Git discovery survives the cancelled turn");
    gitResult.resolve(textResult(".git/HEAD\n"));
    await gitSettled.promise;
    await waitForMicrotasks(() => prViews === 1, "initial PR refresh after cancelled discovery");
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial status");

    writeFileSync(headPath, "ref: refs/heads/main\n");
    await waitFor(() => prViews >= 2, "branch watcher refreshes after turn abort");
    await waitFor(() => (context.statuses.get("github-pr") ?? "").includes("#456"), "new branch status");
  } finally {
    gitResult.resolve(textResult(".git/HEAD\n"));
    await sessionShutdown({}, context.ctx);
  }
});

test("startup refresh does not adopt a later turn's live signal", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const gitSettled = deferred<void>();
  const firstPrView = deferred<ExecResult>();
  let firstPrSignal: AbortSignal | undefined;
  let prViews = 0;
  installExec(mock, async (command, args, options) => {
    if (command === "git") {
      const result = await gitResult.promise;
      gitSettled.resolve();
      return result;
    }
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) {
        firstPrSignal = options?.signal;
        return firstPrView.promise;
      }
      return okResult({ ...samplePr, number: 456, url: "https://github.com/o/r/pull/456" });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const startupTurn = new AbortController();
  const laterTurn = new AbortController();
  let liveSignal = startupTurn.signal;
  const context = createMockContext({ cwd: "/repo", signal: startupTurn.signal });
  Object.defineProperty(context.ctx, "signal", { get: () => liveSignal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, context.ctx), undefined);
    liveSignal = laterTurn.signal;
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await gitSettled.promise;
    await waitForMicrotasks(() => firstPrSignal !== undefined, "initial PR request starts after Git discovery");
    assert.ok(firstPrSignal);
    assert.notEqual(firstPrSignal, laterTurn.signal);
    laterTurn.abort();
    assert.equal(firstPrSignal.aborted, false, "a later turn cannot cancel the session-owned initial request");

    firstPrView.resolve(okResult(samplePr));
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial status");
    await drainMicrotasks();
    vi.advanceTimersByTime(100);
    await waitForMicrotasks(() => prViews === 2, "polling continues after later turn cancellation");
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#456"), "periodic status");
  } finally {
    gitResult.resolve(textResult("", 128, "not a git repository"));
    firstPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("an aborted agent-end refresh cannot suppress initialization after Git discovery", async () => {
  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const turnPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return gitResult.promise;
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return turnPrView.promise;
      return okResult(samplePr);
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const turn = new AbortController();
  const context = createMockContext({ cwd: "/repo", signal: turn.signal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    sessionStart({}, context.ctx);
    const endRefresh = agentEnd({}, context.ctx);
    await waitForMicrotasks(() => prViews === 1, "turn-owned refresh during Git discovery");
    turn.abort();
    turnPrView.reject(Object.assign(new Error("operation aborted"), { name: "AbortError" }));
    await endRefresh;
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await waitForMicrotasks(() => prViews === 2, "session-owned initial refresh after aborted turn");
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial status");
  } finally {
    turnPrView.resolve(okResult(samplePr));
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await sessionShutdown({}, context.ctx);
  }
});

test("shutdown aborts the background initial refresh and rejects its late status", async () => {
  const mock = createMockPi();
  const prView = deferred<ExecResult>();
  let initialSignal: AbortSignal | undefined;
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      initialSignal = options?.signal;
      return prView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, context.ctx), undefined);
    await waitForMicrotasks(() => initialSignal !== undefined, "background initial request starts");
    await sessionShutdown({}, context.ctx);
    assert.ok(initialSignal);
    assert.equal(initialSignal.aborted, true);
    prView.resolve(okResult(samplePr));
    await drainMicrotasks();
    assert.equal(context.statuses.get("github-pr"), undefined);
  } finally {
    prView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("session replacement aborts a delayed initial refresh and discards its late failure", async () => {
  const mock = createMockPi();
  const oldPrView = deferred<ExecResult>();
  let oldSignal: AbortSignal | undefined;
  const calls = installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr" && options?.cwd === "/repo-a") {
      oldSignal = options.signal;
      return oldPrView.promise;
    }
    return okResult(
      args[0] === "pr" ? { ...samplePr, number: 456, url: "https://github.com/o/r/pull/456" } : sampleCounts,
    );
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const oldContext = createMockContext({ cwd: "/repo-a" });
  const currentContext = createMockContext({ cwd: "/repo-b" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, oldContext.ctx), undefined);
    await waitForMicrotasks(() => oldSignal !== undefined, "old initial request starts");
    assert.equal(sessionStart({}, currentContext.ctx), undefined);
    assert.ok(oldSignal);
    assert.equal(oldSignal.aborted, true);
    await waitForMicrotasks(
      () => (currentContext.statuses.get("github-pr") ?? "").includes("#456"),
      "replacement status appears",
    );

    oldPrView.reject(new Error("spawn gh ENOENT"));
    await drainMicrotasks();
    assert.equal(oldContext.statuses.get("github-pr"), undefined);
    assert.match(currentContext.statuses.get("github-pr") ?? "", /#456/);
    assert.deepEqual(
      calls.filter((call) => call.args[0] === "pr").map((call) => call.options?.cwd),
      ["/repo-a", "/repo-b"],
    );
  } finally {
    oldPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, currentContext.ctx);
  }
});

test("a replaced session's late Git rejection cannot start an old refresh", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const oldGit = deferred<ExecResult>();
  const oldGitSettled = deferred<void>();
  let oldGitSignal: AbortSignal | undefined;
  const prCwds: string[] = [];
  installExec(mock, async (command, args, options) => {
    if (command === "git" && options?.cwd === "/repo-a") {
      oldGitSignal = options.signal;
      try {
        return await oldGit.promise;
      } finally {
        oldGitSettled.resolve();
      }
    }
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prCwds.push(options?.cwd ?? "");
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const oldContext = createMockContext({ cwd: "/repo-a" });
  const currentContext = createMockContext({ cwd: "/repo-b" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, oldContext.ctx), undefined);
    assert.ok(oldGitSignal);
    assert.equal(sessionStart({}, currentContext.ctx), undefined);
    assert.equal(oldGitSignal.aborted, true);
    await waitForMicrotasks(() => prCwds.length === 1, "replacement session refreshes");

    oldGit.reject(new Error("Git discovery failed"));
    await oldGitSettled.promise;
    await drainMicrotasks();
    vi.advanceTimersByTime(100);
    await waitForMicrotasks(() => prCwds.length === 2, "replacement session keeps polling");
    assert.deepEqual(prCwds, ["/repo-b", "/repo-b"]);
    assert.equal(oldContext.statuses.get("github-pr"), undefined);
  } finally {
    oldGit.resolve(textResult("", 128, "not a git repository"));
    await sessionShutdown({}, currentContext.ctx);
  }
});

test("agent-end refresh supersedes slow watcher initialization without a duplicate initial request", async () => {
  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const calls = installExec(mock, async (command, args) => {
    if (command === "git") return gitResult.promise;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, context.ctx), undefined);
    await agentEnd({}, context.ctx);
    assert.match(context.statuses.get("github-pr") ?? "", /#123/);
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await drainMicrotasks();
    assert.equal(calls.filter((call) => call.args[0] === "pr").length, 1);
  } finally {
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await sessionShutdown({}, context.ctx);
  }
});

test("watch installation preserves an in-flight agent-end refresh and its next poll", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const { root } = createGitHeadFixture();

  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const firstPrView = deferred<ExecResult>();
  let firstSignal: AbortSignal | undefined;
  const calls = installExec(mock, async (command, args, options) => {
    if (command === "git") return gitResult.promise;
    if (args[0] === "pr") {
      if (!firstSignal) {
        firstSignal = options?.signal;
        return firstPrView.promise;
      }
      return okResult({ ...samplePr, number: 456, url: "https://github.com/o/r/pull/456" });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  const ghCalls = () => calls.filter((call) => call.command === "gh");
  try {
    sessionStart({}, context.ctx);
    const endRefresh = agentEnd({}, context.ctx);
    await waitForMicrotasks(() => firstSignal !== undefined, "turn refresh starts during Git discovery");
    gitResult.resolve(textResult(".git/HEAD\n"));
    await drainMicrotasks();
    assert.equal(ghCalls().length, 1, "installing the watcher must not start a second PR request");
    assert.equal(firstSignal?.aborted, false, "the watcher must not cancel the active request");
    assert.equal(context.statuses.get("github-pr"), undefined);
    assert.equal(vi.getTimerCount(), 0);

    firstPrView.resolve(okResult(samplePr));
    await endRefresh;
    assert.match(context.statuses.get("github-pr") ?? "", /#123/);
    assert.deepEqual(
      ghCalls().map((call) => call.args[0]),
      ["pr", "api"],
    );
    assert.equal(vi.getTimerCount(), 1, "the first request owns the single next poll");

    vi.advanceTimersByTime(99);
    assert.equal(ghCalls().length, 2);
    vi.advanceTimersByTime(1);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#456"), "next poll status");
    assert.deepEqual(
      ghCalls().map((call) => call.args[0]),
      ["pr", "api", "pr", "api"],
    );
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "next poll is scheduled once");
  } finally {
    gitResult.resolve(textResult(".git/HEAD\n"));
    firstPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("watch installation leaves a completed agent-end refresh and its poll intact", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const { root } = createGitHeadFixture();

  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const calls = installExec(mock, async (command, args) => {
    if (command === "git") return gitResult.promise;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  const ghCalls = () => calls.filter((call) => call.command === "gh");
  try {
    sessionStart({}, context.ctx);
    await agentEnd({}, context.ctx);
    assert.match(context.statuses.get("github-pr") ?? "", /#123/);
    assert.deepEqual(
      ghCalls().map((call) => call.args[0]),
      ["pr", "api"],
    );
    assert.equal(vi.getTimerCount(), 1);

    vi.advanceTimersByTime(40);
    gitResult.resolve(textResult(".git/HEAD\n"));
    await drainMicrotasks();
    assert.deepEqual(
      ghCalls().map((call) => call.args[0]),
      ["pr", "api"],
    );
    assert.match(context.statuses.get("github-pr") ?? "", /#123/);
    assert.equal(vi.getTimerCount(), 1, "watch installation must not reset the existing poll");

    vi.advanceTimersByTime(59);
    assert.equal(ghCalls().length, 2);
    vi.advanceTimersByTime(1);
    await waitForMicrotasks(() => ghCalls().length === 4, "existing poll runs at its original deadline");
    assert.deepEqual(
      ghCalls().map((call) => call.args[0]),
      ["pr", "api", "pr", "api"],
    );
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "next poll is scheduled once");
  } finally {
    gitResult.resolve(textResult(".git/HEAD\n"));
    await sessionShutdown({}, context.ctx);
  }
});

test("a missing HEAD watcher still starts the initial refresh without a turn request", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const calls = installExec(mock, async (command, args) => {
    if (command === "git") return gitResult.promise;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    sessionStart({}, context.ctx);
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "fallback status");
    await drainMicrotasks();
    assert.deepEqual(
      calls.filter((call) => call.command === "gh").map((call) => call.args[0]),
      ["pr", "api"],
    );
    assert.equal(vi.getTimerCount(), 1);
  } finally {
    gitResult.resolve(textResult("", 128, "not a git repository"));
    await sessionShutdown({}, context.ctx);
  }
});

test("a HEAD change after watcher installation still replaces the prior refresh", async () => {
  const { root, headPath } = createGitHeadFixture();

  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  let requestCount = 0;
  const calls = installExec(mock, async (command, args) => {
    if (command === "git") return gitResult.promise;
    if (args[0] === "pr") {
      requestCount += 1;
      return okResult(
        requestCount === 1 ? samplePr : { ...samplePr, number: 456, url: "https://github.com/o/r/pull/456" },
      );
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 10_000 });
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);
  const prViews = () => calls.filter((call) => call.command === "gh" && call.args[0] === "pr").length;

  try {
    sessionStart({}, context.ctx);
    await agentEnd({}, context.ctx);
    gitResult.resolve(textResult(".git/HEAD\n"));
    await drainMicrotasks();
    assert.equal(prViews(), 1);
    writeFileSync(headPath, "ref: refs/heads/main\n");
    await waitFor(() => (context.statuses.get("github-pr") ?? "").includes("#456"), "changed HEAD status");
    assert.equal(prViews(), 2);
    assert.equal(calls.filter((call) => call.command === "gh" && call.args[0] === "api").length, 2);
  } finally {
    gitResult.resolve(textResult(".git/HEAD\n"));
    await sessionShutdown({}, context.ctx);
  }
});

test.each(["in-flight", "completed"])(
  "watch installation replaces a %s HEAD A request after HEAD becomes B",
  async (phase) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { root, headPath } = createGitHeadFixture();
    const mock = createMockPi();
    const gitResult = deferred<ExecResult>();
    const firstPr = deferred<ExecResult>();
    const calls = installExec(mock, async (command, args) => {
      if (command === "git") return gitResult.promise;
      if (args[0] === "pr") {
        return calls.filter((call) => call.args[0] === "pr").length === 1
          ? firstPr.promise
          : okResult({ ...samplePr, number: 456, url: "https://github.com/o/r/pull/456" });
      }
      return okResult(sampleCounts);
    });
    githubPr(mock.pi, { refreshIntervalMs: 10_000 });
    const context = createMockContext({ cwd: root });
    const sessionStart = mock.events.get("session_start")?.[0];
    const agentEnd = mock.events.get("agent_end")?.[0];
    const shutdown = mock.events.get("session_shutdown")?.[0];
    assert.ok(sessionStart);
    assert.ok(agentEnd);
    assert.ok(shutdown);
    const prCalls = () => calls.filter((call) => call.args[0] === "pr");

    try {
      sessionStart({}, context.ctx);
      const endRefresh = agentEnd({}, context.ctx);
      await waitForMicrotasks(() => prCalls().length === 1, "HEAD A request starts during Git discovery");
      const firstSignal = prCalls()[0]?.options?.signal;
      if (phase === "completed") {
        firstPr.resolve(okResult(samplePr));
        await endRefresh;
        assert.match(context.statuses.get("github-pr") ?? "", /#123/);
        assert.equal(vi.getTimerCount(), 1);
      }
      writeFileSync(headPath, "ref: refs/heads/main\n");
      gitResult.resolve(textResult(".git/HEAD\n"));
      await waitForMicrotasks(() => prCalls().length === 2, "HEAD B refresh starts on watcher installation");
      assert.equal(firstSignal?.aborted, phase === "in-flight", "only an active HEAD A request is aborted");
      await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#456"), "HEAD B status");
      assert.equal(prCalls().length, 2);
      assert.equal(vi.getTimerCount(), 1, "only HEAD B's poll is armed");
      if (phase === "in-flight") {
        firstPr.resolve(okResult(samplePr));
        await endRefresh;
        assert.match(context.statuses.get("github-pr") ?? "", /#456/);
        assert.equal(vi.getTimerCount(), 1);
      }
      vi.advanceTimersByTime(9_999);
      assert.equal(prCalls().length, 2);
      vi.advanceTimersByTime(1);
      await waitForMicrotasks(() => prCalls().length === 3, "HEAD B periodic poll");
      await waitForMicrotasks(() => vi.getTimerCount() === 1, "HEAD B poll is rescheduled once");
    } finally {
      gitResult.resolve(textResult(".git/HEAD\n"));
      firstPr.resolve(okResult(samplePr));
      await shutdown({}, context.ctx);
    }
  },
);

test("watch installation resolves a nested worktree gitdir when its HEAD changes during discovery", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { root } = createGitHeadFixture();
  rmSync(join(root, ".git"), { recursive: true });
  const gitDir = join(root, "linked-git");
  const headPath = join(gitDir, "HEAD");
  const cwd = join(root, "nested");
  mkdirSync(gitDir);
  mkdirSync(cwd);
  writeFileSync(join(root, ".git"), "gitdir: linked-git\n");
  writeFileSync(headPath, "ref: refs/heads/feature\n");
  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const calls = installExec(mock, async (command, args) => {
    if (command === "git") return gitResult.promise;
    if (args[0] === "pr") {
      const request = calls.filter((call) => call.args[0] === "pr").length;
      return okResult({ ...samplePr, number: request, url: `https://github.com/o/r/pull/${request}` });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 10_000 });
  const context = createMockContext({ cwd });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(shutdown);
  const prCalls = () => calls.filter((call) => call.args[0] === "pr");

  try {
    sessionStart({}, context.ctx);
    await agentEnd({}, context.ctx);
    assert.match(context.statuses.get("github-pr") ?? "", /#1/);
    writeFileSync(headPath, "ref: refs/heads/main\n");
    gitResult.resolve(textResult(`${headPath}\n`));
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#2"), "worktree HEAD B status");
    assert.equal(prCalls().length, 2);
    assert.equal(vi.getTimerCount(), 1);
  } finally {
    gitResult.resolve(textResult(`${headPath}\n`));
    await shutdown({}, context.ctx);
  }
});

test("a headless no-PR request for HEAD A is replaced when HEAD B arrives before discovery", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { root, headPath } = createGitHeadFixture();
  const mock = createMockPi();
  const gitResult = deferred<ExecResult>();
  const calls = installExec(mock, async (command, args) => {
    if (command === "git") return gitResult.promise;
    if (args[0] === "pr") return textResult("", 1, "no pull requests found");
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 10_000 });
  const context = createMockContext({ cwd: root, mode: "rpc", hasUI: false });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(shutdown);
  const prCalls = () => calls.filter((call) => call.args[0] === "pr");

  try {
    sessionStart({}, context.ctx);
    await agentEnd({}, context.ctx);
    assert.equal(prCalls().length, 1);
    assert.equal(context.statuses.get("github-pr"), undefined);
    assert.equal(vi.getTimerCount(), 1);
    writeFileSync(headPath, "ref: refs/heads/main\n");
    gitResult.resolve(textResult(".git/HEAD\n"));
    await waitForMicrotasks(() => prCalls().length === 2, "HEAD B no-PR request");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "HEAD B poll replaces HEAD A poll");
    assert.equal(context.statuses.get("github-pr"), undefined);
    vi.advanceTimersByTime(10_000);
    await waitForMicrotasks(() => prCalls().length === 3, "headless no-PR polling continues");
  } finally {
    gitResult.resolve(textResult(".git/HEAD\n"));
    await shutdown({}, context.ctx);
  }
});

test("agent-end refresh of a pending branch change cancels its debounce without a duplicate gh request", async () => {
  const realSetTimeout = globalThis.setTimeout;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { root, headPath } = createGitHeadFixture();
  const mock = createMockPi();
  const calls = installExec(mock, async (command, args) => {
    if (command === "git") return textResult(".git/HEAD\n");
    if (args[0] === "pr") {
      const request = calls.filter((call) => call.args[0] === "pr").length;
      return okResult({ ...samplePr, number: request, url: `https://github.com/o/r/pull/${request}` });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 10_000 });
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(shutdown);
  const prCalls = () => calls.filter((call) => call.args[0] === "pr");

  try {
    sessionStart({}, context.ctx);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#1"), "initial PR status");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "initial poll");
    writeFileSync(headPath, "ref: refs/heads/main\n");
    // fs.watch is delivered by the OS rather than by fake JS timers.
    for (let index = 0; index < 100 && context.statuses.get("github-pr") !== undefined; index += 1) {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
    }
    assert.equal(context.statuses.get("github-pr"), undefined, "branch event clears old PR");
    assert.equal(vi.getTimerCount(), 1, "debounced branch refresh replaced the old poll");
    await agentEnd({}, context.ctx);
    assert.match(context.statuses.get("github-pr") ?? "", /#2/);
    assert.equal(prCalls().length, 2);
    assert.equal(vi.getTimerCount(), 1, "agent_end replaces debounce with a single poll");
    vi.advanceTimersByTime(100);
    await drainMicrotasks();
    assert.equal(prCalls().length, 2, "superseded debounce cannot issue a duplicate gh call");
    vi.advanceTimersByTime(9_900);
    await waitForMicrotasks(() => prCalls().length === 3, "poll remains armed");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "next poll is rescheduled once");
  } finally {
    await shutdown({}, context.ctx);
  }
});

test.each(["statusline", "expiry timer"])(
  "a one-shot %s error clears stale PR and retries with backoff",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mock = createMockPi();
    let prViews = 0;
    const calls = installExec(mock, async (command, args) => {
      if (command === "git") return textResult("", 128, "not a git repository");
      if (args[0] === "pr") {
        prViews += 1;
        if (prViews === 1) return okResult(samplePr);
        if (prViews === 2 && fault === "expiry timer") {
          return okResult({ ...samplePr, state: "MERGED", mergedAt: new Date(Date.now()).toISOString() });
        }
        return okResult({ ...samplePr, number: 456, url: "https://github.com/o/r/pull/456" });
      }
      return okResult(sampleCounts);
    });
    githubPr(mock.pi, { refreshIntervalMs: 10_000 });
    const context = createMockContext({ cwd: "/repo" });
    const sessionStart = mock.events.get("session_start")?.[0];
    const agentEnd = mock.events.get("agent_end")?.[0];
    const shutdown = mock.events.get("session_shutdown")?.[0];
    assert.ok(sessionStart);
    assert.ok(agentEnd);
    assert.ok(shutdown);
    const originalSetStatus = context.ctx.ui.setStatus.bind(context.ctx.ui);
    const originalSetTimeout = globalThis.setTimeout;

    try {
      sessionStart({}, context.ctx);
      await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial PR status");
      await waitForMicrotasks(() => vi.getTimerCount() === 1, "initial poll");
      if (fault === "statusline") {
        let throwOnce = true;
        context.ctx.ui.setStatus = (key, value) => {
          if (throwOnce && value?.includes("#456")) {
            throwOnce = false;
            throw new Error("statusline temporarily unavailable");
          }
          originalSetStatus(key, value);
        };
      } else {
        let throwOnce = true;
        globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
          if (throwOnce && delay !== undefined && delay > 24 * 60 * 60 * 1000 - 1_000) {
            throwOnce = false;
            throw new Error("expiry timer temporarily unavailable");
          }
          return originalSetTimeout(handler, delay, ...args);
        }) as typeof setTimeout;
      }
      await agentEnd({}, context.ctx);
      assert.equal(prViews, 2);
      assert.equal(context.statuses.get("github-pr"), undefined, "failed render cannot retain stale status");
      assert.equal(vi.getTimerCount(), 1, "a bounded retry is armed");
      vi.advanceTimersByTime(999);
      assert.equal(prViews, 2, "retry cannot spin immediately");
      vi.advanceTimersByTime(1);
      await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#456"), "retry status");
      assert.equal(prViews, 3);
      assert.equal(calls.filter((call) => call.args[0] === "api").length, 3);
      assert.equal(vi.getTimerCount(), 1, "a normal poll follows recovery");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      context.ctx.ui.setStatus = originalSetStatus;
      await shutdown({}, context.ctx);
    }
  },
);

test("a polling-timer failure uses a bounded fallback instead of leaving refresh disabled", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const mock = createMockPi();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prViews += 1;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 10_000 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(shutdown);
  const originalSetTimeout = globalThis.setTimeout;
  let throwOnce = true;
  try {
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (throwOnce && delay === 10_000) {
        throwOnce = false;
        throw new Error("poll timer temporarily unavailable");
      }
      return originalSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;
    sessionStart({}, context.ctx);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial PR status");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "fallback retry is armed");
    assert.equal(prViews, 1);
    vi.advanceTimersByTime(999);
    assert.equal(prViews, 1);
    vi.advanceTimersByTime(1);
    await waitForMicrotasks(() => prViews === 2, "fallback requests PR again");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "normal polling resumes");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await shutdown({}, context.ctx);
  }
});

test("session replacement cancels a transient UI retry from the prior cwd", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const mock = createMockPi();
  const calls = installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    return okResult(args[0] === "pr" ? { ...samplePr, number: options?.cwd === "/repo-a" ? 123 : 456 } : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 10_000 });
  const oldContext = createMockContext({ cwd: "/repo-a" });
  const currentContext = createMockContext({ cwd: "/repo-b" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(shutdown);
  const originalSetStatus = oldContext.ctx.ui.setStatus.bind(oldContext.ctx.ui);
  try {
    sessionStart({}, oldContext.ctx);
    await waitForMicrotasks(() => (oldContext.statuses.get("github-pr") ?? "").includes("#123"), "old PR status");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "old poll");
    oldContext.ctx.ui.setStatus = (key, value) => {
      if (value !== undefined) throw new Error("statusline temporarily unavailable");
      originalSetStatus(key, value);
    };
    await agentEnd({}, oldContext.ctx);
    assert.equal(oldContext.statuses.get("github-pr"), undefined);
    assert.equal(vi.getTimerCount(), 1, "old retry pending");
    sessionStart({}, currentContext.ctx);
    await waitForMicrotasks(() => (currentContext.statuses.get("github-pr") ?? "").includes("#456"), "replacement PR");
    await waitForMicrotasks(() => vi.getTimerCount() === 1, "only replacement poll");
    vi.advanceTimersByTime(1_000);
    await drainMicrotasks();
    assert.deepEqual(
      calls.filter((call) => call.args[0] === "pr").map((call) => call.options?.cwd),
      ["/repo-a", "/repo-a", "/repo-b"],
      "old retry cannot run after the new session starts",
    );
  } finally {
    oldContext.ctx.ui.setStatus = originalSetStatus;
    await shutdown({}, currentContext.ctx);
  }
});

test("lifecycle refresh sets and clears only statusline output", async () => {
  const mock = createMockPi();
  const calls = installExec(mock, async (_command, args) => okResult(args[0] === "pr" ? samplePr : sampleCounts));
  githubPr(mock.pi);
  const signal = new AbortController().signal;
  const context = createMockContext({ cwd: "/repo", signal });

  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  await sessionStart({}, context.ctx);
  await waitForMicrotasks(
    () => context.statuses.has("github-pr") && context.statuses.get("github-pr") !== undefined,
    "initial PR status",
  );
  assert.equal(
    context.statuses.get("github-pr"),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );
  assert.equal(context.widgets.size, 0);
  assert.equal(context.notifications.length, 0);

  await agentEnd({}, context.ctx);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0]?.args, ["rev-parse", "--git-path", "HEAD"]);
  assert.ok(calls[0]?.options?.signal);
  assert.notEqual(calls[0]?.options?.signal, signal);
  assert.equal(calls[0]?.options?.signal?.aborted, false);
  assert.equal(
    context.statuses.get("github-pr"),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );

  await sessionShutdown({}, context.ctx);
  assert.equal(context.statuses.get("github-pr"), undefined);
  assert.equal(context.widgets.size, 0);
  assert.equal(context.notifications.length, 0);
});

test("rejects invalid periodic refresh intervals", () => {
  const mock = createMockPi();
  for (const refreshIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => githubPr(mock.pi, { refreshIntervalMs }), /refreshIntervalMs must be a positive finite number/);
  }
});

test("periodically refreshes PR state while the session remains open", async () => {
  const mock = createMockPi();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      return okResult(
        prViews === 1
          ? samplePr
          : {
              ...samplePr,
              reviewDecision: "CHANGES_REQUESTED",
              latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
            },
      );
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("approved"), "initial PR status");
    assert.match(context.statuses.get("github-pr") ?? "", /approved/);
    await waitFor(
      () => (context.statuses.get("github-pr") ?? "").includes("changes requested"),
      "periodic refresh updates the PR state",
    );
    assert.ok(prViews >= 2);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
  const viewsAtShutdown = prViews;
  await wait(50);
  assert.equal(prViews, viewsAtShutdown);
});

test("a replaced session's late lifecycle events cannot disrupt its replacement", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const prCwds: string[] = [];
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prCwds.push(options?.cwd ?? "");
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const oldContext = createMockContext({ cwd: "/repo-a" });
  const currentContext = createMockContext({ cwd: "/repo-b" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, oldContext.ctx);
    await waitForMicrotasks(() => prCwds.length === 1, "old session PR refresh");
    await sessionStart({}, currentContext.ctx);
    await waitForMicrotasks(() => prCwds.length === 2, "replacement session PR refresh");
    assert.deepEqual(prCwds, ["/repo-a", "/repo-b"]);
    await waitForMicrotasks(
      () => (currentContext.statuses.get("github-pr") ?? "").includes("#123"),
      "replacement PR status",
    );
    await drainMicrotasks();

    await sessionShutdown({}, oldContext.ctx);
    await agentEnd({}, oldContext.ctx);
    assert.deepEqual(prCwds, ["/repo-a", "/repo-b"]);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(prCwds, ["/repo-a", "/repo-b", "/repo-b"]);
  } finally {
    await sessionShutdown({}, currentContext.ctx);
  }
});

test("agent-end after session shutdown cannot restart polling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prViews += 1;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  await sessionStart({}, context.ctx);
  await waitForMicrotasks(() => prViews === 1, "initial PR refresh");
  await sessionShutdown({}, context.ctx);
  await agentEnd({}, context.ctx);
  vi.advanceTimersByTime(100);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(prViews, 1);
  assert.equal(context.statuses.get("github-pr"), undefined);
});

test("a turn aborted mid-refresh keeps the rendered status and its expiry timer", async () => {
  const mock = createMockPi();
  const mergedAt = new Date(Date.now() - 24 * 60 * 60 * 1000 + 500).toISOString();
  const abortedPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult({ ...samplePr, state: "MERGED", mergedAt });
      return abortedPrView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const controller = new AbortController();
  const context = createMockContext({
    cwd: "/repo",
    signal: controller.signal,
  });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(
      () => (context.statuses.get("github-pr") ?? "").endsWith(": merged"),
      "initial merged PR status",
    );
    assert.match(context.statuses.get("github-pr") ?? "", /: merged$/);

    const endPromise = agentEnd({}, context.ctx);
    await waitFor(() => prViews === 2, "agent-end refresh starts");
    controller.abort();
    abortedPrView.reject(new Error("The operation was aborted"));
    await endPromise;

    assert.match(context.statuses.get("github-pr") ?? "", /: merged$/);
    await waitFor(
      () => context.statuses.get("github-pr") === undefined,
      "the expiry timer survives the cancelled turn",
      2_000,
    );
  } finally {
    abortedPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("agent end on an aborted turn performs no refresh and leaves polling armed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prViews += 1;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const controller = new AbortController();
  const context = createMockContext({
    cwd: "/repo",
    signal: controller.signal,
  });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("approved"), "initial PR status");
    await drainMicrotasks();
    assert.equal(prViews, 1);

    controller.abort();
    await agentEnd({}, context.ctx);
    assert.equal(prViews, 1);
    assert.match(context.statuses.get("github-pr") ?? "", /approved/);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(prViews, 2);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
});

test("an already-aborted turn does not suppress session-owned discovery or polling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") prViews += 1;
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const controller = new AbortController();
  controller.abort();
  const context = createMockContext({
    cwd: "/repo",
    signal: controller.signal,
  });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    assert.equal(sessionStart({}, context.ctx), undefined);
    await waitForMicrotasks(() => prViews === 1, "initial session-owned refresh");
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial status");

    // The cancelled turn does not disarm the session's later polling.
    vi.advanceTimersByTime(100);
    await waitForMicrotasks(() => prViews === 2, "periodic refresh after pre-aborted turn");
  } finally {
    await sessionShutdown({}, context.ctx);
  }
});

test("a status fetched before a late abort is still rendered", async () => {
  const mock = createMockPi();
  const racingPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      return racingPrView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const controller = new AbortController();
  const context = createMockContext({
    cwd: "/repo",
    signal: controller.signal,
  });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("approved"), "initial PR status");
    assert.match(context.statuses.get("github-pr") ?? "", /approved/);

    const endPromise = agentEnd({}, context.ctx);
    await waitFor(() => prViews === 2, "agent-end refresh starts");
    controller.abort();
    racingPrView.resolve(
      okResult({
        ...samplePr,
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
      }),
    );
    await endPromise;

    assert.match(context.statuses.get("github-pr") ?? "", /changes requested/);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
});

test("a genuine gh failure racing an abort is still reported", async () => {
  const mock = createMockPi();
  const racingPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      return racingPrView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const controller = new AbortController();
  const context = createMockContext({
    cwd: "/repo",
    signal: controller.signal,
  });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("approved"), "initial PR status");
    assert.match(context.statuses.get("github-pr") ?? "", /approved/);

    const endPromise = agentEnd({}, context.ctx);
    await waitFor(() => prViews === 2, "agent-end refresh starts");
    // Ctrl+C is usually pressed *because* something is failing; the failure still counts.
    controller.abort();
    racingPrView.reject(new Error("spawn gh ENOENT"));
    await endPromise;

    assert.equal(context.statuses.get("github-pr"), "PR gh missing");
  } finally {
    racingPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("an older periodic refresh cannot overwrite a newer agent-end refresh", async () => {
  const mock = createMockPi();
  const periodicPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      if (prViews === 2) return periodicPrView.promise;
      return okResult({
        ...samplePr,
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
      });
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(() => prViews === 2, "periodic refresh starts");
    await agentEnd({}, context.ctx);
    assert.equal(prViews, 3);
    assert.match(context.statuses.get("github-pr") ?? "", /changes requested/);

    periodicPrView.resolve(okResult(samplePr));
    await wait(25);
    assert.match(context.statuses.get("github-pr") ?? "", /changes requested/);
  } finally {
    periodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("an older refresh cannot postpone a newer refresh timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const mock = createMockPi();
  const oldPeriodicPrView = deferred<ExecResult>();
  const nextPeriodicPrView = deferred<ExecResult>();
  let prViews = 0;
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      if (prViews === 2) return oldPeriodicPrView.promise;
      if (prViews === 3) {
        return okResult({
          ...samplePr,
          reviewDecision: "CHANGES_REQUESTED",
          latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
        });
      }
      return nextPeriodicPrView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 100 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const agentEnd = mock.events.get("agent_end")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(agentEnd);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("approved"), "initial PR status");
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    assert.equal(prViews, 2);

    await agentEnd({}, context.ctx);
    assert.equal(prViews, 3);
    vi.advanceTimersByTime(50);
    oldPeriodicPrView.resolve(okResult(samplePr));
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(50);
    assert.equal(prViews, 4);
  } finally {
    oldPeriodicPrView.resolve(okResult(samplePr));
    nextPeriodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("session shutdown aborts an in-flight periodic refresh", async () => {
  const mock = createMockPi();
  const periodicPrView = deferred<ExecResult>();
  let prViews = 0;
  let periodicSignal: AbortSignal | undefined;
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews === 1) return okResult(samplePr);
      periodicSignal = options?.signal;
      return periodicPrView.promise;
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(() => prViews === 2, "periodic refresh starts");
    assert.ok(periodicSignal, "periodic refresh receives a session-owned abort signal");
    assert.equal(periodicSignal.aborted, false);

    await sessionShutdown({}, context.ctx);
    assert.equal(periodicSignal.aborted, true);
    assert.equal(context.statuses.get("github-pr"), undefined);

    periodicPrView.resolve(
      okResult({
        ...samplePr,
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [{ state: "CHANGES_REQUESTED", author: { login: "carol" } }],
      }),
    );
    await wait(25);
    assert.equal(context.statuses.get("github-pr"), undefined);
    assert.equal(prViews, 2);
  } finally {
    periodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("branch changes abort an in-flight periodic refresh", async () => {
  const { root, headPath } = createGitHeadFixture();

  const periodicPrView = deferred<ExecResult>();
  const sessionSignal = new AbortController().signal;
  let periodicSignal: AbortSignal | undefined;
  let prViews = 0;
  const mock = createMockPi();
  installExec(mock, async (command, args, options) => {
    if (command === "git") return textResult(".git/HEAD\n");
    if (args[0] === "pr") {
      prViews += 1;
      if (prViews > 1) {
        periodicSignal = options?.signal;
        return periodicPrView.promise;
      }
      return okResult(samplePr);
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi, { refreshIntervalMs: 20 });
  const context = createMockContext({ cwd: root, signal: sessionSignal });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitFor(() => periodicSignal !== undefined, "periodic refresh starts");
    assert.ok(periodicSignal, "periodic refresh receives a session-owned abort signal");
    assert.equal(periodicSignal.aborted, false);

    writeFileSync(headPath, "ref: refs/heads/main\n");
    await waitFor(() => periodicSignal?.aborted === true, "branch change aborts periodic refresh");
  } finally {
    periodicPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("recent terminal pull request status clears when its 24-hour lifetime expires", async () => {
  const mock = createMockPi();
  const mergedAt = new Date(Date.now() - 24 * 60 * 60 * 1000 + 1_000).toISOString();
  const calls = installExec(mock, async (_command, args) =>
    okResult(args[0] === "pr" ? { ...samplePr, state: "MERGED", mergedAt } : sampleCounts),
  );
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(
      () => (context.statuses.get("github-pr") ?? "").endsWith(": merged"),
      "initial merged PR status",
    );
    assert.match(context.statuses.get("github-pr") ?? "", /: merged$/);
    await waitFor(() => context.statuses.get("github-pr") === undefined, "terminal pull request status expires", 2_000);
    assert.equal(calls.length, 3);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
});

test("branch changes clear stale PR status and stale refreshes cannot restore it", async () => {
  const { root, headPath } = createGitHeadFixture();

  const firstPrView = deferred<ExecResult>();
  const calls: ExecCall[] = [];
  let ghPrViews = 0;
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "git") return textResult(".git/HEAD\n");
      if (args[0] === "pr") {
        ghPrViews += 1;
        if (ghPrViews === 1) return firstPrView.promise;
        return textResult("", 1, 'no pull requests found for branch "main"');
      }
      return okResult(sampleCounts);
    },
  } satisfies { exec: ExecFunction };
  const mock = createMockPi();
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = pi.exec;
  githubPr(mock.pi);
  const context = createMockContext({ cwd: root });
  context.statuses.set("github-pr", "PR #4: checks passing, approved, no comments");

  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    const startPromise = sessionStart({}, context.ctx);
    await waitFor(() => ghPrViews === 1, "initial PR refresh starts");

    writeFileSync(headPath, "ref: refs/heads/main\n");

    await waitFor(() => context.statuses.get("github-pr") === undefined, "branch change clears stale PR status");
    await waitFor(() => ghPrViews >= 2, "branch change refreshes the current branch");

    firstPrView.resolve(okResult({ ...samplePr, number: 4, url: "https://github.com/o/r/pull/4" }));
    await startPromise;
    await wait(25);

    assert.equal(context.statuses.get("github-pr"), undefined);
  } finally {
    firstPrView.resolve(okResult(samplePr));
    await sessionShutdown({}, context.ctx);
  }
});

test("session shutdown disposes the branch watcher and pending refresh", async () => {
  const { root, headPath } = createGitHeadFixture();

  let ghPrViews = 0;
  const mock = createMockPi();
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult(".git/HEAD\n");
    if (args[0] === "pr") {
      ghPrViews += 1;
      return okResult(samplePr);
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(() => ghPrViews === 1, "initial PR refresh");
    assert.equal(ghPrViews, 1);

    writeFileSync(headPath, "ref: refs/heads/main\n");
    await sessionShutdown({}, context.ctx);
    await wait(300);

    assert.equal(ghPrViews, 1);
    assert.equal(context.statuses.get("github-pr"), undefined);
  } finally {
    await sessionShutdown({}, context.ctx);
  }
});

test("queued branch refresh does not run after session shutdown", async () => {
  const { root, headPath } = createGitHeadFixture();

  let ghPrViews = 0;
  const mock = createMockPi();
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult(".git/HEAD\n");
    if (args[0] === "pr") {
      ghPrViews += 1;
      return okResult(samplePr);
    }
    return okResult(sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: root });
  const sessionStart = mock.events.get("session_start")?.[0];
  const sessionShutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);

  const originalClearTimeout = globalThis.clearTimeout;
  try {
    await sessionStart({}, context.ctx);
    await waitForMicrotasks(() => ghPrViews === 1, "initial PR refresh");
    assert.equal(ghPrViews, 1);

    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
    writeFileSync(headPath, "ref: refs/heads/main\n");
    await waitFor(() => context.statuses.get("github-pr") === undefined, "branch change clears stale PR status");

    await sessionShutdown({}, context.ctx);
    await wait(300);
    assert.equal(ghPrViews, 1);
    assert.equal(context.statuses.get("github-pr"), undefined);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
    await sessionShutdown({}, context.ctx);
  }
});

test("branch watcher failures stay non-intrusive", async () => {
  const mock = createMockPi();
  installExec(mock, async (command, args) => {
    if (command === "git") return textResult("", 128, "not a git repository");
    return okResult(args[0] === "pr" ? samplePr : sampleCounts);
  });
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const sessionStart = mock.events.get("session_start")?.[0];
  assert.ok(sessionStart);

  await sessionStart({}, context.ctx);
  await waitForMicrotasks(() => (context.statuses.get("github-pr") ?? "").includes("#123"), "initial PR status");

  assert.equal(
    context.statuses.get("github-pr"),
    `PR \x1b]8;;${samplePr.url}\x07#123\x1b]8;;\x07: checks failing (1), approved, 5 comments`,
  );
  assert.equal(context.widgets.size, 0);
  assert.equal(context.notifications.length, 0);
});

test("ambient failures stay non-intrusive", async () => {
  const missingGh = await lifecycleStatusFor(async () => {
    throw new Error("spawn gh ENOENT");
  });
  const missingGhViaEnv = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "env: ‘gh’: No such file or directory",
    code: 127,
    killed: false,
  }));
  const missingGhViaCmd = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "'gh' is not recognized as an internal or external command",
    code: 1,
    killed: false,
  }));
  const unauthenticated = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "not logged in",
    code: 1,
    killed: false,
  }));
  const execFailure = await lifecycleStatusFor(async () => {
    throw new Error("operation aborted");
  });
  const spawnPermissionFailure = await lifecycleStatusFor(async () => {
    throw new Error("spawn gh EACCES");
  });
  const noPr = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "no pull requests found",
    code: 1,
    killed: false,
  }));
  const notFound = await lifecycleStatusFor(async () => ({
    stdout: "",
    stderr: "HTTP 404: Not Found",
    code: 1,
    killed: false,
  }));

  assert.equal(missingGh.statuses.get("github-pr"), "PR gh missing");
  assert.equal(missingGhViaEnv.statuses.get("github-pr"), "PR gh missing");
  assert.equal(missingGhViaCmd.statuses.get("github-pr"), "PR gh missing");
  assert.equal(unauthenticated.statuses.get("github-pr"), "PR gh auth");
  assert.equal(execFailure.statuses.get("github-pr"), undefined);
  assert.equal(spawnPermissionFailure.statuses.get("github-pr"), undefined);
  assert.equal(noPr.statuses.get("github-pr"), undefined);
  assert.equal(notFound.statuses.get("github-pr"), undefined);
  for (const context of [
    missingGh,
    missingGhViaEnv,
    missingGhViaCmd,
    unauthenticated,
    execFailure,
    spawnPermissionFailure,
    noPr,
    notFound,
  ]) {
    assert.equal(context.widgets.size, 0);
    assert.equal(context.notifications.length, 0);
  }
});

function createGitHeadFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-github-pr-test-"));
  // Registered per test, after its finally block has shut down the FSWatcher.
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const gitDir = join(root, ".git");
  const headPath = join(gitDir, "HEAD");
  mkdirSync(gitDir);
  writeFileSync(headPath, "ref: refs/heads/feature\n");
  return { root, headPath };
}

async function lifecycleStatusFor(exec: ExecFunction) {
  const mock = createMockPi();
  const calls = installExec(mock, exec);
  githubPr(mock.pi);
  const context = createMockContext({ cwd: "/repo" });
  const handler = mock.events.get("session_start")?.[0];
  assert.ok(handler);
  await handler({}, context.ctx);
  await waitForMicrotasks(() => calls.length >= 2, "ambient GH refresh");
  await drainMicrotasks();
  return context;
}

function installExec(mock: ReturnType<typeof createMockPi>, exec: ExecFunction): ExecCall[] {
  const calls: ExecCall[] = [];
  (mock.rawPi as typeof mock.rawPi & { exec: ExecFunction }).exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return exec(command, args, options);
  };
  return calls;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainMicrotasks(iterations = 10): Promise<void> {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}

async function waitForMicrotasks(predicate: () => boolean, message: string, iterations = 30): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail(message);
}
