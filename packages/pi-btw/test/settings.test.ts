import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  BTW_SETTINGS_FILE,
  DEFAULT_REMEMBER_THINKING_LEVEL_CHANGES,
  effectiveRememberThinkingLevelChanges,
  normalizeBtwSettings,
  readBtwSettings,
  updateBtwSettings,
} from "../src/settings.js";

async function withTempSettings(run: (settingsPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-btw-settings-test-"));
  try {
    await run(join(directory, "nested", BTW_SETTINGS_FILE));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("btw settings default remembering on without materializing a missing file", async () => {
  await withTempSettings(async (settingsPath) => {
    assert.equal(DEFAULT_REMEMBER_THINKING_LEVEL_CHANGES, true);
    assert.deepEqual(await readBtwSettings(settingsPath), { kind: "missing" });
    assert.equal(effectiveRememberThinkingLevelChanges({}), true);
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});

test("btw settings validate the optional remembered-change setting", () => {
  assert.deepEqual(normalizeBtwSettings({ rememberThinkingLevelChanges: true }), {
    rememberThinkingLevelChanges: true,
  });
  assert.deepEqual(normalizeBtwSettings({ rememberThinkingLevelChanges: false }), {
    rememberThinkingLevelChanges: false,
  });
  assert.equal(normalizeBtwSettings({ rememberThinkingLevelChanges: "yes" }), undefined);
});

test("btw settings preserve omitted thinking levels for backward compatibility", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ rememberThinkingLevelChanges: false }, { settingsPath });
    assert.deepEqual(await readBtwSettings(settingsPath), {
      kind: "loaded",
      settings: { rememberThinkingLevelChanges: false },
    });
  });
});

test("btw settings updates preserve unknown fields and create only on explicit save", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ thinkingLevel: "low", rememberThinkingLevelChanges: true }, { settingsPath });
    const first = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(first, { thinkingLevel: "low", rememberThinkingLevelChanges: true });

    await writeFile(settingsPath, '{"future":{"kept":true},"thinkingLevel":"low"}\n', "utf8");
    await updateBtwSettings({ thinkingLevel: "high" }, { settingsPath });
    const updated = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(updated, { future: { kept: true }, thinkingLevel: "high" });
  });
});

test("btw settings reject malformed or invalid documents without changing their bytes", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ thinkingLevel: "low" }, { settingsPath });
    for (const contents of ["{broken", '{"thinkingLevel":"huge"}\n']) {
      await writeFile(settingsPath, contents, "utf8");
      await assert.rejects(
        updateBtwSettings({ thinkingLevel: "high" }, { settingsPath }),
        /pi-btw settings.*(?:invalid|JSON)/i,
      );
      assert.equal(await readFile(settingsPath, "utf8"), contents);
    }
  });
});

test("btw settings reject invalid UTF-8 without rewriting its bytes", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ thinkingLevel: "low" }, { settingsPath });
    const contents = Buffer.concat([
      Buffer.from('{"future":"', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('","thinkingLevel":"low"}\n', "utf8"),
    ]);
    await writeFile(settingsPath, contents);

    const loaded = await readBtwSettings(settingsPath);
    assert.equal(loaded.kind, "invalid");
    assert.match(loaded.kind === "invalid" ? loaded.reason : "", /UTF-8/i);
    await assert.rejects(updateBtwSettings({ thinkingLevel: "high" }, { settingsPath }), /UTF-8/i);
    assert.deepEqual(await readFile(settingsPath), contents);
  });
});

test("btw settings bound file reads and preserve oversized documents", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ thinkingLevel: "low" }, { settingsPath });
    const contents = Buffer.alloc(128 * 1024, 0x20);
    await writeFile(settingsPath, contents);

    const loaded = await readBtwSettings(settingsPath);
    assert.equal(loaded.kind, "invalid");
    assert.match(loaded.kind === "invalid" ? loaded.reason : "", /exceeds .* bytes/i);
    await assert.rejects(updateBtwSettings({ thinkingLevel: "high" }, { settingsPath }), /exceeds .* bytes/i);
    assert.deepEqual(await readFile(settingsPath), contents);
  });
});

