import assert from "node:assert/strict";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import { runRename } from "../src/rename.js";
import { selectOperationRoute } from "../src/routes.js";
import * as runner from "../src/runner.js";
import { LspSessionScope } from "../src/session-lifecycle.js";
import { navigationAdapter, text } from "./navigation-fixture.js";

const fault = vi.hoisted(() => ({ mode: "none", writes: 0, skip: 0 }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (fault.mode === "short" && fault.skip-- <= 0) {
        if (fault.writes++ > 0) throw new Error("ENOSPC");
        const [fd, buffer, offset, , position] = args as [number, Buffer, number, number, number];
        return fs.writeSync(fd, buffer, offset, 3, position);
      }
      return fs.writeSync(...args);
    },
    ftruncateSync: (...args: Parameters<typeof fs.ftruncateSync>) => {
      if (fault.mode === "truncate") throw new Error("truncate failed");
      return fs.ftruncateSync(...args);
    },
  };
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(names = ["a.go", "b.go", "c.go"]) {
  const root = mkdtempSync(path.join(tmpdir(), "rename-safety-"));
  for (const name of names) writeFileSync(path.join(root, name), "greet\n");
  const adapter = navigationAdapter("fixture", "unused", path.join(root, "log"));
  vi.spyOn(LspClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "didOpen").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "didClose").mockReturnValue(true);
  vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "close").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "hasCapability").mockReturnValue(true);
  vi.spyOn(LspClient.prototype, "requestResult").mockResolvedValue({
    changes: Object.fromEntries(
      names.map((name) => [
        pathToFileURL(path.join(root, name)).href,
        [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "welcome" }],
      ]),
    ),
  });
  return {
    root,
    run: (signal?: AbortSignal, line = 1, apply = true) =>
      runRename(
        selectOperationRoute([adapter], { root, path: "a.go" }, "rename"),
        { line, symbol: "greet", newName: "welcome", apply },
        5000,
        signal,
        { ui: { setStatus() {} } },
        "test",
      ),
    dispose() {
      fault.mode = "none";
      fault.writes = 0;
      fault.skip = 0;
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("all-target preflight rejects existing corruption before requesting any queue", async () => {
  const f = fixture();
  let calls = 0;
  vi.spyOn(runner, "fileMutationQueue").mockImplementation(() => {
    // Planning has completed; inject corruption before the explicit write preflight.
    writeFileSync(path.join(f.root, "c.go"), "other\n");
    return (file, run) => {
      calls++;
      return withFileMutationQueue(file, run);
    };
  });
  try {
    await assert.rejects(f.run(), /changed/);
    assert.equal(calls, 0);
    for (const name of ["a.go", "b.go"]) assert.equal(readFileSync(path.join(f.root, name), "utf8"), "greet\n");
    assert.equal(readFileSync(path.join(f.root, "c.go"), "utf8"), "other\n");
  } finally {
    f.dispose();
  }
});

test("hardlink aliases are rejected in planning before any of three targets changes", async () => {
  const f = fixture();
  try {
    rmSync(path.join(f.root, "b.go"));
    linkSync(path.join(f.root, "a.go"), path.join(f.root, "b.go"));
    await assert.rejects(f.run(), /wrote nothing: .*same file identity/);
    for (const name of ["a.go", "b.go", "c.go"]) assert.equal(readFileSync(path.join(f.root, name), "utf8"), "greet\n");
  } finally {
    f.dispose();
  }
});

for (const cancel of [false, true]) {
  test(`retarget while first native queue is held cannot self-cycle; scope drains (cancel=${cancel})`, async () => {
    const f = fixture(["a.go", "b.go"]);
    const held = gate();
    const queued = gate();
    const scope = new LspSessionScope();
    const a = path.join(f.root, "a.go");
    const b = path.join(f.root, "b.go");
    const writer = withFileMutationQueue(a, () => held.promise);
    vi.spyOn(runner, "fileMutationQueue").mockReturnValue((file, run) => {
      if (file === realpathSync(a)) queued.release();
      return withFileMutationQueue(file, run);
    });
    try {
      const running = scope.run(undefined, f.run);
      const result = running.then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
      await queued.promise;
      renameSync(b, path.join(f.root, "original-b"));
      symlinkSync(a, b);
      let drained = false;
      const closing = cancel
        ? scope.close().then(() => {
            drained = true;
          })
        : undefined;
      await Promise.resolve();
      assert.equal(drained, false, "accepted callback is still owned while the native queue is blocked");
      held.release();
      await writer;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        result,
        new Promise<string>((resolve) => {
          deadline = setTimeout(() => resolve("SELF_CYCLE"), 500);
        }),
      ]);
      clearTimeout(deadline);
      assert.match(settled, /changed|aborted/);
      await (closing ?? scope.close());
      assert.equal(readFileSync(a, "utf8"), cancel ? "greet\n" : "welcome\n");
      assert.match(settled, new RegExp(`Files already updated by this rename: ${cancel ? "none" : "a\\.go"}`));
      assert.equal(readFileSync(path.join(f.root, "original-b"), "utf8"), "greet\n");
    } finally {
      held.release();
      f.dispose();
    }
  });
}

