import { describe, expect, it } from "vitest";
import { abortable } from "../src/abortable.js";

describe("abortable", () => {
  it("rejects an already-aborted wait without cancelling the underlying promise", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    let resolveUnderlying!: (value: string) => void;
    const underlying = new Promise<string>((resolve) => {
      resolveUnderlying = resolve;
    });

    await expect(abortable(underlying, controller.signal)).rejects.toThrow("caller cancelled");
    resolveUnderlying("still running");
    await expect(underlying).resolves.toBe("still running");
  });

  it("rejects the foreground wait when aborted but absorbs a late child failure", async () => {
    const controller = new AbortController();
    let rejectUnderlying!: (reason: Error) => void;
    const underlying = new Promise<string>((_resolve, reject) => {
      rejectUnderlying = reject;
    });

    const waiting = abortable(underlying, controller.signal);
    controller.abort(new Error("wait cancelled"));
    await expect(waiting).rejects.toThrow("wait cancelled");

    rejectUnderlying(new Error("late child failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