test("btw settings refuse to publish a document larger than their read boundary", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ thinkingLevel: "low" }, { settingsPath });
    const contents = `${JSON.stringify({
      future: Array.from({ length: 20_000 }, () => 0),
      thinkingLevel: "low",
    })}\n`;
    assert.ok(Buffer.byteLength(contents, "utf8") < 64 * 1024);
    await writeFile(settingsPath, contents, "utf8");

    await assert.rejects(
      updateBtwSettings({ thinkingLevel: "high" }, { settingsPath }),
      /settings document exceeds .* bytes/i,
    );
    assert.equal(await readFile(settingsPath, "utf8"), contents);
  });
});

test("btw settings diagnostics never echo malformed document contents", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ thinkingLevel: "low" }, { settingsPath });
    const sensitiveMarker = "mock-sensitive-token";
    await writeFile(settingsPath, sensitiveMarker, "utf8");

    const loaded = await readBtwSettings(settingsPath);
    assert.equal(loaded.kind, "invalid");
    const reason = loaded.kind === "invalid" ? loaded.reason : "";
    assert.match(reason, /invalid JSON/i);
    assert.doesNotMatch(reason, new RegExp(sensitiveMarker));
    await assert.rejects(updateBtwSettings({ thinkingLevel: "high" }, { settingsPath }), (error: unknown) => {
      assert.match(String(error), /invalid JSON/i);
      assert.doesNotMatch(String(error), new RegExp(sensitiveMarker));
      return true;
    });
  });
});

test("btw settings atomic publication failure preserves the previous document", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateBtwSettings({ thinkingLevel: "low" }, { settingsPath });
    const before = await readFile(settingsPath, "utf8");
    await assert.rejects(
      updateBtwSettings(
        { thinkingLevel: "high" },
        {
          settingsPath,
          beforeRename: async () => {
            throw new Error("publication failed");
          },
        },
      ),
      /publication failed/,
    );
    assert.equal(await readFile(settingsPath, "utf8"), before);
  });
});

test("btw settings serialize rapid updates in invocation order and recover after failure", async () => {
  await withTempSettings(async (settingsPath) => {
    let releaseFirst!: () => void;
    let markFirstReached!: () => void;
    const firstReached = new Promise<void>((resolve) => {
      markFirstReached = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = updateBtwSettings(
      { thinkingLevel: "low" },
      {
        settingsPath,
        beforeRename: async () => {
          markFirstReached();
          await firstGate;
        },
      },
    );
    const second = updateBtwSettings({ thinkingLevel: "medium" }, { settingsPath });
    const coordinatedRead = readBtwSettings(settingsPath);
    await firstReached;
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(await coordinatedRead, {
      kind: "loaded",
      settings: { thinkingLevel: "medium" },
    });
    assert.equal(
      (JSON.parse(await readFile(settingsPath, "utf8")) as { thinkingLevel: string }).thinkingLevel,
      "medium",
    );

    await assert.rejects(
      updateBtwSettings(
        { thinkingLevel: "high" },
        { settingsPath, beforeRename: async () => Promise.reject(new Error("failed once")) },
      ),
      /failed once/,
    );
    await updateBtwSettings({ thinkingLevel: "max" }, { settingsPath });
    assert.equal((JSON.parse(await readFile(settingsPath, "utf8")) as { thinkingLevel: string }).thinkingLevel, "max");
  });
});

test("btw settings abort before publication leaves the canonical path absent", async () => {
  await withTempSettings(async (settingsPath) => {
    const controller = new AbortController();
    await assert.rejects(
      updateBtwSettings(
        { thinkingLevel: "high" },
        {
          settingsPath,
          signal: controller.signal,
          beforeRename: async () => controller.abort(new Error("settings disposed")),
        },
      ),
      /settings disposed/,
    );
    await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
  });
});
