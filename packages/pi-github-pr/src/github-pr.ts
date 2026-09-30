import { type FSWatcher, readFileSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "UNKNOWN";
export type CheckState = "pass" | "fail" | "pending" | "none";
export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

type JsonRecord = Record<string, unknown>;

export interface CheckSummary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

export interface ReviewSummary {
  decision: ReviewDecision;
  approvedBy: string[];
  changesRequestedBy: string[];
  commentedBy: string[];
  total: number;
}

export interface CommentSummary {
  issue: number;
  reviews: number;
  total: number;
}

export interface PullRequestStatus {
  number: number;
  url: string;
  state: PullRequestState;
  closedAt?: string;
  mergedAt?: string;
  isDraft: boolean;
  review: ReviewSummary;
  checks: CheckSummary;
  comments: CommentSummary;
}

const STATUS_KEY = "github-pr";
const GH_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;
const BRANCH_REFRESH_DEBOUNCE_MS = 100;
const PR_REFRESH_INTERVAL_MS = 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const TERMINAL_PR_LIFETIME_MS = 24 * 60 * 60 * 1000;
const GH_PR_FIELDS = [
  "number",
  "isDraft",
  "url",
  "state",
  "closedAt",
  "mergedAt",
  "reviewDecision",
  "latestReviews",
  "statusCheckRollup",
];
const GH_PR_COUNT_QUERY = `
	query PullRequestCounts($owner: String!, $name: String!, $number: Int!) {
		repository(owner: $owner, name: $name) {
			pullRequest(number: $number) {
				comments {
					totalCount
				}
				reviews {
					totalCount
				}
			}
		}
	}
`;

interface GithubPrOptions {
  refreshIntervalMs?: number;
}

export default function githubPr(pi: ExtensionAPI, options: GithubPrOptions = {}) {
  const refreshIntervalMs = options.refreshIntervalMs ?? PR_REFRESH_INTERVAL_MS;
  if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
    throw new RangeError("refreshIntervalMs must be a positive finite number");
  }
  const branchWatch: BranchWatchState = { generation: 0, request: 0, session: 0, retryCount: 0 };
  const ownsSession = (session: number, ctx: ExtensionContext) =>
    session === branchWatch.session && ctx.sessionManager === branchWatch.sessionManager && ctx.cwd === branchWatch.cwd;
  const refreshStatus = async (ctx: ExtensionContext, signal: AbortSignal, generation: number, session: number) => {
    const request = ++branchWatch.request;
    branchWatch.requestHead = readCurrentHead(ctx.cwd, branchWatch.headPath);
    // A turn that is already cancelled gets no `gh` spawn at all, and its rendered
    // status and expiry timer are left exactly as they are.
    if (signal.aborted) return request;
    let status: PullRequestStatus;
    try {
      status = await runGhPrView(pi, ctx.cwd, signal);
    } catch (error) {
      // A real gh fault racing an abort is still reported; only the abort itself is ignored.
      if (signal.aborted && isAbortError(error)) return request;
      if (ownsSession(session, ctx) && generation === branchWatch.generation && request === branchWatch.request) {
        clearExpiryTimer(branchWatch);
        renderAmbientFailure(ctx, error);
        branchWatch.lastRenderedRequest = request;
      }
      return request;
    }
    // A late abort says nothing about data already in hand. An obsolete request,
    // however, cannot repaint a replacement session or branch.
    if (ownsSession(session, ctx) && generation === branchWatch.generation && request === branchWatch.request) {
      renderStatus(ctx, status, branchWatch, generation);
      branchWatch.lastRenderedRequest = request;
    }
    return request;
  };
  const armNextRefresh = (ctx: ExtensionContext, session: number, generation: number, delay: number) => {
    if (branchWatch.refreshTimer) clearTimeout(branchWatch.refreshTimer);
    const timer = setTimeout(() => {
      if (branchWatch.refreshTimer !== timer) return;
      branchWatch.refreshTimer = undefined;
      if (!ownsSession(session, ctx) || generation !== branchWatch.generation) return;
      void refreshAndReschedule(ctx, session, generation).catch(() => undefined);
    }, delay);
    branchWatch.refreshTimer = timer;
    timer.unref?.();
  };
  const refreshAndReschedule = async (
    ctx: ExtensionContext,
    session: number,
    generation: number,
    signal?: AbortSignal,
  ) => {
    if (!ownsSession(session, ctx) || generation !== branchWatch.generation) return;
    if (branchWatch.timer) clearTimeout(branchWatch.timer);
    branchWatch.timer = undefined;
    cancelRefresh(branchWatch);
    const controller = new AbortController();
    branchWatch.refreshController = controller;
    const stopForwardingAbort = forwardAbort(signal, controller);
    branchWatch.refreshAbortCleanup = stopForwardingAbort;
    const request = branchWatch.request + 1;
    let failed = false;
    try {
      await refreshStatus(ctx, controller.signal, generation, session);
    } catch {
      failed = true;
      // A one-shot UI or timer fault must not leave an old PR on screen indefinitely.
      if (ownsSession(session, ctx) && generation === branchWatch.generation && request === branchWatch.request) {
        clearExpiryTimer(branchWatch);
        try {
          clearStatus(ctx);
        } catch {
          // The next bounded retry gets another chance to update the UI.
        }
      }
    } finally {
      stopForwardingAbort();
      if (branchWatch.refreshAbortCleanup === stopForwardingAbort) branchWatch.refreshAbortCleanup = undefined;
      if (branchWatch.refreshController === controller) branchWatch.refreshController = undefined;
      // Even if setStatus or the expiry timer throws, the current request owns a
      // retry. A replaced request/session/branch must not rearm its old poll.
      if (ownsSession(session, ctx) && generation === branchWatch.generation && request === branchWatch.request) {
        branchWatch.retryCount = failed ? Math.min(branchWatch.retryCount + 1, 6) : 0;
        const retryDelay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (branchWatch.retryCount - 1));
        try {
          armNextRefresh(ctx, session, generation, failed ? retryDelay : refreshIntervalMs);
        } catch {
          // A one-shot polling-timer failure gets a bounded fallback, not a tight loop.
          branchWatch.retryCount = Math.max(branchWatch.retryCount, 1);
          try {
            armNextRefresh(ctx, session, generation, RETRY_BASE_MS);
          } catch {
            // No timer API is available; a later lifecycle event can retry.
          }
        }
      }
    }
  };
  const scheduleBranchRefresh = (ctx: ExtensionContext, session: number) => {
    cancelInitialization(branchWatch);
    branchWatch.generation += 1;
    const generation = branchWatch.generation;
    branchWatch.retryCount = 0;
    cancelRefresh(branchWatch);
    clearExpiryTimer(branchWatch);
    try {
      clearStatus(ctx);
    } catch {
      // The debounced refresh can still repair a transient statusline failure.
    }
    if (branchWatch.timer) clearTimeout(branchWatch.timer);
    try {
      const timer = setTimeout(() => {
        if (branchWatch.timer !== timer) return;
        branchWatch.timer = undefined;
        if (!ownsSession(session, ctx) || generation !== branchWatch.generation) return;
        void refreshAndReschedule(ctx, session, generation).catch(() => undefined);
      }, BRANCH_REFRESH_DEBOUNCE_MS);
      branchWatch.timer = timer;
      timer.unref?.();
    } catch {
      // A broken debounce timer must not strand the branch after its old poll was cancelled.
      void refreshAndReschedule(ctx, session, generation).catch(() => undefined);
    }
  };
  const closeBranchWatcher = () => {
    cancelInitialization(branchWatch);
    if (branchWatch.timer) clearTimeout(branchWatch.timer);
    branchWatch.timer = undefined;
    cancelRefresh(branchWatch);
    clearExpiryTimer(branchWatch);
    branchWatch.watcher?.close();
    branchWatch.watcher = undefined;
    branchWatch.headPath = undefined;
    branchWatch.requestHead = undefined;
    branchWatch.retryCount = 0;
  };
  const initializeSession = async (
    ctx: ExtensionContext,
    session: number,
    generation: number,
    controller: AbortController,
  ) => {
    const requestAtStart = branchWatch.request;
    const discovered = await createBranchWatcher(pi, ctx.cwd, controller.signal, (headPath) => {
      if (!ownsSession(session, ctx)) return;
      // HEAD notifications can arrive after agent_end already refreshed that HEAD.
      const currentHead = readCurrentHead(ctx.cwd, headPath);
      if (currentHead !== undefined && currentHead === branchWatch.requestHead) return;
      scheduleBranchRefresh(ctx, session);
    });
    if (
      controller.signal.aborted ||
      branchWatch.initializationController !== controller ||
      !ownsSession(session, ctx) ||
      generation !== branchWatch.generation
    ) {
      discovered?.watcher.close();
      return;
    }
    branchWatch.watcher = discovered?.watcher;
    branchWatch.headPath = discovered?.headPath;
    // An agent_end request may have fetched HEAD A while Git discovery was pending.
    // If HEAD is now B, neither its result nor its timer can stand in for B.
    if (
      discovered &&
      requestAtStart !== branchWatch.request &&
      (branchWatch.requestHead === undefined ||
        readCurrentHead(ctx.cwd, discovered.headPath) !== branchWatch.requestHead)
    ) {
      branchWatch.generation += 1;
      cancelRefresh(branchWatch);
      clearExpiryTimer(branchWatch);
      try {
        clearStatus(ctx);
      } catch {
        // The replacement refresh retries transient UI failures.
      }
      void refreshAndReschedule(ctx, session, branchWatch.generation).catch(() => undefined);
      return;
    }
    // Reuse a same-HEAD request, whether still active or completed with a poll.
    // A cancelled request can own a timer without having rendered a status.
    const inFlight = branchWatch.refreshController && !branchWatch.refreshController.signal.aborted;
    const completed = branchWatch.lastRenderedRequest === branchWatch.request && branchWatch.refreshTimer;
    if (requestAtStart === branchWatch.request || (!inFlight && !completed)) {
      void refreshAndReschedule(ctx, session, generation).catch(() => undefined);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    closeBranchWatcher();
    branchWatch.generation += 1;
    branchWatch.session += 1;
    branchWatch.sessionManager = ctx.sessionManager;
    branchWatch.cwd = ctx.cwd;
    try {
      clearStatus(ctx);
    } catch {
      // A transient statusline failure must not prevent Git discovery or the first refresh.
    }
    const session = branchWatch.session;
    const generation = branchWatch.generation;
    // Git discovery and the first refresh outlive a turn; only session/branch changes cancel them.
    const controller = new AbortController();
    branchWatch.initializationController = controller;
    void initializeSession(ctx, session, generation, controller)
      .catch(() => undefined)
      .finally(() => {
        if (branchWatch.initializationController === controller) branchWatch.initializationController = undefined;
      });
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.sessionManager !== branchWatch.sessionManager || ctx.signal?.aborted) return;
    await refreshAndReschedule(ctx, branchWatch.session, branchWatch.generation, ctx.signal);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.sessionManager !== branchWatch.sessionManager) return;
    branchWatch.sessionManager = undefined;
    branchWatch.cwd = undefined;
    branchWatch.generation += 1;
    branchWatch.session += 1;
    closeBranchWatcher();
    clearStatus(ctx);
  });
}

