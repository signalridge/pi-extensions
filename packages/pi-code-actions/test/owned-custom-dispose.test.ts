import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { ownedCustom } from "../src/owned-custom.js";

// Pi 1.4's resetExtensionUI (for example /reload) disposes open dialogs without
// calling their done callback; the owner must still observe a settled dialog.
function hostThatDisposesWithoutClosing() {
  let mounted: (Component & { dispose?(): void }) | undefined;
  let pending = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory: (...args: unknown[]) => Component) =>
        new Promise((resolve) => {
          pending++;
          mounted = factory({}, {}, {}, (value: unknown) => {
            pending--;
            resolve(value);
          });
        }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, reset: () => mounted?.dispose?.(), pending: () => pending };
}

test("a dialog disposed by the host without closing settles its owner as cancelled", async () => {
  const host = hostThatDisposesWithoutClosing();
  let innerDisposed = 0;
  const result = ownedCustom<string>(host.ctx, { signal: new AbortController().signal, isCurrent: () => true }, () => ({
    render: () => ["dialog"],
    invalidate() {},
    dispose: () => {
      innerDisposed++;
    },
  }));
  await Promise.resolve();
  host.reset();
  assert.equal(await result, undefined);
  // The host owns its raw UI promise; disposal must not invoke rawDone.
  assert.equal(host.pending(), 1);
  assert.equal(innerDisposed, 1);
});
