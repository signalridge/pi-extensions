import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import { runRename } from "../src/rename.js";
import { selectOperationRoute } from "../src/routes.js";
import type { LspServerAdapter } from "../src/types.js";
import { messages, navigationAdapter, text } from "./navigation-fixture.js";

const ctx = { ui: { setStatus() {} } };
const MAIN = 'package main\n\nfunc greet(name string) string { return name }\n\nfunc main() { greet("x") }\n';
const OTHER = "package main\n\nvar _ = greet\n";

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-rename-"));
  writeFileSync(path.join(root, "main.go"), MAIN);
  writeFileSync(path.join(root, "other.go"), OTHER);
  return {
    root,
    main: path.join(root, "main.go"),
    other: path.join(root, "other.go"),
    log: path.join(root, "log"),
  };
}

function rename(
  root: string,
  adapter: LspServerAdapter,
  params: { newName?: string; apply?: boolean; symbol?: string } = {},
) {
  return runRename(
    selectOperationRoute([adapter], { root, path: "main.go" }, "rename"),
    {
      line: 3,
      symbol: params.symbol ?? "greet",
      newName: params.newName ?? "welcome",
      apply: params.apply,
    },
    5_000,
    undefined,
    ctx,
    "test",
  );
}

test("rename previews every workspace edit by default and writes them only with apply: true", async () => {
  const { root, main, other, log } = workspace();
  const adapter = navigationAdapter("navigator", "navigation", log);
  try {
    const preview = await rename(root, adapter);
    assert.equal(
      text(preview),
      [
        'navigator rename preview for main.go:3:6 (greet) to "welcome": 3 edit(s) in 2 file(s). ' +
          "Nothing was written; repeat the call with apply: true to write these edits.",
        "",
        "main.go (2 edit(s))",
        '  3:6 "greet" -> "welcome"',
        '  5:15 "greet" -> "welcome"',
        "",
        "other.go (1 edit(s))",
        '  3:9 "greet" -> "welcome"',
      ].join("\n"),
    );
    assert.deepEqual(preview.details, {
      root,
      path: "main.go",
      server: "navigator",
      position: { line: 3, column: 6 },
      newName: "welcome",
      apply: false,
      changed: true,
      outcome: "preview",
      files: [
        { path: "main.go", edits: 2 },
        { path: "other.go", edits: 1 },
      ],
    });
    assert.equal(readFileSync(main, "utf8"), MAIN);
    assert.equal(readFileSync(other, "utf8"), OTHER);
    assert.deepEqual(messages(log).find(({ method }) => method === "textDocument/rename")?.params, {
      textDocument: { uri: pathToFileURL(main).href },
      position: { line: 2, character: 5 },
      newName: "welcome",
    });

    const applied = await rename(root, adapter, { apply: true });
    assert.match(
      text(applied),
      /^navigator renamed main.go:3:6 \(greet\) to "welcome": applied 3 edit\(s\) in 2 file\(s\)\./,
    );
    assert.equal((applied.details as { outcome: string }).outcome, "updated");
    assert.equal(readFileSync(main, "utf8"), MAIN.replaceAll("greet", "welcome"));
    assert.equal(readFileSync(other, "utf8"), OTHER.replaceAll("greet", "welcome"));

    const unchanged = await rename(root, adapter, {
      symbol: "welcome",
      newName: "welcome",
      apply: true,
    });
    assert.equal(text(unchanged), 'navigator rename of main.go:3:6 (welcome) to "welcome" produced no changes.');
    assert.equal((unchanged.details as { outcome: string }).outcome, "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename rejects unsafe workspace edits as a whole, even when part of the edit is valid", async () => {
  const { root, main, other, log } = workspace();
  const outside = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-rename-outside-"));
  const outsideFile = path.join(outside, "outside.go");
  writeFileSync(outsideFile, "package outside\n");
  writeFileSync(path.join(root, "notes.txt"), "greet\n");
  const withExtra = (uri: string) => {
    const adapter = navigationAdapter("navigator", "navigation", log);
    adapter.env = { ...adapter.env, PI_LSP_TEST_RENAME_EXTRA_URI: uri };
    return adapter;
  };
  const cases: Array<[LspServerAdapter, RegExp]> = [
    [
      navigationAdapter("navigator", "rename-resource", log),
      /^Error: lsp_rename wrote nothing: navigator returned file operations that lsp_rename does not apply: rename main\.go to main_renamed\.go\. Move or create those files separately, then rename again\.$/,
    ],
    [withExtra(pathToFileURL(outsideFile).href), /^Error: lsp_rename wrote nothing: .*outside workspace root/],
    [
      withExtra(pathToFileURL(path.join(root, "notes.txt")).href),
      /^Error: lsp_rename wrote nothing: Expected a navigator supported file/,
    ],
    [
      withExtra("untitled:Untitled-1"),
      /^Error: lsp_rename wrote nothing: navigator returned an edit for a non-file URI: untitled:Untitled-1/,
    ],
    [
      navigationAdapter("navigator", "rename-invalid-range", log),
      /^Error: lsp_rename wrote nothing: navigator returned edit range 1000:1-1000:2, which does not exist in (main|other)\.go; the file may have changed/,
    ],
  ];
  try {
    for (const [adapter, expected] of cases) {
      for (const apply of [false, true]) {
        await assert.rejects(rename(root, adapter, { apply }), expected);
        assert.equal(readFileSync(main, "utf8"), MAIN);
        assert.equal(readFileSync(other, "utf8"), OTHER);
        assert.equal(readFileSync(outsideFile, "utf8"), "package outside\n");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rename requires renameProvider and validates arguments before starting a server", async () => {
  const { root, log } = workspace();
  try {
    await assert.rejects(
      rename(root, navigationAdapter("hover-only", "navigation-hover-only", log)),
      /No configured LSP server for main.go advertises renameProvider, which rename requires\. Servers without it: hover-only\./,
    );
    rmSync(log);
    const adapter = navigationAdapter("navigator", "navigation", log);
    await assert.rejects(rename(root, adapter, { newName: "  " }), /newName must not be blank/);
    await assert.rejects(rename(root, adapter, { symbol: "absent" }), /Symbol "absent" was not found on line 3/);
    assert.equal(existsSync(log), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A rename whose server is replaced by a gate, so tests can act between its phases. */
function gatedRename(root: string, edit: (main: string, other: string) => unknown) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const entered = new Promise<void>((resolve) => {
    requested = resolve;
  });
  vi.spyOn(LspClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "didOpen").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "didClose").mockImplementation(() => true);
  vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "hasCapability").mockReturnValue(true);
  vi.spyOn(LspClient.prototype, "requestResult").mockImplementation(async () => {
    requested();
    await released;
    return edit(pathToFileURL(path.join(root, "main.go")).href, pathToFileURL(path.join(root, "other.go")).href);
  });
  const adapter = navigationAdapter("gated", "unused", path.join(root, "log"));
  return { adapter, entered, release };
}

const greetEdits = (main: string, other: string) => ({
  changes: {
    [main]: [
      {
        range: {
          start: { line: 2, character: 5 },
          end: { line: 2, character: 10 },
        },
        newText: "welcome",
      },
      {
        range: {
          start: { line: 4, character: 14 },
          end: { line: 4, character: 19 },
        },
        newText: "welcome",
      },
    ],
    [other]: [
      {
        range: {
          start: { line: 2, character: 8 },
          end: { line: 2, character: 13 },
        },
        newText: "welcome",
      },
    ],
  },
});

test("rename verifies every file under Pi's mutation queue before writing any of them", async () => {
  const { root, main, other } = workspace();
  const gated = gatedRename(root, greetEdits);
  let releaseQueue!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  // A cooperating writer (the native edit tool) holds other.go while the rename computes.
  const writer = withFileMutationQueue(other, async () => {
    await held;
    writeFileSync(other, `${OTHER}// saved by another tool\n`);
  });
  try {
    const running = rename(root, gated.adapter, { apply: true });
    await gated.entered;
    gated.release();
    // Planning snapshots other.go synchronously once the request settles; the
    // rename then waits on the queue the writer holds.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseQueue();
    await writer;
    await assert.rejects(
      running,
      /File changed while computing LSP rename edits; left unchanged: .*other\.go\. Retry the rename\./,
    );
    assert.equal(readFileSync(main, "utf8"), MAIN, "a stale sibling must not leave a partial rename");
    assert.equal(readFileSync(other, "utf8"), `${OTHER}// saved by another tool\n`);
  } finally {
    releaseQueue();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename rejects a target file changed while the server computed the edit", async () => {
  const { root, main, other } = workspace();
  const gated = gatedRename(root, greetEdits);
  try {
    const running = rename(root, gated.adapter, { apply: true });
    await gated.entered;
    const saved = MAIN.replace("return name", "return name ");
    writeFileSync(main, saved);
    gated.release();
    await assert.rejects(running, /File changed while computing LSP rename edits; left unchanged: .*main\.go/);
    assert.equal(readFileSync(main, "utf8"), saved);
    assert.equal(readFileSync(other, "utf8"), OTHER);
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const apply of [false, true]) {
  test(`rename rejects a same-length secondary save before the server responds (apply=${apply})`, async () => {
    const { root, main, other } = workspace();
    const gated = gatedRename(root, greetEdits);
    try {
      const running = rename(root, gated.adapter, { apply });
      await gated.entered;
      const saved = OTHER.replace("greet", "other");
      assert.equal(saved.length, OTHER.length);
      writeFileSync(other, saved);
      gated.release();
      await assert.rejects(
        running,
        /lsp_rename wrote nothing: File changed while computing LSP rename edits.*other\.go/,
      );
      assert.equal(readFileSync(main, "utf8"), MAIN);
      assert.equal(readFileSync(other, "utf8"), saved);
    } finally {
      gated.release();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`rename rejects a newly created returned target without a pre-request baseline (apply=${apply})`, async () => {
    const { root, main, other } = workspace();
    rmSync(other);
    const gated = gatedRename(root, greetEdits);
    try {
      const running = rename(root, gated.adapter, { apply });
      await gated.entered;
      writeFileSync(other, OTHER);
      gated.release();
      await assert.rejects(running, /lsp_rename wrote nothing: other\.go has no pre-request rename baseline/);
      assert.equal(readFileSync(main, "utf8"), MAIN);
      assert.equal(readFileSync(other, "utf8"), OTHER);
    } finally {
      gated.release();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a cancelled rename never writes its computed edits", async () => {
  const { root, main, other } = workspace();
  const gated = gatedRename(root, greetEdits);
  vi.spyOn(LspClient.prototype, "close").mockImplementation(() => {});
  const controller = new AbortController();
  try {
    const running = runRename(
      selectOperationRoute([gated.adapter], { root, path: "main.go" }, "rename"),
      { line: 3, symbol: "greet", newName: "welcome", apply: true },
      5_000,
      controller.signal,
      ctx,
      "test",
    );
    await gated.entered;
    controller.abort();
    gated.release();
    await assert.rejects(running, /gated LSP request aborted/);
    assert.equal(readFileSync(main, "utf8"), MAIN);
    assert.equal(readFileSync(other, "utf8"), OTHER);
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