interface BranchWatchState {
  generation: number;
  request: number;
  lastRenderedRequest?: number;
  session: number;
  sessionManager?: ExtensionContext["sessionManager"];
  cwd?: string;
  initializationController?: AbortController;
  watcher?: FSWatcher;
  headPath?: string;
  requestHead?: string;
  retryCount: number;
  timer?: ReturnType<typeof setTimeout>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshController?: AbortController;
  refreshAbortCleanup?: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

function readCurrentHead(cwd: string, knownPath?: string): string | undefined {
  if (knownPath) {
    try {
      return readFileSync(knownPath, "utf8").trim();
    } catch {
      return undefined;
    }
  }
  // Git discovery may still be pending when agent_end starts its gh request.
  // Resolve a normal .git directory or worktree gitdir pointer without waiting
  // for that separate process, including when Pi's cwd is below the repo root.
  for (let directory = cwd; ; directory = dirname(directory)) {
    const gitEntry = join(directory, ".git");
    try {
      return readFileSync(join(gitEntry, "HEAD"), "utf8").trim();
    } catch {
      try {
        const pointer = /^gitdir: (.+)\s*$/m.exec(readFileSync(gitEntry, "utf8"));
        if (pointer) return readFileSync(resolve(directory, pointer[1].trim(), "HEAD"), "utf8").trim();
      } catch {
        // No .git entry here; continue toward the worktree root.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
  }
}

async function createBranchWatcher(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal: AbortSignal | undefined,
  onChange: (headPath: string) => void,
): Promise<{ watcher: FSWatcher; headPath: string } | undefined> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--git-path", "HEAD"], {
      cwd,
      signal,
      timeout: GIT_TIMEOUT_MS,
    });
    if (signal?.aborted || result.killed || result.code !== 0) return undefined;

