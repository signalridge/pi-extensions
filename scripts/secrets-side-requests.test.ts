import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { type Api, fauxAssistantMessage, type JsonObject, type Model } from "@earendil-works/pi-ai";
import {
  type ContextWithSystemEvent,
  convertToLlm,
  createEventBus,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { registerBtwAdvisor, runAdvisor } from "../packages/pi-btw/src/advisor.js";
import btw, { buildSessionConversationContext, runBtwThread } from "../packages/pi-btw/src/btw.js";
import { createSecretsProjection, projectJson } from "../packages/pi-btw/src/secrets-projection.js";
import {
  type CompleteSimpleFunction,
  completeSideThreadTurn,
  createSideThread,
  type SideThread,
} from "../packages/pi-btw/src/side-thread.js";
import { formatSideTranscript } from "../packages/pi-btw/src/transcript-pager.js";
import { createMockContext, createMockPi } from "../packages/pi-btw/test/support.js";
import { registerSecrets } from "../packages/pi-secrets/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const SECRET = "boundary-secret-value";
const DISCOVERED = "Ab1/".repeat(10);
const reference = "reviewer/offline";
const model = {
  provider: "reviewer",
  id: "offline",
  api: "faux",
  baseUrl: "https://reviewer.test",
  reasoning: false,
} as Model<Api>;
const registry = {
  find: () => model,
  getApiKeyAndHeaders: async () => ({ ok: true as const }),
  getProvider: () => undefined,
};
const EVENT = "pi-secrets:projection:v1";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "secrets-side-"));
  roots.push(root);
  const manager = SessionManager.inMemory(root);
  let aborted = 0;
  const context = createMockContext({
    abort: () => {
      aborted++;
    },
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionManager: manager,
    modelRegistry: registry,
  });
  const host = createMockPi();
  // The SDK bus swallows listener errors and ignores returned promises. The capability must still be synchronous.
  const events = createEventBus();
  host.rawPi.events = events;
  const ctx = { hasUI: true, model: undefined, sessionManager: manager, modelRegistry: registry };
  const start = async () => {
    for (const handler of host.events.get("session_start") ?? []) await handler({}, context.ctx);
  };
  const secrets = () => registerSecrets(host.pi, { env: () => ({ DEPLOY_TOKEN: SECRET }), agentDir: () => root });
  return {
    root,
    manager,
    context,
    host,
    events,
    ctx,
    start,
    secrets,
    get aborted() {
      return aborted;
    },
  };
}

/** Exercise the registered command/tool, replacing only UI interaction and provider completion. */
function registerSafetyCallers(f: ReturnType<typeof fixture>, complete: CompleteSimpleFunction) {
  const threads: SideThread[] = [];
  const displayed: string[] = [];
  const returned: unknown[] = [];
  registerBtwAdvisor(f.host.pi, {
    readSettings: async () => ({ kind: "loaded", settings: { advisorModel: reference } }),
    completeSimple: complete,
  });
  btw(f.host.pi, {
    loadSettings: async () => ({}),
    resolveModel: async () => ({ kind: "selected", selected: { model, auth: {} } }),
    runFullscreen: async (ctx, run) => run(ctx),
    runThread: (options) =>
      runBtwThread({
        ...options,
        dependencies: {
          interact: async (thread) => {
            threads.push(thread);
            displayed.push(formatSideTranscript(thread.turns));
            return { kind: "close" };
          },
          ask: async (thread, question, selected, thinkingLevel, ctx, steering) => {
            const result = await completeSideThreadTurn({
              thread,
              question,
              model: selected.model,
              auth: selected.auth,
              thinkingLevel,
              completeSimple: complete,
              prepareContext: steering.prepareContext,
              isCurrent: steering.isCurrent,
              createProjection: () =>
                createSecretsProjection(steering.projectionEvents, ctx, undefined, steering.isCurrent),
            });
            returned.push(result);
            return result;
          },
        },
      }),
  });
  return {
    threads,
    displayed,
    returned,
    async advisor() {
      const tool = f.host.tools.find((item) => item.name === "advisor") as unknown as {
        execute: (
          id: string,
          args: { question: string },
          signal: undefined,
          update: undefined,
          ctx: unknown,
        ) => Promise<unknown>;
      };
      return tool.execute("safety", { question: "review safely" }, undefined, undefined, f.context.ctx);
    },
  };
}

