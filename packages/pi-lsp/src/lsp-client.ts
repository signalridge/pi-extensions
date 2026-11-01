import { type ChildProcessWithoutNullStreams, type SpawnOptions, spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { environmentValue, mergeEnvironment, resolveCommandPath } from "./command.js";
import { documentKey } from "./document-key.js";
import { directoryUri } from "./files.js";
import { positionAt } from "./text-edits.js";
import type { CodeAction, JsonRpcMessage, LspDiagnostic, LspServerAdapter, ServerCommand } from "./types.js";

export function resolveSpawnCommand(
  command: ServerCommand,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): ServerCommand & Pick<SpawnOptions, "windowsVerbatimArguments"> {
  if (platform !== "win32" || !/\.(?:bat|cmd)$/i.test(command.command)) return command;
  const shellCommand = [escapeCmd(command.command), ...command.args.map(quoteCmdArgument)].join(" ");
  return {
    command: comSpec?.trim() || "cmd.exe",
    // /s removes the outer quotes. Node must not quote this command line again.
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

function escapeCmd(value: string) {
  return value.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
}

function quoteCmdArgument(value: string) {
  // Quote pairs encode a literal quote without unbalancing cmd's quote state
  // when a batch launcher forwards %*. Double preceding and trailing backslashes
  // for Windows argv parsing, then escape the initial cmd parsing pass once.
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? backslashes * 2 : backslashes);
    quoted += character === '"' ? '""' : character;
    backslashes = 0;
  }
  return escapeCmd(`${quoted}${"\\".repeat(backslashes * 2)}"`);
}

// Every CodeActionKind in LSP 3.17. Servers such as Biome advertise
// resolveProvider only to clients that accept literal CodeAction objects.
const CODE_ACTION_KINDS = [
  "",
  "quickfix",
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.rewrite",
  "source",
  "source.organizeImports",
  "source.fixAll",
];
// SymbolKind 1 (File) through 26 (TypeParameter); servers otherwise assume 1-18 only.
const SYMBOL_KINDS = Array.from({ length: 26 }, (_, index) => index + 1);

// Quiet period (ms) after each publish before treating push diagnostics as settled.
const PUBLISHED_DIAGNOSTICS_SETTLE_MS = 800;
const STDERR_TAIL_BYTES = 16 * 1024;
const TERMINATION_GRACE_MS = 500;
const CLOSE_CONFIRMATION_MS = 500;

interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  // Cleanup can fail before close; a settled promise does not release ownership.
  done: Promise<Error | undefined>;
  completeCleanup: (error?: Error) => void;
  closed: Promise<void>;
  confirmClose: () => void;
  signalError?: string;
  terminating: boolean;
  exited: boolean;
  escalation?: NodeJS.Timeout;
  confirmation?: NodeJS.Timeout;
}

