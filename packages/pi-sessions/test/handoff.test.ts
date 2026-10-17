import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { HANDOFF_TYPE, readHandoff } from "../src/handoff.js";
import { Owner } from "../src/ownership.js";
import { SUMMARY_BYTES } from "../src/text.js";
import { deferred, fixture, model } from "./support.js";

describe("native reviewed handoff", () => {
  test.each([false, true])(
    "durable custom-only linked destination; memory source=%s; no model turn",
    async (memory) => {
      const f = await fixture({ memory });
      try {
        f.editorResults.push("user: reviewed context", "Human approved summary\nKeep SDK public.");
        await f.command("handoff", "continue implementation");
        const destination = f.runtime.session.sessionManager;
        expect(destination).not.toBe(f.manager);
        expect(f.withSessions).toBe(1);
        expect(f.generationCalls).toBe(1);
        expect(f.destinationTurns).toBe(0);
        expect(f.editorText).toBe("Human approved summary\nKeep SDK public.");
        const saved = destination.getSessionFile();
        expect(saved && existsSync(saved)).toBe(true);
        expect(statSync(saved as string).mode & 0o777).toBe(0o600);
        const reopened = SessionManager.open(saved as string);
        expect(reopened.buildSessionContext().messages).toEqual([]);
        const custom = reopened.getBranch().find((e) => e.type === "custom" && e.customType === HANDOFF_TYPE);
        const record = custom?.type === "custom" ? readHandoff(custom.data) : undefined;
        expect(record?.summary).toBe(f.editorText);
        expect(record?.sourceSessionId).toBe(f.manager.getSessionId());
        const parent = reopened.getHeader()?.parentSession;
        expect(parent).toBe(record?.parent.path);
        expect(parent && existsSync(parent)).toBe(true);
        if (memory) {
          expect(statSync(parent as string).mode & 0o777).toBe(0o600);
          expect(statSync(dirname(parent as string)).mode & 0o777).toBe(0o700);
          expect(SessionManager.open(parent as string).getBranch()).toEqual(f.manager.getBranch());
        } else expect(parent).toBe(f.manager.getSessionFile());
        // Reload/open the durable custom entry through native switching; no automatic editor overwrite.
        f.editorText = "later draft";
        await f.runtime.switchSession(saved as string);
        expect(f.editorText).toBe("later draft");
        f.editorResults.push("Recovered and edited summary");
        await f.command("handoff", "recover");
        expect(f.editorText).toBe("Recovered and edited summary");
        expect(f.confirmations).toContain("Inspect saved handoff?");
        expect(f.confirmations).toContain("Replace current unsent draft?");
        expect(f.destinationTurns).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );

  test("declining generation offers truly empty manual editor, no authentication", async () => {
    const f = await fixture();
    try {
      const registry = f.source.extensionRunner.createCommandContext().modelRegistry;
      const auth = vi.spyOn(registry, "getApiKeyAndHeaders");
      f.confirmationResults.push(false, true, true, true, true);
      f.editorResults.push("Manual human summary");
      await f.command("handoff", "continue manually");
      expect(f.editors[0].prefill).toBe("");
      expect(auth).not.toHaveBeenCalled();
      expect(f.editorText).toBe("Manual human summary");
      expect(f.generationCalls).toBe(0);
      expect(f.destinationTurns).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("model unavailable offers manual editor without raw auth errors", async () => {
    const f = await fixture();
    try {
      f.source.extensionRunner.createCommandContext().modelRegistry.getApiKeyAndHeaders = async () => {
        throw new Error("provider error contains password=PRIVATE");
      };
      f.editorResults.push("reviewed context", "manual after auth failure");
      await f.command("handoff", "continue");
      expect(f.editors[1].prefill).toBe("");
      expect(f.notices.join("\n")).not.toContain("PRIVATE");
      expect(f.generationCalls).toBe(0);
      expect(f.destinationTurns).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test.each(["excerpt", "review", "final", "draft", "oversize"])(
    "%s cancellation rejects before creation and preserves source",
    async (point) => {
      const f = await fixture();
      try {
        f.editorResults.push(
          point === "excerpt" ? undefined : "reviewed context",
          point === "review" ? undefined : point === "oversize" ? "中".repeat(SUMMARY_BYTES) : "approved summary",
        );
        if (point === "draft") f.confirmationResults.push(true, true, false);
        if (point === "final") f.confirmationResults.push(true, true, true, false);
        await f.command("handoff", "continue");
        expect(f.runtime.session).toBe(f.source);
        expect(f.editorText).toBe("original unsent draft");
        expect(f.withSessions).toBe(0);
        expect(f.destinationTurns).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
  );

  test("empty goal opens human input; recovery reserved exactly", async () => {
    const f = await fixture();
    try {
      f.editorResults.push("reviewed excerpt", "summary");
      await f.command("handoff");
      const custom = f.runtime.session.sessionManager.getBranch().find((e) => e.type === "custom");
      expect(custom?.type === "custom" && readHandoff(custom.data)?.goal).toBe("continue goal");
    } finally {
      await f.cleanup();
    }
  });

  test("native veto cleans in-memory snapshot exactly; no replacement or draft change", async () => {
    let snapshotPath = "";
    const f = await fixture({
      memory: true,
      extra: (pi) =>
        pi.on("session_before_switch", (_event, ctx) => {
          // Parent is passed to native newSession (not exposed in event), captured by public command wrapper below.
          expect(ctx.sessionManager.getSessionId()).toBe(f.manager.getSessionId());
          return { cancel: true };
        }),
    });
    try {
      const native = f.runtime.newSession.bind(f.runtime);
      vi.spyOn(f.runtime, "newSession").mockImplementation(async (opts) => {
        snapshotPath = opts?.parentSession ?? "";
        expect(existsSync(snapshotPath)).toBe(true);
        return native(opts);
      });
      f.editorResults.push("context", "summary");
      await f.command("handoff", "continue");
      expect(snapshotPath).toContain("pi-sessions-parent-");
      expect(existsSync(dirname(snapshotPath))).toBe(false);
      expect(f.runtime.session).toBe(f.source);
      expect(f.editorText).toBe("original unsent draft");
      expect(f.destinationTurns).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test.each(["setup", "prefill", "rebind"])(
    "partial %s failure retains resumable parent and never submits",
    async (point) => {
      const f = await fixture({ memory: true });
      let parent = "";
      try {
        const native = f.runtime.newSession.bind(f.runtime);
        vi.spyOn(f.runtime, "newSession").mockImplementation(async (opts) => {
          parent = opts?.parentSession ?? "";
          f.track(parent);
          return native({
            ...opts,
            setup: async (manager) => {
              if (point === "setup")
                vi.spyOn(manager, "appendCustomEntry").mockImplementation(() => {
                  throw new Error("disk failed");
                });
              await opts?.setup?.(manager);
            },
          });
        });
        if (point === "prefill")
          f.ui.setEditorText = () => {
            throw new Error("editor unavailable");
          };
        if (point === "rebind")
          f.runtime.setRebindSession(async () => {
            throw new Error("rebind unavailable");
          });
        f.editorResults.push("context", "approved summary");
        await f.command("handoff", "continue");
        expect(f.runtime.session).not.toBe(f.source);
        expect(existsSync(parent)).toBe(true);
        expect(SessionManager.open(parent).getBranch()).toEqual(f.manager.getBranch());
        expect(f.destinationTurns).toBe(0);
        if (point === "prefill") expect(f.notices.join("\n")).toContain("prefill failed");
        if (point === "setup") {
          const destination = f.runtime.session.sessionFile as string;
          expect(existsSync(destination)).toBe(true);
          expect(SessionManager.open(destination).getHeader()?.parentSession).toBe(parent);
          expect(f.notices.join("\n")).toContain(parent);
        }
      } finally {
        await f.cleanup();
      }
    },
  );

  test("destination changed model is reported and never submitted", async () => {
    const f = await fixture({ destinationModel: { ...model, id: "different" } });
    try {
      f.editorResults.push("context", "human approved summary");
      await f.command("handoff", "continue");
      expect(f.notices.join("\n")).toContain("Destination model changed or is missing");
      expect(f.destinationTurns).toBe(0);
      expect(f.runtime.session.sessionManager.buildSessionContext().messages).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("recovery decline never overwrites a later draft or creates another session", async () => {
    const f = await fixture();
    try {
      f.editorResults.push("context", "approved summary");
      await f.command("handoff", "continue");
      const manager = f.runtime.session.sessionManager;
      f.editorText = "later draft";
      f.confirmationResults.push(true, false);
      f.editorResults.push("reviewed recovery");
      await f.command("handoff", "recover");
      expect(f.editorText).toBe("later draft");
      expect(f.runtime.session.sessionManager).toBe(manager);
      expect(f.destinationTurns).toBe(0);
      expect(readFileSync(manager.getSessionFile() as string, "utf8")).toContain("approved summary");
    } finally {
      await f.cleanup();
    }
  });
});

describe("handoff ownership fences", () => {
  test.each(["branch", "entry-data", "model", "shutdown"])(
    "%s during auth retires generation; late auth cannot create",
    async (change) => {
      const f = await fixture();
      const auth = deferred<{ ok: true; apiKey: string }>();
      const entered = deferred<void>();
      try {
        const ctx = f.source.extensionRunner.createCommandContext();
        ctx.modelRegistry.getApiKeyAndHeaders = () => {
          entered.resolve();
          return auth.promise;
        };
        f.editorResults.push("context", "must never be used");
        const running = f.command("handoff", "continue");
        await entered.promise;
        if (change === "branch") {
          const root = f.manager.getBranch()[0].id;
          f.manager.branch(root);
          f.manager.appendCustomEntry("same messages, other native branch");
        } else if (change === "entry-data") {
          const latest = f.manager.getLeafEntry();
          if (latest) latest.timestamp = "2030-01-01T00:00:00.000Z";
        } else if (change === "model") {
          // Use native event plus getter identity; don't need auth for native model mutation in this fixture.
          await f.source.extensionRunner.emit({
            type: "model_select",
            model: { ...model, id: "later" },
            previousModel: model,
            source: "set",
          });
        } else await f.runtime.dispose();
        await running;
        auth.resolve({ ok: true, apiKey: "late" });
        await auth.promise;
        expect(f.generationCalls).toBe(0);
        expect(f.withSessions).toBe(0);
        expect(f.editorText).toBe("original unsent draft");
      } finally {
        auth.resolve({ ok: true, apiKey: "late" });
        await f.cleanup();
      }
    },
  );

  test("full native prefix changes retire sticky owner even if leaf returns", async () => {
    const f = await fixture();
    try {
      const owner = new Owner(f.source.extensionRunner.createCommandContext(), true);
      const leaf = f.manager.getLeafId() as string;
      f.manager.branch(f.manager.getBranch()[0].id);
      expect(owner.current()).toBe(false);
      f.manager.branch(leaf);
      expect(owner.current()).toBe(false);
      expect(owner.signal.aborted).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
});