for (const order of ["Secrets->BTW", "BTW->Secrets"]) {
  test(`${order}: cooperating command and advisor project before history truncation without changing storage`, async () => {
    const f = fixture();
    f.manager.appendMessage({ role: "user", content: `aws_secret_access_key=${DISCOVERED}`, timestamp: 1 });
    // Its detector setting is outside the tail budget. A raw suffix would leak a partial secret.
    f.manager.appendMessage({ role: "user", content: `${DISCOVERED}${"x".repeat(39_990)}`, timestamp: 2 });
    const args = JSON.parse(`{"__proto__":"${SECRET}","constructor":{"list":["${DISCOVERED}"]},"toJSON":"${SECRET}"}`);
    Object.defineProperty(args, "hidden", { value: SECRET });
    Object.freeze(args);
    const list = (args as { constructor: { list: string[] } }).constructor.list;
    Object.defineProperty(list, "0", { enumerable: false });
    Object.freeze(list);
    f.manager.appendMessage(fauxAssistantMessage([{ type: "toolCall", id: "a", name: "probe", arguments: args }]));
    const before = JSON.stringify(f.manager.getBranch());
    const requests: string[] = [];
    const complete: CompleteSimpleFunction = async (_model, context) => {
      const sent = JSON.stringify(context);
      requests.push(sent);
      const issued = /\$\$DEPLOY_TOKEN_[A-Z0-9]{12}\$\$/.exec(sent)?.[0];
      return fauxAssistantMessage(`Keep ${issued} and $$UNKNOWN_000000000000$$ unchanged.`);
    };
    const cooperate = () => {
      registerBtwAdvisor(f.host.pi, {
        readSettings: async () => ({ kind: "loaded", settings: { advisorModel: reference } }),
        completeSimple: complete,
      });
      btw(f.host.pi, {
        loadSettings: async () => ({}),
        resolveModel: async () => ({ kind: "selected", selected: { model, auth: {} } }),
        runFullscreen: async (ctx, run) => run(ctx),
        runThread: (options) =>
          runBtwThread({
            ...options,
            dependencies: {
              interact: async () => ({ kind: "close" }),
              ask: async (thread, question, selected, thinkingLevel, ctx, steering) =>
                completeSideThreadTurn({
                  thread,
                  question,
                  model: selected.model,
                  auth: selected.auth,
                  thinkingLevel,
                  completeSimple: complete,
                  prepareContext: steering.prepareContext,
                  isCurrent: steering.isCurrent,
                  createProjection: () =>
                    createSecretsProjection(steering.projectionEvents, ctx, undefined, steering.isCurrent),
                }),
            },
          }),
      });
    };
    if (order.startsWith("Secrets")) {
      f.secrets();
      cooperate();
    } else {
      cooperate();
      f.secrets();
    }
    await f.start();
    await f.host.commands.get("btw")?.handler(`--with-parent=${reference} explain ${SECRET}`, f.context.ctx);
    const tool = f.host.tools.find((item) => item.name === "advisor") as unknown as {
      execute: (
        id: string,
        args: { question: string },
        signal: AbortSignal | undefined,
        update: undefined,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    const answer = await tool.execute("adv", { question: SECRET }, undefined, undefined, f.context.ctx);
    expect(JSON.stringify(answer)).toContain("$$UNKNOWN_000000000000$$");
    expect(JSON.stringify(answer)).toContain("$$DEPLOY_TOKEN_");
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).not.toContain(SECRET);
      expect(request).not.toContain(DISCOVERED);
      expect(request).not.toContain(DISCOVERED.slice(-10));
      expect(request).toContain("$$DEPLOY_TOKEN_");
      expect(request.length).toBeLessThan(43_000);
    }
    expect(JSON.stringify(f.manager.getBranch())).toBe(before);
    expect(Object.hasOwn(args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(args, "hidden")?.value).toBe(SECRET);
    expect(args.toJSON).toBe(SECRET);

    // The service never restores side replies; restoration remains the existing native tool boundary.
    const projected = createSecretsProjection(f.events, f.ctx)?.([SECRET])[0];
    const input = { nested: { token: projected } };
    for (const handler of f.host.events.get("tool_call") ?? []) handler({ input }, f.context.ctx);
    expect(input.nested.token).toBe(SECRET);
  });
}

test("without Secrets opt-in, the original bounded history and side question are unchanged", async () => {
  const f = fixture();
  f.manager.appendMessage({ role: "user", content: SECRET, timestamp: 0 });
  expect(createSecretsProjection(f.events, f.ctx)).toBeUndefined();
  let sent = "";
  const result = await runAdvisor({
    reference,
    routingId: "id",
    thinkingLevel: "off",
    question: SECRET,
    ctx: f.ctx,
    projectionEvents: f.events,
    completeSimple: async (_model, context) => {
      sent = JSON.stringify(context);
      return fauxAssistantMessage("ok");
    },
  });
  expect(result.isError).toBeUndefined();
  expect(sent).toContain(SECRET);
  expect(buildSessionConversationContext(f.manager)).toBe(`User: ${SECRET}`);
});

for (const mode of [
  "refusal",
  "throw",
  "promise",
  "reject",
  "cross-realm-reject",
  "thenable-getter",
  "inherited",
  "getter",
  "sparse",
  "duplicate",
]) {
  test(`active projection ${mode} fails closed for both callers`, async () => {
    const f = fixture();
    let invoked = 0;
    let getterRead = false;
    const project = () => {
      if (mode === "throw") throw new Error(SECRET);
      if (mode === "promise") return Promise.resolve({ version: 1, ok: true, texts: [SECRET] });
      if (mode === "reject") return Promise.reject(new Error(SECRET));
      if (mode === "cross-realm-reject")
        return runInNewContext("Promise.reject(new Error(secret))", { secret: SECRET });
      if (mode === "thenable-getter")
        return {
          // biome-ignore lint/suspicious/noThenProperty: hostile thenable fixture; the getter must never run.
          get then() {
            getterRead = true;
            throw new Error(SECRET);
          },
        };
      if (mode === "inherited") return Object.create({ version: 1, ok: true, texts: [SECRET] });
      if (mode === "getter")
        return {
          version: 1,
          ok: true,
          get texts() {
            getterRead = true;
            return [SECRET];
          },
        };
      if (mode === "sparse") return { version: 1, ok: true, texts: new Array(1) };
      return { version: 1, ok: false };
    };
    const claim = (data: unknown) => (data as { accept: (service: unknown) => void }).accept({ version: 1, project });
    f.events.on(EVENT, claim);
    if (mode === "duplicate") f.events.on(EVENT, claim);
    const complete: CompleteSimpleFunction = async () => {
      invoked++;
      return fauxAssistantMessage("bad");
    };
    const advisor = await runAdvisor({
      reference,
      routingId: "id",
      thinkingLevel: "off",
      question: SECRET,
      ctx: f.ctx,
      projectionEvents: f.events,
      completeSimple: complete,
    });
    expect(advisor.isError).toBe(true);
    expect(JSON.stringify(advisor)).not.toContain(SECRET);
    const thread = createSideThread();
    const side = await completeSideThreadTurn({
      thread,
      model,
      auth: {},
      question: SECRET,
      thinkingLevel: "off",
      completeSimple: complete,
      createProjection: () => createSecretsProjection(f.events, f.ctx),
    });
    expect(side.kind).toBe("error");
    expect(JSON.stringify(side)).not.toContain(SECRET);
    expect(thread.turns).toEqual([]);
    expect(invoked).toBe(0);
    expect(getterRead).toBe(false);
  });
}

test("provider admission refuses inactive sessions, stale capabilities, wrong leaves, malformed envelopes and oversized batches", async () => {
  const f = fixture();
  f.secrets();
  const beforeStart = createSecretsProjection(f.events, f.ctx);
  expect(() => beforeStart?.([SECRET])).toThrow(/withheld/);
  await f.start();
  const project = createSecretsProjection(f.events, f.ctx);
  expect(project?.([SECRET])[0]).not.toContain(SECRET);
  expect(() => project?.(["x".repeat(8 * 1024 * 1024 + 1)])).toThrow(/withheld/);
  expect(() => project?.(Array.from({ length: 50_001 }, () => ""))).toThrow(/withheld/);
  let service!: (request: unknown) => unknown;
  f.events.emit(EVENT, {
    version: 1,
    accept: (claim: { project: typeof service }) => {
      service = claim.project;
    },
  });
  const request = { version: 1, sessionId: f.manager.getSessionId(), leafId: f.manager.getLeafId(), texts: [SECRET] };
  expect(service({ ...request, leafId: "wrong" })).toEqual({ version: 1, ok: false });
  expect(service(Object.create(request))).toEqual({ version: 1, ok: false });
  let accessed = false;
  expect(
    service({
      ...request,
      get texts() {
        accessed = true;
        return [SECRET];
      },
    }),
  ).toEqual({ version: 1, ok: false });
  expect(accessed).toBe(false);
  for (const handler of f.host.events.get("session_shutdown") ?? []) handler({}, f.context.ctx);
  expect(() => project?.([SECRET])).toThrow(/withheld/);
  const inactive = createSecretsProjection(f.events, f.ctx);
  expect(() => inactive?.([SECRET])).toThrow(/withheld/);
});

test("cancelled and diverged callers cannot project or dispatch; late advisor replies cannot cross branches", async () => {
  const f = fixture();
  f.secrets();
  f.manager.appendMessage({ role: "user", content: "origin", timestamp: 0 });
  await f.start();
  const controller = new AbortController();
  const project = createSecretsProjection(f.events, f.ctx, controller.signal);
  controller.abort();
  expect(() => project?.([SECRET])).toThrow(/withheld/);
  const old = createSecretsProjection(f.events, f.ctx);
  const origin = f.manager.getLeafId() as string;
  f.manager.resetLeaf();
  expect(() => old?.([SECRET])).toThrow(/withheld/);
  f.manager.branch(origin);
  expect(() => old?.([SECRET])).toThrow(/withheld/);
  let finish!: (auth: { ok: true }) => void;
  let calls = 0;
  const pending = runAdvisor({
    reference,
    routingId: "id",
    thinkingLevel: "off",
    ctx: {
      ...f.ctx,
      modelRegistry: {
        ...registry,
        getApiKeyAndHeaders: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    },
    projectionEvents: f.events,
    completeSimple: async () => {
      calls++;
      return fauxAssistantMessage("late");
    },
  });
  f.manager.resetLeaf();
  finish({ ok: true });
  expect((await pending).isError).toBe(true);
  expect(calls).toBe(0);
  f.manager.branch(origin);
  const late = await runAdvisor({
    reference,
    routingId: "id",
    thinkingLevel: "off",
    ctx: f.ctx,
    projectionEvents: f.events,
    completeSimple: async () => {
      f.manager.resetLeaf();
      return fauxAssistantMessage("LATE_ANSWER");
    },
  });
  expect(late.isError).toBe(true);
  expect(JSON.stringify(late)).not.toContain("LATE_ANSWER");
});

test("side replays are request-only projections, without implicitly reading parent history or restoring replies", async () => {
  const f = fixture();
  f.manager.appendMessage({ role: "user", content: "PARENT_NOT_SHARED", timestamp: 0 });
  f.secrets();
  await f.start();
  const thread = createSideThread();
  const prior = fauxAssistantMessage(`prior ${SECRET}`);
  thread.turns.push({ kind: "answered", question: SECRET, answer: `prior ${SECRET}`, response: prior });
  const before = JSON.stringify(thread);
  let sent = "";
  const result = await completeSideThreadTurn({
    thread,
    model,
    auth: {},
    question: `next ${SECRET}`,
    thinkingLevel: "off",
    createProjection: () => createSecretsProjection(f.events, f.ctx),
    completeSimple: async (_model, context) => {
      sent = JSON.stringify(context);
      return fauxAssistantMessage(/\$\$DEPLOY_TOKEN_[A-Z0-9]{12}\$\$/.exec(sent)?.[0] ?? "missing");
    },
  });
  expect(result.kind).toBe("answered");
  expect(sent).not.toContain(SECRET);
  expect(sent).not.toContain("PARENT_NOT_SHARED");
  expect(JSON.stringify(thread.turns[0])).toBe(JSON.stringify(JSON.parse(before).turns[0]));
  expect(thread.turns[1]?.answer).toContain("$$DEPLOY_TOKEN_");
  expect(thread.turns[1]?.answer).not.toContain(SECRET);
  expect(thread.turns[1]?.question).toBe(`next ${SECRET}`);
});

test("cancellation during a successful service reply still prevents dispatch", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.events.on(EVENT, (data: unknown) =>
    (data as { accept: (service: unknown) => void }).accept({
      version: 1,
      project: (request: { texts: string[] }) => {
        controller.abort();
        return { version: 1, ok: true, texts: request.texts.map(() => "redacted") };
      },
    }),
  );
  let calls = 0;
  const result = await completeSideThreadTurn({
    thread: createSideThread(),
    model,
    auth: {},
    question: SECRET,
    thinkingLevel: "off",
    signal: controller.signal,
    createProjection: () => createSecretsProjection(f.events, f.ctx, controller.signal),
    completeSimple: async () => {
      calls++;
      return fauxAssistantMessage("bad");
    },
  });
  expect(result.kind).toBe("aborted");
  expect(calls).toBe(0);
});

for (const inherited of [false, true]) {
  for (const accessor of [false, true]) {
    for (const visibleToken of [false, true]) {
      test(`unsafe JSON hook (inherited=${inherited}, accessor=${accessor}, visible=${visibleToken}) withholds native and cooperating dispatch`, async () => {
        const f = fixture();
        let reads = 0;
        const hook = accessor
          ? {
              get() {
                reads++;
                return () => SECRET;
              },
            }
          : {
              value(this: { hidden: string }) {
                reads++;
                return this.hidden;
              },
            };
        const owner = Object.defineProperty({}, "toJSON", hook);
        const args: JsonObject = inherited ? Object.create(owner) : owner;
        Object.defineProperty(args, "hidden", { value: SECRET });
        if (visibleToken) Object.defineProperty(args, "token", { value: SECRET, enumerable: true });
        Object.freeze(args);
        const descriptors = Object.getOwnPropertyDescriptors(args);
        const prototype = Object.getPrototypeOf(args);
        const response = fauxAssistantMessage([{ type: "toolCall", id: "a", name: "probe", arguments: args }]);
        f.manager.appendMessage(response);
        const stored = f.manager.getBranch().slice();
        f.secrets();
        let dispatches = 0;
        const complete: CompleteSimpleFunction = async () => {
          dispatches++;
          return fauxAssistantMessage("bad");
        };
        const callers = registerSafetyCallers(f, complete);
        await f.start();

        // The blocking native context hook aborts and replaces conversation, not just a later advisory hook.
        const system = { role: "system" as const, content: "system only", timestamp: 0 };
        let nativeMessages: ContextWithSystemEvent["messages"] = [system, response];
        for (const handler of f.host.events.get("context_with_system") ?? []) {
          const result = (await handler({ type: "context_with_system", messages: nativeMessages }, f.context.ctx)) as
            | { messages: ContextWithSystemEvent["messages"] }
            | undefined;
          if (result) nativeMessages = result.messages;
        }
        expect(f.aborted).toBe(1);
        expect(nativeMessages).toEqual([system]);
        expect(JSON.stringify(convertToLlm(nativeMessages))).not.toContain(SECRET);
        expect(JSON.stringify(f.context.notifications)).not.toContain(SECRET);
        if (!f.aborted) await complete(model, { messages: convertToLlm(nativeMessages) });

        await f.host.commands.get("btw")?.handler(`--with-parent=${reference} review safely`, f.context.ctx);
        const advisor = await callers.advisor();
        expect(advisor).toMatchObject({ isError: true });
        expect(callers.returned).toEqual([{ kind: "error", message: expect.stringContaining("withheld") }]);
        expect(callers.threads[0]?.turns[0]).toMatchObject({
          kind: "error",
          answer: expect.stringContaining("withheld"),
        });
        expect(JSON.stringify([advisor, callers.returned, callers.threads, callers.displayed])).not.toContain(SECRET);

        // Without parent consent, previous side responses still must not serialize unsafe tool arguments.
        const side = createSideThread();
        side.turns.push({ kind: "answered", question: "prior", answer: "prior", response });
        const sideResult = await completeSideThreadTurn({
          thread: side,
          model,
          auth: {},
          question: "follow up",
          thinkingLevel: "off",
          completeSimple: complete,
          createProjection: () => createSecretsProjection(f.events, f.ctx),
        });
        expect(sideResult).toMatchObject({ kind: "error", message: expect.stringContaining("withheld") });
        expect(side.turns).toHaveLength(1);
        expect(side.turns[0]).toMatchObject({ response });
        expect(dispatches).toBe(0);
        expect(reads).toBe(0);
        expect(Object.getOwnPropertyDescriptors(args)).toEqual(descriptors);
        expect(Object.getPrototypeOf(args)).toBe(prototype);
        expect(Object.isFrozen(args)).toBe(true);
        expect(f.manager.getBranch()).toHaveLength(stored.length);
        f.manager.getBranch().forEach((entry, index) => {
          expect(entry).toBe(stored[index]);
        });
      });
    }
  }
}

test("local projection checks hooks before calling discovery, while inert JSON keys and descriptors stay valid", () => {
  let calls = 0;
  const project = (texts: readonly string[]) => {
    calls++;
    return texts.map((text) => text.replaceAll(SECRET, "[S]"));
  };
  const unsafe = Object.freeze(
    Object.defineProperties(
      {},
      {
        hidden: { value: SECRET },
        toJSON: {
          value() {
            throw new Error(SECRET);
          },
        },
      },
    ),
  );
  expect(() => projectJson(unsafe, project)).toThrow(/withheld/);
  expect(calls).toBe(0);
  const args = JSON.parse(
    `{"toJSON":"${SECRET}","__proto__":"${SECRET}","constructor":"${SECRET}","list":["${SECRET}"]}`,
  );
  Object.defineProperty(args, "hidden", { value: SECRET });
  Object.defineProperty(args.list, "0", { enumerable: false });
  Object.freeze(args.list);
  Object.freeze(args);
  const projected = projectJson(args, project);
  expect(JSON.stringify(projected)).toBe('{"toJSON":"[S]","__proto__":"[S]","constructor":"[S]","list":["[S]"]}');
  expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
  expect(Object.hasOwn(projected, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(projected, "hidden")).toEqual(Object.getOwnPropertyDescriptor(args, "hidden"));
  expect(Object.getOwnPropertyDescriptor(projected.list, "0")).toEqual({
    value: "[S]",
    enumerable: false,
    writable: false,
    configurable: false,
  });
  expect(args.toJSON).toBe(SECRET);
  expect(args.list[0]).toBe(SECRET);
  expect(projectJson(projected, project)).toBe(projected);
});

for (const trap of ["getPrototypeOf", "getOwnPropertyDescriptor"] as const) {
  test(`malformed claim ${trap} errors never reach returned, stored or displayed BTW/advisor errors`, async () => {
    const f = fixture();
    f.events.on(EVENT, (data: unknown) => {
      const claim = new Proxy(
        {
          version: 1,
          project: () => {
            throw new Error("must not invoke");
          },
        },
        {
          [trap]() {
            throw new Error(SECRET);
          },
        },
      );
      (data as { accept: (claim: unknown) => void }).accept(claim);
    });
    let dispatches = 0;
    const callers = registerSafetyCallers(f, async () => {
      dispatches++;
      return fauxAssistantMessage("bad");
    });
    await f.start();
    expect(() => createSecretsProjection(f.events, f.ctx)).toThrow(
      "Secret projection unavailable; the side request was withheld.",
    );
    await f.host.commands.get("btw")?.handler("review safely", f.context.ctx);
    const advisor = await callers.advisor();
    expect(advisor).toMatchObject({ isError: true });
    expect(callers.returned).toEqual([
      { kind: "error", message: "Secret projection unavailable; the side request was withheld." },
    ]);
    expect(callers.threads[0]?.turns).toEqual([
      {
        kind: "error",
        question: "review safely",
        answer: "Secret projection unavailable; the side request was withheld.",
      },
    ]);
    expect(callers.displayed[0]).toContain("Error: Secret projection unavailable");
    expect(
      JSON.stringify([advisor, callers.returned, callers.threads, callers.displayed, f.context.notifications]),
    ).not.toContain(SECRET);
    expect(dispatches).toBe(0);
  });
}

test("discovery emitter exceptions are generic, not mistaken for zero claims", () => {
  const f = fixture();
  expect(createSecretsProjection(f.events, f.ctx)).toBeUndefined();
  const events = {
    ...f.events,
    emit: () => {
      throw new Error(SECRET);
    },
  };
  expect(() => createSecretsProjection(events, f.ctx)).toThrow(
    "Secret projection unavailable; the side request was withheld.",
  );
});

for (const settlement of ["resolve", "reject"]) {
  test(`cross-realm ${settlement} promises are observed intrinsically without then/catch getter reads or unhandled errors`, async () => {
    const f = fixture();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let reads = 0;
    f.events.on(EVENT, (data: unknown) =>
      (data as { accept: (claim: unknown) => void }).accept({
        version: 1,
        project: () => {
          const value = {};
          const promise = runInNewContext(
            settlement === "reject" ? "Promise.reject(new Error(secret))" : "Promise.resolve(value)",
            { secret: SECRET, value },
          ) as Promise<unknown>;
          // A fulfilled value can acquire a thenable getter after settlement. The observer must discard it,
          // not pass it through a derived promise's resolution/assimilation machinery.
          // biome-ignore lint/suspicious/noThenProperty: ensure the promise observer never assimilates this hostile value.
          Object.defineProperty(value, "then", {
            get() {
              reads++;
              throw new Error(SECRET);
            },
          });
          expect(promise instanceof Promise).toBe(false);
          for (const key of ["then", "catch"])
            Object.defineProperty(promise, key, {
              get() {
                reads++;
                throw new Error(SECRET);
              },
            });
          return promise;
        },
      }),
    );
    let dispatches = 0;
    const callers = registerSafetyCallers(f, async () => {
      dispatches++;
      return fauxAssistantMessage("bad");
    });
    try {
      await f.start();
      await f.host.commands.get("btw")?.handler("review safely", f.context.ctx);
      const advisor = await callers.advisor();
      expect(advisor).toMatchObject({ isError: true });
      expect(JSON.stringify([advisor, callers.returned, callers.threads, callers.displayed])).not.toContain(SECRET);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(reads).toBe(0);
      expect(dispatches).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
}

test("one batch protects cross-secret labels in question and parent, retaining stored cached tokens", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "pi-secrets.json"),
    JSON.stringify({
      secrets: [
        { name: "other-secret-123", value: SECRET },
        { name: "SAFE", pattern: "OtherSecret123" },
      ],
    }),
  );
  f.secrets();
  await f.start();
  const project = createSecretsProjection(f.events, f.ctx);
  const old = project?.([SECRET])[0] ?? "";
  expect(old).toContain("OTHER_SECRET_123");
  f.manager.appendMessage({ role: "user", content: `${SECRET} ${old}`, timestamp: 0 });
  const before = JSON.stringify(f.manager.getBranch());
  let request = "";
  await runAdvisor({
    reference,
    routingId: "id",
    thinkingLevel: "off",
    question: "OtherSecret123",
    ctx: f.ctx,
    projectionEvents: f.events,
    completeSimple: async (_model, context) => {
      request = JSON.stringify(context);
      return fauxAssistantMessage("ok");
    },
  });
  expect(request).not.toContain("OTHER_SECRET_123");
  expect(request).not.toContain("OtherSecret123");
  expect(request).toContain("$$SECRET_");
  expect(JSON.stringify(f.manager.getBranch())).toBe(before);
});