    const gitHead = result.stdout.trim();
    if (!gitHead) return undefined;

    const headPath = resolve(cwd, gitHead);
    const headFileName = basename(headPath);
    const watcher = watch(dirname(headPath), { persistent: false }, (_event, fileName) => {
      if (!fileName || fileName.toString() === headFileName) onChange(headPath);
    });
    watcher.on("error", () => watcher.close());
    return { watcher, headPath };
  } catch {
    return undefined;
  }
}

export async function runGhPrView(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<PullRequestStatus> {
  const invocation = ghPrViewInvocation();
  const result = await execGh(pi, invocation.command, invocation.args, cwd, signal, "gh pr view");
  if (result.killed) throw new Error("gh pr view timed out or was cancelled.");
  if (result.code !== 0) throw new Error(formatGhFailure("gh pr view", result));

  let pr: JsonRecord;
  try {
    pr = objectRecord(JSON.parse(result.stdout));
  } catch (error) {
    throw new Error(`Failed to parse gh pr view output: ${formatError(error)}`);
  }

  const counts = await runGhPrCountQuery(pi, cwd, pr, signal);
  return normalizeGhPrView({ ...pr, ...counts });
}

export function normalizeGhPrView(value: unknown): PullRequestStatus {
  const pr = objectRecord(value);
  const reviews = arrayValue(pr.reviews);
  const latestReviews = arrayValue(pr.latestReviews);
  const comments = summarizeComments(pr.comments, countValue(pr.reviews));

  return {
    number: requiredNumber(pr.number, "number"),
    url: optionalString(pr.url) ?? "",
    state: pullRequestState(pr.state),
    closedAt: optionalString(pr.closedAt),
    mergedAt: optionalString(pr.mergedAt),
    isDraft: pr.isDraft === true,
    review: summarizeReviews(pr.reviewDecision, latestReviews.length > 0 ? latestReviews : reviews),
    checks: summarizeChecks(pr.statusCheckRollup),
    comments,
  };
}

function summarizeChecks(value: unknown): CheckSummary {
  const checks = arrayValue(value);
  const summary: CheckSummary = { passed: 0, failed: 0, pending: 0, total: checks.length };

  for (const check of checks) {
    const state = checkState(check);
    if (state === "pass") summary.passed += 1;
    else if (state === "fail") summary.failed += 1;
    else summary.pending += 1;
  }

  return summary;
}

function checkState(value: unknown): Exclude<CheckState, "none"> {
  const check = objectRecord(value);
  const state = optionalString(check.state)?.toUpperCase();
  const status = optionalString(check.status)?.toUpperCase();
  const conclusion = optionalString(check.conclusion)?.toUpperCase();

  if (state === "SUCCESS") return "pass";
  if (state === "FAILURE" || state === "ERROR") return "fail";
  if (state === "PENDING" || state === "EXPECTED") return "pending";

  if (status && status !== "COMPLETED") return "pending";
  if (conclusion === "SUCCESS" || conclusion === "SKIPPED" || conclusion === "NEUTRAL") {
    return "pass";
  }
  if (
    conclusion === "FAILURE" ||
    conclusion === "CANCELLED" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "ACTION_REQUIRED" ||
    conclusion === "STARTUP_FAILURE"
  ) {
    return "fail";
  }

  return "pending";
}

function summarizeReviews(decisionValue: unknown, reviewValues: unknown[]): ReviewSummary {
  const latestByAuthor = new Map<string, JsonRecord>();
  let anonymousIndex = 0;

  for (const reviewValue of reviewValues) {
    const review = objectRecord(reviewValue);
    const author = authorLogin(review) ?? `review-${anonymousIndex++}`;
    latestByAuthor.set(author, review);
  }

  const summary: ReviewSummary = {
    decision: reviewDecision(decisionValue),
    approvedBy: [],
    changesRequestedBy: [],
    commentedBy: [],
    total: reviewValues.length,
  };

  for (const [author, review] of latestByAuthor) {
    const state = optionalString(review.state)?.toUpperCase();
    if (state === "APPROVED") summary.approvedBy.push(author);
    else if (state === "CHANGES_REQUESTED") summary.changesRequestedBy.push(author);
    else if (state === "COMMENTED") summary.commentedBy.push(author);
  }

  return summary;
}

function summarizeComments(commentsValue: unknown, reviewCount: number): CommentSummary {
  const issue = countValue(commentsValue);
  return { issue, reviews: reviewCount, total: issue + reviewCount };
}

function countValue(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const object = objectRecord(value);
  const totalCount = object.totalCount;
  if (typeof totalCount === "number") return totalCount;
  const nodes = object.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

function reviewDecision(value: unknown): ReviewDecision {
  if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
    return value;
  }
  return "UNKNOWN";
}

function pullRequestState(value: unknown): PullRequestState {
  if (value === "OPEN" || value === "CLOSED" || value === "MERGED") return value;
  throw new Error("Missing valid PR state");
}

function authorLogin(review: JsonRecord): string | undefined {
  const author = objectRecord(review.author);
  return optionalString(author.login);
}

function checkOverall(checks: CheckSummary): CheckState {
  if (checks.total === 0) return "none";
  if (checks.failed > 0) return "fail";
  if (checks.pending > 0) return "pending";
  return "pass";
}

export function formatCompactStatus(status: PullRequestStatus): string {
  if (status.state === "MERGED") return `PR #${status.number}: merged`;
  if (status.state === "CLOSED") return `PR #${status.number}: closed`;
  return `PR #${status.number}: ${[
    formatCheckCompact(status.checks),
    formatReviewCompact(status),
    formatCommentCompact(status.comments),
  ].join(", ")}`;
}

function formatCheckCompact(checks: CheckSummary): string {
  switch (checkOverall(checks)) {
    case "pass":
      return "checks passing";
    case "fail":
      return `checks failing (${checks.failed})`;
    case "pending":
      return `checks pending (${checks.pending})`;
    case "none":
      return "no checks";
  }
}

function formatCommentCompact(comments: CommentSummary): string {
  const count = comments.total;
  if (count === 0) return "no comments";
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

function formatReviewCompact(status: PullRequestStatus): string {
  if (status.isDraft) return "draft";
  const review = status.review;
  switch (review.decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes requested";
    case "REVIEW_REQUIRED":
      return "review required";
    case "UNKNOWN":
      return review.commentedBy.length > 0 ? "commented" : "review ?";
  }
}

function renderStatus(
  ctx: ExtensionContext,
  status: PullRequestStatus,
  branchWatch: BranchWatchState,
  generation: number,
) {
  clearExpiryTimer(branchWatch);
  const now = Date.now();
  const expiresAt = pullRequestExpiresAt(status);
  if (!isPullRequestVisible(status, now)) {
    clearStatus(ctx);
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, formatLinkedStatus(status));
  if (expiresAt === undefined) return;
  branchWatch.expiryTimer = setTimeout(() => {
    branchWatch.expiryTimer = undefined;
    if (generation === branchWatch.generation) clearStatus(ctx);
  }, expiresAt - now);
}

export function isPullRequestVisible(status: PullRequestStatus, now = Date.now()): boolean {
  if (status.state === "OPEN") return true;
  const expiresAt = pullRequestExpiresAt(status);
  return expiresAt !== undefined && now < expiresAt;
}

function pullRequestExpiresAt(status: PullRequestStatus): number | undefined {
  if (status.state === "OPEN") return undefined;
  const timestamp = status.state === "MERGED" ? status.mergedAt : status.closedAt;
  if (!timestamp) return undefined;
  const terminalAt = Date.parse(timestamp);
  return Number.isFinite(terminalAt) ? terminalAt + TERMINAL_PR_LIFETIME_MS : undefined;
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener("abort", abort);
}

function cancelInitialization(branchWatch: BranchWatchState) {
  branchWatch.initializationController?.abort();
  branchWatch.initializationController = undefined;
}

function cancelRefresh(branchWatch: BranchWatchState) {
  if (branchWatch.refreshTimer) clearTimeout(branchWatch.refreshTimer);
  branchWatch.refreshTimer = undefined;
  branchWatch.refreshController?.abort();
  branchWatch.refreshController = undefined;
  branchWatch.refreshAbortCleanup?.();
  branchWatch.refreshAbortCleanup = undefined;
}

function clearExpiryTimer(branchWatch: BranchWatchState) {
  if (branchWatch.expiryTimer) clearTimeout(branchWatch.expiryTimer);
  branchWatch.expiryTimer = undefined;
}

export function formatLinkedStatus(status: PullRequestStatus): string {
  const text = formatCompactStatus(status);
  if (!status.url) return text;
  const label = `#${status.number}`;
  return text.replace(label, osc8Link(status.url, label));
}

function stripTerminalControlChars(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f) sanitized += character;
  }
  return sanitized;
}