for (const cancel of [false, true]) {
  test(`async native key registration retarget cannot self-cycle (cancel=${cancel})`, async () => {
    const f = fixture(["a.go", "b.go"]);
    const scope = new LspSessionScope();
    const a = path.join(f.root, "a.go");
    const b = path.join(f.root, "b.go");
    let calls = 0;
    let closing: Promise<void> | undefined;
    vi.spyOn(runner, "fileMutationQueue").mockReturnValue((file, run) => {
      if (++calls === 2) {
        // This runs after the extension's synchronous admission but BEFORE the
        // real host queue's deferred registration/realpath, with no host patch.
        queueMicrotask(() => {
          renameSync(b, path.join(f.root, "original-b"));
          symlinkSync(a, b);
          if (cancel) closing = scope.close();
        });
      }
      return withFileMutationQueue(file, run);
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = scope.run(undefined, f.run).then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
      const settled = await Promise.race([
        result,
        new Promise<string>((resolve) => {
          deadline = setTimeout(() => resolve("SELF_CYCLE"), 500);
        }),
      ]);
      assert.match(settled, /changed|aborted/);
      assert.match(settled, /Files already updated by this rename: a\.go/);
      assert.doesNotMatch(settled, /Possibly partially modified target/);
      await (closing ?? scope.close());
      assert.equal(calls, 2);
      assert.equal(readFileSync(a, "utf8"), "welcome\n");
      assert.equal(readFileSync(path.join(f.root, "original-b"), "utf8"), "greet\n");
    } finally {
      clearTimeout(deadline);
      f.dispose();
    }
  });
}

for (const mode of ["short", "truncate"]) {
  test(`rename names the possibly partially modified current target after ${mode} failure`, async () => {
    const f = fixture();
    try {
      fault.mode = mode;
      await assert.rejects(
        f.run(),
        /Possibly partially modified target: a\.go\. Files already updated by this rename: none/,
      );
      assert.equal(readFileSync(path.join(f.root, "a.go"), "utf8"), mode === "short" ? "welet\n" : "welcome\n");
      for (const name of ["b.go", "c.go"]) assert.equal(readFileSync(path.join(f.root, name), "utf8"), "greet\n");
    } finally {
      f.dispose();
    }
  });
}

test("partial-write reporting separates the current target from completed siblings", async () => {
  const f = fixture();
  try {
    fault.mode = "short";
    fault.skip = 1;
    await assert.rejects(
      f.run(),
      /Possibly partially modified target: b\.go\. Files already updated by this rename: a\.go/,
    );
    assert.equal(readFileSync(path.join(f.root, "a.go"), "utf8"), "welcome\n");
    assert.equal(readFileSync(path.join(f.root, "b.go"), "utf8"), "welet\n");
    assert.equal(readFileSync(path.join(f.root, "c.go"), "utf8"), "greet\n");
  } finally {
    f.dispose();
  }
});

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`rename preview and apply preserve ${JSON.stringify(newline)} newline bytes`, async () => {
    const f = fixture(["a.go"]);
    const file = path.join(f.root, "a.go");
    const original = `header${newline}greet${newline}`;
    try {
      writeFileSync(file, original);
      vi.mocked(LspClient.prototype.requestResult).mockResolvedValue({
        changes: {
          [pathToFileURL(file).href]: [
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: "welcome" },
          ],
        },
      });
      assert.match(text(await f.run(undefined, 2, false)), /2:1 "greet" -> "welcome"/);
      assert.equal(readFileSync(file, "utf8"), original);
      await f.run(undefined, 2);
      assert.equal(readFileSync(file, "utf8"), original.replace("greet", "welcome"));
    } finally {
      f.dispose();
    }
  });
}

// Keep the result helper in this fixture exercised as well as the error paths.
test("independent files still apply through the native queues", async () => {
  const f = fixture();
  try {
    assert.match(text(await f.run()), /applied 3 edit\(s\) in 3 file\(s\)/);
  } finally {
    f.dispose();
  }
});
