import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeUI } from "../src/native-ui.js";
import { OwnedOverlay, ownedUI } from "../src/ui.js";
import { terminalFixture } from "./terminal.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const native = terminalFixture();
  cleanup.push(native.dispose);
  // Only fake the monitor; native renderer timeouts still run normally.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const root = native.tui.getFocusedComponent();
  const host: NativeUI = {
    tui: native.tui,
    theme: native.ui.theme,
    checkDraft: vi.fn(),
    checkFocus: vi.fn(() => {
      if (native.tui.getFocusedComponent() !== root) throw new Error("Foreign focus");
    }),
  };
  const guard = vi.fn();
  const currentOwner = vi.fn();
  const child = {
    render: vi.fn(() => ["Owned child"]),
    invalidate: vi.fn(),
    handleInput: vi.fn(),
    dispose: vi.fn(),
  } satisfies Component & { dispose(): void };
  const clean = () => {
    expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls).toEqual(add.mock.calls.map(([event, listener]) => [event, listener]));
    expect(native.tui.hasOverlay()).toBe(false);
    expect(native.tui.getFocusedComponent()).toBe(root);
  };
  return { native, host, controller, guard, currentOwner, child, clean };
}

describe("owned raw overlay monitor cleanup", () => {
  for (const close of ["cancel", "success", "abort", "dispose", "input", "render", "invalidate", "disposal"] as const)
    it(`cleans the timer and abort listener on ${close}`, async () => {
      const f = fixture();
      let done!: (value?: string) => void;
      const pending = ownedUI<string>(f.host, f.controller.signal, f.guard, f.currentOwner, (_tui, _theme, end) => {
        done = end;
        return f.child;
      });
      const owner = f.native.active();
      if (!(owner instanceof OwnedOverlay)) throw new Error("Missing overlay");
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(225);
      expect(f.currentOwner).toHaveBeenCalledTimes(4); // Admission plus three lightweight ticks.
      expect(f.guard).toHaveBeenCalledTimes(1); // Heavy persistence guard never ticks.
      const failure = () => {
        throw new Error("Child failed");
      };
      if (close === "abort") f.controller.abort();
      else if (close === "dispose") owner.dispose();
      else if (close === "input") {
        f.child.handleInput.mockImplementation(failure);
        expect(() => owner.handleInput("x")).toThrow("Child failed");
      } else if (close === "render") {
        f.child.render.mockImplementation(failure);
        expect(() => owner.render(80)).toThrow("Child failed");
      } else if (close === "invalidate") {
        f.child.invalidate.mockImplementation(failure);
        expect(() => owner.invalidate()).toThrow("Child failed");
      } else if (close === "disposal") {
        f.child.dispose.mockImplementation(failure);
        expect(() => done()).toThrow("Child failed");
      } else done(close === "success" ? "saved" : undefined);
      expect(await pending).toBe(close === "success" ? "saved" : undefined);
      f.clean();
      expect(f.child.dispose).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(f.currentOwner).toHaveBeenCalledTimes(4);
      owner.handleInput("Late key");
      owner.dispose();
      expect(f.child.dispose).toHaveBeenCalledTimes(1);
    });

  it("rejects a liveness error and cleans up even when child disposal throws", async () => {
    const f = fixture();
    const pending = ownedUI(f.host, f.controller.signal, f.guard, f.currentOwner, () => f.child);
    const rejected = expect(pending).rejects.toThrow("Retired native owner");
    f.currentOwner.mockImplementation(() => {
      throw new Error("Retired native owner");
    });
    f.child.dispose.mockImplementation(() => {
      throw new Error("Disposal failed too");
    });
    vi.advanceTimersByTime(75);
    await rejected;
    f.clean();
    expect(f.guard).toHaveBeenCalledTimes(1);
    expect(f.child.dispose).toHaveBeenCalledTimes(1);
  });

  for (const failure of [
    "guard",
    "focus",
    "factory",
    "ownership admission",
    "focus admission",
    "abort admission",
    "mount",
  ] as const)
    it(`cleans all acquired resources on ${failure} failure`, async () => {
      const f = fixture();
      const fail = () => {
        throw new Error("Admission failed");
      };
      if (failure === "guard") f.guard.mockImplementation(fail);
      if (failure === "focus") vi.mocked(f.host.checkFocus).mockImplementation(fail);
      if (failure === "mount") vi.spyOn(f.host.tui, "showOverlay").mockImplementation(fail);
      const pending = ownedUI(f.host, f.controller.signal, f.guard, f.currentOwner, () => {
        if (failure === "factory") fail();
        if (failure === "ownership admission") f.currentOwner.mockImplementation(fail);
        if (failure === "focus admission") vi.mocked(f.host.checkFocus).mockImplementation(fail);
        if (failure === "abort admission") f.controller.abort();
        return f.child;
      });
      await expect(pending).rejects.toThrow();
      f.clean();
      expect(f.child.dispose).toHaveBeenCalledTimes(["guard", "focus", "factory"].includes(failure) ? 0 : 1);
      vi.advanceTimersByTime(500);
      expect(f.currentOwner.mock.calls.length).toBeLessThanOrEqual(1);
    });

  it("hides a handle admitted after a synchronous abort during mount without leaving a timer", async () => {
    const f = fixture();
    const show = f.host.tui.showOverlay.bind(f.host.tui);
    vi.spyOn(f.host.tui, "showOverlay").mockImplementation((...args) => {
      const handle = show(...args);
      f.controller.abort();
      return handle;
    });
    const pending = ownedUI(f.host, f.controller.signal, f.guard, f.currentOwner, () => f.child);
    expect(await pending).toBeUndefined();
    f.clean();
    expect(f.child.dispose).toHaveBeenCalledTimes(1);
  });
});