function osc8Link(url: string, text: string): string {
  const safeText = stripTerminalControlChars(text);

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return safeText;

    const safeUrl = stripTerminalControlChars(parsed.toString());
    return `\x1b]8;;${safeUrl}\x07${safeText}\x1b]8;;\x07`;
  } catch {
    return safeText;
  }
}

function clearStatus(ctx: ExtensionContext) {
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function renderAmbientFailure(ctx: ExtensionContext, error: unknown) {
  const message = formatError(error);
  const lower = message.toLowerCase();

  if (isGhExecutableMissingMessage(lower)) {
    ctx.ui.setStatus(STATUS_KEY, "PR gh missing");
    return;
  }
  if (/not authenticated|auth login|authentication/.test(lower)) {
    ctx.ui.setStatus(STATUS_KEY, "PR gh auth");
    return;
  }

  clearStatus(ctx);
}

async function runGhPrCountQuery(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  pr: JsonRecord,
  signal?: AbortSignal,
): Promise<Pick<JsonRecord, "comments" | "reviews">> {
  const { host, owner, name, number } = parsePrCoordinates(pr);
  const result = await execGh(
    pi,
    "gh",
    [
      "api",
      "graphql",
      "--hostname",
      host,
      "-f",
      `query=${GH_PR_COUNT_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ],
    cwd,
    signal,
    "gh api graphql",
  );

  if (result.killed) throw new Error("gh api graphql timed out or was cancelled.");
  if (result.code !== 0) throw new Error(formatGhFailure("gh api graphql", result));

  try {
    const payload = objectRecord(JSON.parse(result.stdout));
    const data = objectRecord(payload.data);
    const repository = objectRecord(data.repository);
    const pullRequest = objectRecord(repository.pullRequest);
    return { comments: pullRequest.comments, reviews: pullRequest.reviews };
  } catch (error) {
    throw new Error(`Failed to parse gh api graphql output: ${formatError(error)}`);
  }
}

export function ghPrViewInvocation(
  ghHost = process.env.GH_HOST,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): { command: string; args: string[] } {
  const args = ["pr", "view", "--json", GH_PR_FIELDS.join(",")];
  if (!ghHost) return { command: "gh", args };
  if (platform === "win32") {
    return {
      command: comSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `set "GH_HOST=" && gh ${args.join(" ")}`],
    };
  }
  return { command: "env", args: ["-u", "GH_HOST", "gh", ...args] };
}

async function execGh(
  pi: Pick<ExtensionAPI, "exec">,
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  command: string,
): Promise<ExecResult> {
  try {
    return await pi.exec(executable, args, { cwd, signal, timeout: GH_TIMEOUT_MS });
  } catch (error) {
    const message = formatError(error);
    if (isGhExecutableMissingMessage(message.toLowerCase())) {
      throw new Error(`GitHub CLI not found. Install gh and run: gh auth login. ${message}`);
    }
    throw new Error(`${command} could not start: ${message}`);
  }
}

function formatGhFailure(command: string, result: ExecResult): string {
  const output = (result.stderr || result.stdout).trim();
  const lower = output.toLowerCase();
  if (isGhExecutableMissingMessage(lower)) {
    return "GitHub CLI not found. Install gh and run: gh auth login.";
  }
  if (/not logged in|authentication|auth login|gh auth/.test(lower)) {
    return `GitHub CLI is not authenticated. Run: gh auth login. ${output}`;
  }
  if (/no pull requests|could not resolve|not a github repository/.test(lower)) {
    return `No GitHub pull request found. ${output}`;
  }
  return `${command} failed (${result.code}): ${output || "no output"}`;
}

function isGhExecutableMissingMessage(lowerMessage: string): boolean {
  return (
    /\bgithub cli (?:not available|not found)\b/.test(lowerMessage) ||
    /\b(?:gh|gh\.exe)\b.*\benoent\b|\benoent\b.*\b(?:gh|gh\.exe)\b/.test(lowerMessage) ||
    /\b(?:gh|gh\.exe): (?:command )?not found\b/.test(lowerMessage) ||
    /\bcommand not found: (?:gh|gh\.exe)\b/.test(lowerMessage) ||
    /\benv:\s+['"‘’]?(?:gh|gh\.exe)['"‘’]?: no such file or directory\b/.test(lowerMessage) ||
    /['"‘’]?(?:gh|gh\.exe)['"‘’]? is not recognized as an internal or external command\b/.test(lowerMessage) ||
    /\b(?:gh|gh\.exe): no such file or directory\b/.test(lowerMessage)
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `pi.exec` surfaces a cancelled child through several spellings — a DOMException-style
 * AbortError, `The operation was aborted`, or this extension's own "timed out or was
 * cancelled" wrapper — so match the shape rather than one library's exact error.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return /\baborted?\b|\bcancell?ed\b/i.test(formatError(error));
}

function parsePrCoordinates(pr: JsonRecord): {
  host: string;
  owner: string;
  name: string;
  number: number;
} {
  const number = requiredNumber(pr.number, "number");
  const url = optionalString(pr.url);
  if (!url) throw new Error("Missing PR url");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`Invalid PR url: ${formatError(error)}`);
  }

  const match = /^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(parsed.pathname);
  if (!match) throw new Error(`Unsupported PR url: ${url}`);

  return { host: parsed.host, owner: match[1], name: match[2], number };
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectRecord(value);
  return Array.isArray(object.nodes) ? object.nodes : [];
}

function objectRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Missing numeric PR ${name}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
