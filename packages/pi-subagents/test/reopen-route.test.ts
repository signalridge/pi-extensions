import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { assertPlainReopenHistory, captureReopenRoute, parseReopenRoute } from "../src/reopen-route.js";

const model = getBuiltinModel("anthropic", "claude-sonnet-4-6");
const route = { provider: model.provider, api: model.api, modelId: model.id, baseUrl: model.baseUrl };

describe("nonsecret cold-reopen catalog proof", () => {
  it("retains only bounded public route fields, never model headers or other metadata", () => {
    const captured = captureReopenRoute({ provider: route.provider, api: route.api, id: route.modelId, baseUrl: route.baseUrl,
      headers: { Authorization: "SECRET" }, name: "not identity" } as Model<Api>);
    expect(captured).toEqual(route);
    expect(parseReopenRoute({ ...route, headers: { Authorization: "SECRET" }, extra: "SECRET" })).toEqual(route);
    expect(JSON.stringify(captured)).not.toContain("SECRET");
  });

  it.each([`${model.baseUrl}/tenant/SECRET-PATH`, "https://unknown.example/v1", "", "not-url", "https://user:password@example.com", "https://example.com?token=secret", "https://example.com#secret", "file:///private", "x".repeat(2_001)])("does not persist unknown or credential-bearing endpoint %s", baseUrl => {
    expect(parseReopenRoute({ ...route, baseUrl })).toBeUndefined();
  });

  it.each([{ provider: "unknown" }, { api: "unknown" }, { modelId: "unknown" }, { provider: "x".repeat(129) }, { modelId: "x".repeat(257) }, { api: "x".repeat(129) }, { api: "pi-virtual" }, { baseURL: route.baseUrl, baseUrl: undefined }])("refuses missing/unsupported route metadata %j", change => {
    expect(parseReopenRoute({ ...route, ...change })).toBeUndefined();
  });

  it("uses the actual SDK compaction and branch-summary APIs without treating inert details as replay", () => {
    const native = SessionManager.inMemory();
    native.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
    native.appendCompaction("Plain summary", null, 100, { thinkingSignature: "inert-not-replayed" });
    native.branchWithSummary(native.getLeafId(), "Plain branch summary", { opaque: "inert-not-replayed" });
    expect(() => assertPlainReopenHistory(native, route)).not.toThrow();
  });

  it("inspects compaction's public systemMessage separately from its string summary", () => {
    const native = SessionManager.inMemory();
    const id = native.appendCompaction("Plain summary", null, 100);
    const entry = native.getEntry(id)!;
    if (entry.type !== "compaction") throw new Error("wrong native entry");
    const restored = SessionManager.inMemory(undefined, undefined, [{ ...entry,
      systemMessage: { role: "system", content: [{ type: "text", text: "state", textSignature: "unknown-issuer" }], timestamp: Date.now() } }]);
    expect(() => assertPlainReopenHistory(restored, route)).toThrow(/opaque or unknown replay content/);
  });
});