export class LspClient {
  #process?: OwnedProcess;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (message: JsonRpcMessage) => void;
      reject: (reason: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  #publishedDiagnostics = new Map<string, { version: number; diagnostics: LspDiagnostic[] }>();
  #diagnosticWaiters = new Map<
    string,
    Set<{
      onPublish: (publication: { version: number; diagnostics: LspDiagnostic[] }) => void;
      reject: (reason: unknown) => void;
      dispose: () => void;
    }>
  >();
  #stderr = Buffer.alloc(STDERR_TAIL_BYTES);
  #stderrSize = 0;
  #stderrEnd = 0;
  #serverCapabilities: Record<string, unknown> = {};
  #adapter: LspServerAdapter;
  #command: ServerCommand;
  #cwd: string;
  #timeoutMs: number;
  #environment?: NodeJS.ProcessEnv;

  constructor(
    adapter: LspServerAdapter,
    command: ServerCommand,
    cwd: string,
    timeoutMs: number,
    environment?: NodeJS.ProcessEnv,
  ) {
    this.#adapter = adapter;
    this.#command = command;
    this.#cwd = cwd;
    this.#timeoutMs = timeoutMs;
    this.#environment = environment;
  }

  async start() {
    // A close is synchronous, but a restart must wait until the old child is reaped.
    if (this.#process?.terminating) {
      const error = await this.#process.done;
      if (error) throw error;
    }
    if (this.#process) throw new Error(`${this.#adapter.name} LSP client is already started`);
    const environment = this.#environment ?? mergeEnvironment(this.#adapter.env);
    const commandPath = resolveCommandPath(
      this.#command.command,
      this.#cwd,
      process.platform,
      environmentValue(environment, "PATH", process.platform) ?? "",
    );
    if (!commandPath) {
      throw new Error(
        `${this.#adapter.name} LSP command not found: ${this.#command.command}. ${this.#adapter.missingCommandHint}`,
      );
    }

    this.#stderrSize = 0;
    this.#stderrEnd = 0;
    this.#buffer = Buffer.alloc(0);
    this.#publishedDiagnostics.clear();
    this.#serverCapabilities = {};
    this.#nextId = 1;
    const spawnCommand = resolveSpawnCommand(
      { ...this.#command, command: commandPath },
      process.platform,
      environmentValue(environment, "ComSpec", process.platform),
    );
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: this.#cwd,
      env: environment,
      stdio: "pipe",
      windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
    });
    let completeCleanup!: (error?: Error) => void;
    const done = new Promise<Error | undefined>((resolve) => {
      completeCleanup = resolve;
    });
    let confirmClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      confirmClose = resolve;
    });
    const owned: OwnedProcess = {
      child,
      done,
      completeCleanup,
      closed,
      confirmClose,
      terminating: false,
      exited: false,
    };
    this.#process = owned;
    const finish = () => {
      owned.exited = true;
      clearTimeout(owned.escalation);
      clearTimeout(owned.confirmation);
      owned.escalation = undefined;
      owned.confirmation = undefined;
      this.#destroyStreams(child);
      if (this.#process === owned) this.#process = undefined;
      owned.completeCleanup();
      owned.confirmClose();
    };
    child.stdout.on("data", (chunk) => {
      if (this.#process !== owned || owned.terminating) return;
      try {
        this.#onData(chunk);
      } catch (error) {
        this.#fail(
          `${this.#adapter.name} LSP server sent invalid JSON-RPC data: ${formatErrorMessage(error)}.${this.#formatStderr()}`,
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.#process !== owned || owned.terminating) return;
      const tail = chunk.subarray(-STDERR_TAIL_BYTES);
      if (tail.length === STDERR_TAIL_BYTES) {
        tail.copy(this.#stderr);
        this.#stderrSize = STDERR_TAIL_BYTES;
        this.#stderrEnd = 0;
        return;
      }
      const first = Math.min(tail.length, STDERR_TAIL_BYTES - this.#stderrEnd);
      tail.copy(this.#stderr, this.#stderrEnd, 0, first);
      if (first < tail.length) tail.copy(this.#stderr, 0, first);
      this.#stderrEnd = (this.#stderrEnd + tail.length) % STDERR_TAIL_BYTES;
      this.#stderrSize = Math.min(STDERR_TAIL_BYTES, this.#stderrSize + tail.length);
    });
    child.stdin.on("error", (error) => {
      if (this.#process !== owned || owned.terminating) return;
      this.#fail(`${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.${this.#formatStderr()}`);
    });
    child.once("exit", (code, signal) => {
      if (this.#process === owned) {
        const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        this.#rejectPending(
          (id) => `${this.#adapter.name} LSP server exited before response ${id} (${reason}).${this.#formatStderr()}`,
        );
      }
      owned.exited = true;
      owned.terminating = true;
      clearTimeout(owned.escalation);
      owned.escalation = undefined;
      this.#destroyStreams(child);
    });
    // close follows exit (or a failed spawn) once the owned pipes are closed.
    child.once("close", finish);
    child.on("error", (error) => {
      if (owned.terminating) {
        // kill can emit an error synchronously and return false (e.g. EPERM).
        owned.signalError = formatErrorMessage(error);
        return;
      }
      if (this.#process === owned) {
        this.#fail(`${this.#adapter.name} LSP process failed: ${error.message}.${this.#formatStderr()}`);
      }
      // A failed spawn has no PID and will not emit exit; close still settles done.
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        const message = `${this.#adapter.name} LSP process failed to start: ${error.message}.${this.#formatStderr()}`;
        reject(new Error(message));
      });
    });
  }

  async initialize(root: string) {
    const rootUri = directoryUri(root);
    const workspaceFolders = [{ uri: rootUri, name: path.basename(root) || "workspace" }];
    const response = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders,
      initializationOptions: this.#adapter.initialization ?? {},
      capabilities: {
        textDocument: {
          // This spawn-per-call client can't track dynamic registrations, so
          // capabilities must be advertised statically.
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: { codeActionKind: { valueSet: CODE_ACTION_KINDS } },
            resolveSupport: { properties: ["edit"] },
          },
          definition: { dynamicRegistration: false, linkSupport: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: SYMBOL_KINDS },
          },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: {},
          references: { dynamicRegistration: false },
          rename: { dynamicRegistration: false, prepareSupport: false },
          synchronization: { didSave: true },
        },
        workspace: {
          configuration: true,
          symbol: { dynamicRegistration: false, symbolKind: { valueSet: SYMBOL_KINDS } },
          // No resourceOperations: file creates, renames and deletes are not applied.
          workspaceEdit: { documentChanges: true },
          workspaceFolders: true,
        },
      },
    });
    this.#serverCapabilities =
      (response.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.#adapter.initialization) {
      this.notify("workspace/didChangeConfiguration", { settings: this.#adapter.initialization });
    }
  }

  /** Whether `initialize` advertised a provider, for example `definitionProvider`. */
  hasCapability(provider: string) {
    const value = this.#serverCapabilities[provider];
    return value !== undefined && value !== null && value !== false;
  }

  /** Send one request and return its unvalidated result; callers validate the shape. */
  async requestResult(method: string, params: unknown): Promise<unknown> {
    return (await this.request(method, params)).result;
  }

  didOpen(uri: string, text: string, languageId: string) {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didClose(uri: string) {
    if (!this.#process || this.#process.terminating) return false;
    this.notify("textDocument/didClose", {
      textDocument: { uri },
    });
    return true;
  }

  async diagnostics(uri: string) {
    if (!this.#process || this.#process.terminating) {
      throw new Error(`${this.#adapter.name} LSP server is not running.`);
    }
    // Only pull if the server advertised it; otherwise use push diagnostics.
    if (!this.#serverCapabilities.diagnosticProvider) {
      return this.#waitForPublishedDiagnostics(
        uri,
        this.#adapter.pushDiagnosticsGraceMs
          ? {
              afterVersion: 0,
              diagnostics: [],
              waitMs: this.#adapter.pushDiagnosticsGraceMs,
            }
          : undefined,
      );
    }
    const published = this.#publishedDiagnostics.get(documentKey(uri));
    // Ignore a provisional empty publish, but preserve diagnostics that arrived before the pull.
    const afterVersion = published?.diagnostics.length ? published.version - 1 : (published?.version ?? 0);
    const response = await this.request("textDocument/diagnostic", {
      textDocument: { uri },
    });
    const result = response.result as { items?: LspDiagnostic[] } | undefined;
    const diagnostics = result?.items ?? [];
    if (diagnostics.length > 0 || !this.#adapter.pullDiagnosticsGraceMs) return diagnostics;
    return this.#waitForPublishedDiagnostics(uri, {
      afterVersion,
      diagnostics,
      waitMs: this.#adapter.pullDiagnosticsGraceMs,
    });
  }

  async codeActions(uri: string, text: string, diagnostics: LspDiagnostic[], kind: string) {
    const response = await this.request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: positionAt(text, text.length) },
      context: { diagnostics, only: [kind] },
    });
    return (response.result as CodeAction[] | null | undefined) ?? [];
  }

  async resolveActions(actions: CodeAction[]) {
    // Only resolve when the server advertised resolveProvider; otherwise use the
    // action as-is. Any error from an advertised resolve is real and propagates.
    const codeActionProvider = this.#serverCapabilities.codeActionProvider;
    const canResolve =
      typeof codeActionProvider === "object" &&
      codeActionProvider !== null &&
      (codeActionProvider as { resolveProvider?: boolean }).resolveProvider === true;

    const resolvedActions: CodeAction[] = [];
    for (const action of actions) {
      if (action.edit || !canResolve) {
        resolvedActions.push(action);
        continue;
      }

      const response = await this.request("codeAction/resolve", action);
      resolvedActions.push((response.result as CodeAction | undefined) ?? action);
    }

    return resolvedActions;
  }

  async shutdown() {
    const owned = this.#process;
    if (!owned) return;

    try {
      if (!owned.terminating) {
        await this.request("shutdown", null);
        if (this.#process === owned && !owned.terminating) this.notify("exit", undefined);
      }
    } catch {
      // The process may already be gone; attempt owned termination below.
    }
    const error = await this.#terminate(owned, `${this.#adapter.name} LSP request cancelled.`);
    if (error) throw error;
  }

  close() {
    if (this.#process) void this.#terminate(this.#process, `${this.#adapter.name} LSP request cancelled.`);
  }

  /** A failed cleanup is not closure. Runner leases must await the actual close event. */
  whenClosed(): Promise<void> {
    return this.#process?.closed ?? Promise.resolve();
  }

  /** Synchronously snapshot whether admission must wait for this owned child. */
  waitForTermination(): Promise<void> | undefined {
    if (!this.#process?.terminating) return;
    return this.#process.done.then((error) => {
      if (error) throw error;
    });
  }

  #terminate(owned: OwnedProcess, message: string) {
    if (owned.exited || owned.terminating) return owned.done;
    owned.terminating = true;
    if (this.#process === owned) this.#rejectPending(message);
    const { child } = owned;
    this.#destroyStreams(child);
    // killed only means a signal was sent, not that the process exited. Keep
    // ownership until close and use the child handle, never a saved numeric PID.
    const isRunning = () => !owned.exited && child.exitCode === null && child.signalCode === null;
    const sendSignal = (signal: NodeJS.Signals) => {
      owned.signalError = undefined;
      try {
        if (child.kill(signal)) return undefined;
        return owned.signalError ?? "kill returned false";
      } catch (error) {
        return formatErrorMessage(error);
      }
    };
    if (child.pid !== undefined && isRunning()) {
      const termError = sendSignal("SIGTERM");
      owned.escalation = setTimeout(() => {
        owned.escalation = undefined;
        if (!isRunning()) return;
        const killError = sendSignal("SIGKILL");
        // Even a true kill return only acknowledges the signal attempt. Bound
        // close confirmation independently; exit alone does not release ownership.
        const unconfirmed = () => {
          owned.confirmation = undefined;
          // Resolve a failure value: synchronous close cannot cause an unhandled rejection.
          owned.completeCleanup(
            new Error(
              `${this.#adapter.name} LSP cleanup failed: ` +
                (termError ? `SIGTERM: ${termError}; ` : "") +
                (killError
                  ? `SIGKILL: ${killError}. `
                  : `No close within ${CLOSE_CONFIRMATION_MS} ms after SIGKILL. `) +
                "Child termination is unconfirmed; restart is blocked until close.",
            ),
          );
        };
        if (killError && isRunning()) unconfirmed();
        else owned.confirmation = setTimeout(unconfirmed, CLOSE_CONFIRMATION_MS);
      }, TERMINATION_GRACE_MS);
    }
    return owned.done;
  }

  #destroyStreams(child: ChildProcessWithoutNullStreams) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }

  #rejectPending(message: string | ((id: number | "diagnostics") => string)) {
    for (const [id, pending] of this.#pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(typeof message === "string" ? message : message(id)));
    }
    this.#pending.clear();
    for (const waiters of this.#diagnosticWaiters.values()) {
      for (const waiter of [...waiters]) {
        waiter.reject(new Error(typeof message === "string" ? message : message("diagnostics")));
      }
    }
    this.#diagnosticWaiters.clear();
  }

  #fail(message: string) {
    if (this.#process) void this.#terminate(this.#process, message);
  }

  private request(method: string, params: unknown) {
    const id = this.#nextId++;

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${this.#adapter.name} LSP request timed out: ${method}.${this.#formatStderr()}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });

      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown) {
    this.#send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  #send(message: JsonRpcMessage) {
    const owned = this.#process;
    if (!owned || owned.terminating) throw new Error(`${this.#adapter.name} LSP server is not running.`);

    const body = JSON.stringify(message);
    try {
      owned.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch (error) {
      const errorMessage = `${this.#adapter.name} LSP stdin write failed: ${formatErrorMessage(error)}.${this.#formatStderr()}`;
      this.#fail(errorMessage);
      throw new Error(errorMessage);
    }
  }

  #onData(chunk: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (true) {
      const separator = this.#buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;

      const header = this.#buffer.subarray(0, separator).toString("utf8");
      const contentLength = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!contentLength) throw new Error(`Invalid LSP response header: ${header}`);

      const bodyStart = separator + 4;
      const bodyLength = Number(contentLength);
      if (this.#buffer.length < bodyStart + bodyLength) return;

      const rawBody = this.#buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + bodyLength);
      this.#handleMessage(JSON.parse(rawBody) as JsonRpcMessage);
    }
  }

  #handleMessage(message: JsonRpcMessage) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.#pending.delete(message.id as number);
      if (message.error) {
        pending.reject(new Error(`${this.#adapter.name} LSP error: ${message.error.message}`));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) {
        const key = documentKey(params.uri);
        const previousVersion = this.#publishedDiagnostics.get(key)?.version ?? 0;
        const publication = {
          version: previousVersion + 1,
          diagnostics: params.diagnostics ?? [],
        };
        this.#publishedDiagnostics.set(key, publication);
        const waiters = this.#diagnosticWaiters.get(key);
        if (waiters) {
          for (const waiter of [...waiters]) waiter.onPublish(publication);
        }
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.#respondToServerRequest(message);
    }
  }

  #waitForPublishedDiagnostics(
    uri: string,
    fallback?: { afterVersion: number; diagnostics: LspDiagnostic[]; waitMs: number },
  ) {
    if (!this.#process || this.#process.terminating) {
      return Promise.reject(new Error(`${this.#adapter.name} LSP server is not running.`));
    }
    // See PUBLISHED_DIAGNOSTICS_SETTLE_MS. Bounded by #timeoutMs.
    const key = documentKey(uri);
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      let settleTimer: NodeJS.Timeout | undefined;
      let fallbackTimer: NodeJS.Timeout | undefined;
      let overallTimer: NodeJS.Timeout | undefined;
      let sawNonEmptyPublication = false;
      const afterVersion = fallback?.afterVersion ?? 0;

      const dispose = () => {
        if (settleTimer) clearTimeout(settleTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (overallTimer) clearTimeout(overallTimer);
        const set = this.#diagnosticWaiters.get(key);
        set?.delete(waiter);
        if (set && set.size === 0) this.#diagnosticWaiters.delete(key);
      };
      const settleWith = (diagnostics: LspDiagnostic[]) => {
        dispose();
        resolve(diagnostics);
      };
      const fail = (reason: unknown) => {
        dispose();
        reject(reason);
      };
      const onPublish = (publication: { version: number; diagnostics: LspDiagnostic[] }) => {
        if (publication.version <= afterVersion) return;
        if (fallback && publication.diagnostics.length === 0 && !sawNonEmptyPublication) return;
        sawNonEmptyPublication ||= publication.diagnostics.length > 0;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(
          () => settleWith(this.#publishedDiagnostics.get(key)?.diagnostics ?? []),
          this.#adapter.diagnosticsSettleMs ?? PUBLISHED_DIAGNOSTICS_SETTLE_MS,
        );
      };

      const waiter = { onPublish, reject: fail, dispose };
      const set = this.#diagnosticWaiters.get(key) ?? new Set<typeof waiter>();
      set.add(waiter);
      this.#diagnosticWaiters.set(key, set);

      if (fallback) {
        fallbackTimer = setTimeout(
          () => {
            const latest = this.#publishedDiagnostics.get(key);
            settleWith(latest && latest.version > afterVersion ? latest.diagnostics : fallback.diagnostics);
          },
          Math.min(fallback.waitMs, this.#timeoutMs),
        );
      }
      overallTimer = setTimeout(() => {
        const latest = this.#publishedDiagnostics.get(key);
        if (latest && latest.version > afterVersion) {
          settleWith(latest.diagnostics);
        } else if (fallback) {
          settleWith(fallback.diagnostics);
        } else {
          fail(new Error(`${this.#adapter.name} LSP did not return diagnostics for ${uri} before timeout.`));
        }
      }, this.#timeoutMs);

      const existing = this.#publishedDiagnostics.get(key);
      if (existing) onPublish(existing);
    });
  }

  #respondToServerRequest(message: JsonRpcMessage) {
    if (message.method === "workspace/configuration") {
      const params = message.params as { items?: Array<{ section?: string }> } | undefined;
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: (params?.items ?? []).map((item) => this.#configurationValue(item.section)),
      });
      return;
    }

    if (message.method === "workspace/workspaceFolders") {
      const rootUri = directoryUri(this.#cwd);
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        result: [{ uri: rootUri, name: path.basename(this.#cwd) || "workspace" }],
      });
      return;
    }

    if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
      this.#send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }

    this.#send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method ?? "unknown"}` },
    });
  }

  #configurationValue(section: string | undefined) {
    if (!section) return this.#adapter.initialization ?? {};
    return this.#adapter.initialization?.[section] ?? {};
  }

  #formatStderr() {
    const bytes = Buffer.allocUnsafe(this.#stderrSize);
    const start = (this.#stderrEnd - this.#stderrSize + STDERR_TAIL_BYTES) % STDERR_TAIL_BYTES;
    const first = Math.min(this.#stderrSize, STDERR_TAIL_BYTES - start);
    this.#stderr.copy(bytes, 0, start, start + first);
    if (first < this.#stderrSize) this.#stderr.copy(bytes, first, 0, this.#stderrSize - first);

    // Drop an incomplete character at either end of the retained byte tail.
    let offset = 0;
    while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
    const decoded = new StringDecoder("utf8").write(bytes.subarray(offset)).trim();
    const encoded = Buffer.from(decoded);
    const bounded = encoded.subarray(-STDERR_TAIL_BYTES);
    offset = 0;
    while (offset < bounded.length && (bounded[offset] & 0xc0) === 0x80) offset++;
    const stderr = new StringDecoder("utf8").write(bounded.subarray(offset)).trim();
    return stderr ? `\nServer stderr:\n${stderr}` : "";
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
