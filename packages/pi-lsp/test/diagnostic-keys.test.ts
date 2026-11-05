import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import type { LspServerAdapter } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/diagnostics-server.mjs", import.meta.url));

for (const scenario of ["push-alternate-uri", "pull-alternate-uri"]) {
  test(`${scenario}: publication, alias reads, concurrent waiters and timeout disposal`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lsp-keys-"));
    const ready = path.join(root, "fixture.ready");
    const adapter: LspServerAdapter = {
      name: "fixture",
      isDefault: false,
      defaultCommand: { command: process.execPath, args: [fixture, scenario] },
      env: { PI_LSP_TEST_READY: ready },
      extensions: [".ts"],
      skipDirectories: new Set(),
      missingCommandHint: "",
      isSupportedFile: () => true,
      languageIdFor: () => "typescript",
      diagnosticsSettleMs: 10,
      pullDiagnosticsGraceMs: 100,
    };
    const client = new LspClient(adapter, adapter.defaultCommand, root, 200);
    const startReady = async () => {
      // These assertions concern protocol timers, not Node cold-start latency.
      rmSync(ready, { force: true });
      await client.start();
      const deadline = Date.now() + 3000;
      while (!existsSync(ready)) {
        assert.ok(Date.now() < deadline, "fixture did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const uri = "file:///C:/dir/a-b%23%3F%25%E6%BC%A2.ts";
    const alias = "file:///c%3a/dir/a%2Db%23%3f%25%e6%bc%a2.ts";
    try {
      await startReady();
      await client.initialize(root);
      // An expired waiter must not remain registered when a later alias publishes.
      if (scenario.startsWith("push")) await assert.rejects(client.diagnostics(uri), /before timeout/);
      const pending = [client.diagnostics(uri), client.diagnostics(alias)];
      client.didOpen(uri, "", "typescript");
      for (const diagnostics of await Promise.all(pending)) {
        assert.deepEqual(
          diagnostics.map(({ message }) => message),
          ["alternate uri diagnostic"],
        );
      }
      assert.deepEqual(
        (await client.diagnostics(alias)).map(({ message }) => message),
        ["alternate uri diagnostic"],
      );
      // Closing must reject all aliases and dispose their timers before restart.
      client.close();
      await startReady();
      await client.initialize(root);
      const abandoned = client.diagnostics(alias);
      const rejected = assert.rejects(abandoned, /cancelled/);
      client.close();
      await rejected;
      await startReady();
      await client.initialize(root);
      if (scenario.startsWith("push")) await assert.rejects(client.diagnostics(uri), /before timeout/);
      else assert.deepEqual(await client.diagnostics(uri), []);
    } finally {
      await client.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
