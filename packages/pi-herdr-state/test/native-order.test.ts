import { test } from "bun:test";
import assert from "node:assert/strict";
import { ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import { createReporter } from "../src/index.js";

type Handler = (...args: unknown[]) => void | Promise<void>;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("real native end can overtake a delayed start without leaving Herdr blocked", async () => {
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const requests: Array<{ params?: { state?: string; message?: string } }> = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = new Map<string, Handler[]>([
    [
      "ui_prompt_start",
      [
        async () => {
          await gate;
        },
      ],
    ],
  ]);
  createReporter(
    {
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      events: {
        on: (event, handler) => {
          busHandlers.set(event, handler);
        },
      },
    },
    async (request) => {
      requests.push(request as (typeof requests)[number]);
    },
  );
  const runner = new ExtensionRunner(
    [
      { path: "delayed", handlers: delayed },
      { path: "herdr", handlers },
    ] as never,
    {} as never,
    ".",
    SessionManager.inMemory(),
    {} as never,
  );
  runner.setUIContext({ confirm: async () => false } as never, "tui");
  const state = () => requests.at(-1)?.params?.state;
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    await flush();
    assert.equal(state(), "idle");
    assert.equal(await runner.getUIContext().confirm("private title", "dismiss immediately"), false);
    await flush(); // end reached Herdr; start is still held in the preceding extension
    busHandlers.get("herdr:blocked")?.({ active: true, label: "manual" });
    await flush();
    assert.equal(state(), "blocked");
    release();
    await flush();
    busHandlers.get("herdr:blocked")?.({ active: false });
    await flush();
    assert.equal(state(), "idle");
    assert.equal(JSON.stringify(requests).includes("private title"), false);
    // A normal subsequent prompt must still own a wait, even on an idle agent.
    let close = () => {};
    runner.setUIContext(
      {
        confirm: () =>
          new Promise<boolean>((resolve) => {
            close = () => resolve(false);
          }),
      } as never,
      "tui",
    );
    const pending = runner.getUIContext().confirm("another private title", "wait");
    await flush();
    assert.equal(state(), "blocked");
    close();
    await pending;
    await flush();
    assert.equal(state(), "idle");
  } finally {
    release();
    await runner.emit({ type: "session_shutdown", reason: "reload" });
  }
});

test("native prompt spanning reporter activation is accounted before publication", async () => {
  const handlers = new Map<string, Handler[]>();
  const states: string[] = [];
  createReporter(
    { on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) },
    async (request) => {
      const state = (request as { params?: { state?: string } }).params?.state;
      if (state) states.push(state);
    },
  );
  let close = () => {};
  let pending: Promise<boolean> | undefined;
  const early = new Map<string, Handler[]>([
    [
      "session_start",
      [
        () => {
          pending = runner.getUIContext().confirm("startup", "wait");
        },
      ],
    ],
  ]);
  const runner = new ExtensionRunner(
    [
      { path: "early", handlers: early },
      { path: "herdr", handlers },
    ] as never,
    {} as never,
    ".",
    SessionManager.inMemory(),
    {} as never,
  );
  runner.setUIContext(
    {
      confirm: () =>
        new Promise<boolean>((resolve) => {
          close = () => resolve(false);
        }),
    } as never,
    "tui",
  );
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    await flush();
    assert.equal(states.at(-1), "blocked");
    close();
    await pending;
    await flush();
    assert.equal(states.at(-1), "idle");
    pending = runner.getUIContext().confirm("next", "wait");
    await flush();
    assert.equal(states.at(-1), "blocked");
    close();
    await pending;
    await flush();
    assert.equal(states.at(-1), "idle");
  } finally {
    close();
    await runner.emit({ type: "session_shutdown", reason: "reload" });
  }
});
