import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Fingerprints } from "../src/fingerprint.js";
import { Persistence } from "../src/persistence.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "todo-canonical-disk-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "x".repeat(64 * 1024), timestamp: 1 });
  manager.appendCustomEntry("unrelated", { nested: { text: "exact body" } });
  const file = manager.getSessionFile();
  if (!file) throw new Error("Missing file");
  const hashes = new Fingerprints();
  for (const entry of manager.getEntries()) hashes.hash(entry);
  return { manager, file, hashes, persistence: new Persistence(hashes) };
}

describe("exact canonical raw-line reuse", () => {
  it.each(["LF", "CRLF"])("skips only proven canonical bounded records (%s), always parsing the header", (format) => {
    const f = fixture();
    if (format === "CRLF") writeFileSync(f.file, readFileSync(f.file, "utf8").replaceAll("\n", "\r\n"));
    const parse = vi.spyOn(JSON, "parse");
    const proof = f.persistence.inspect(f.manager);
    expect(parse).toHaveBeenCalledOnce(); // Header has its own mandatory parser/identity path.
    parse.mockRestore();
    for (const entry of f.manager.getEntries()) expect(f.persistence.includes(proof, entry)).toBe(true);
    expect(proof.conversation).toBe(true);
    expect(proof.incomplete).toBe(false);
  });
  it("retains the parser path for unknown and legal noncanonical records, including a replaced file", () => {
    const f = fixture();
    const canonical = readFileSync(f.file, "utf8");
    writeFileSync(
      f.file,
      `${canonical
        .trimEnd()
        .split("\n")
        .map((line) => ` \t${line} \t`)
        .join("\n")}\n`,
    );
    const parse = vi.spyOn(JSON, "parse");
    const proof = f.persistence.inspect(f.manager);
    expect(parse).toHaveBeenCalledTimes(3);
    parse.mockRestore();
    for (const entry of f.manager.getEntries()) expect(f.persistence.includes(proof, entry)).toBe(true);
    const replacement = `${f.file}.replacement`;
    writeFileSync(replacement, canonical.replace("exact body", "other body"));
    fs.renameSync(replacement, f.file);
    const replaced = f.persistence.inspect(f.manager);
    expect(f.persistence.includes(replaced, f.manager.getEntries()[1])).toBe(false);
  });
  it("does not promote an old raw digest into current native proof across read callbacks", () => {
    const f = fixture();
    const entry = f.manager.getEntries()[1];
    if (entry.type !== "custom") throw new Error("Missing custom entry");
    const nativeRead = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = nativeRead(...args);
      Object.assign(entry.data as object, { nested: { text: "Changed during disk read" } });
      return count;
    });
    syncBuiltinESMExports();
    const proof = f.persistence.inspect(f.manager);
    expect(f.persistence.includes(proof, entry)).toBe(false);
  });
  it.each(["array kind", "boxed Boolean", "boxed Number"])(
    "does not confer durable membership on a warmed native %s impostor, including across disk I/O",
    (change) => {
      const f = fixture();
      const entry = f.manager.getEntries()[1];
      if (entry.type !== "custom") throw new Error("Missing custom entry");
      const data: { nested: unknown } = { nested: change === "array kind" ? [] : {} };
      // Persist this exact value and warm its digest before obtaining scan hints.
      entry.data = data;
      const lines = readFileSync(f.file, "utf8").trimEnd().split("\n");
      lines[2] = JSON.stringify(entry);
      writeFileSync(f.file, `${lines.join("\n")}\n`);
      f.hashes.hash(entry);
      const nativeRead = fs.readSync;
      vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
        const count = nativeRead(...args);
        data.nested =
          change === "array kind"
            ? Object.create(Array.prototype)
            : Object.setPrototypeOf(Object(change === "boxed Boolean" ? true : 7), Object.prototype);
        return count;
      });
      syncBuiltinESMExports();
      const proof = f.persistence.inspect(f.manager);
      expect(f.hashes.known(entry)).toBeUndefined();
      expect(f.persistence.includes(proof, entry)).toBe(false);
    },
  );
  for (const direction of ["plain to raw", "raw to plain"] as const) {
    it.each(["1", "true", "null", '"raw 😀"'])(
      `does not confer durable membership after native ${direction} JSON %s changes during disk I/O`,
      (text) => {
        const f = fixture();
        const entry = f.manager.getEntries()[1];
        if (entry.type !== "custom") throw new Error("Missing custom entry");
        const nativeJSON = JSON as typeof JSON & { rawJSON(text: string): object };
        const raw = nativeJSON.rawJSON(text);
        const plain: object = Object.create(Object.getPrototypeOf(raw));
        Object.defineProperties(plain, Object.getOwnPropertyDescriptors(raw));
        const data = { nested: direction === "plain to raw" ? plain : raw };
        entry.data = data;
        const lines = readFileSync(f.file, "utf8").trimEnd().split("\n");
        lines[2] = JSON.stringify(entry);
        writeFileSync(f.file, `${lines.join("\n")}\n`);
        const before = f.hashes.hash(entry);
        const nativeRead = fs.readSync;
        let changed = false;
        vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
          const count = nativeRead(...args);
          changed = true;
          data.nested = direction === "plain to raw" ? raw : plain;
          return count;
        });
        syncBuiltinESMExports();
        const proof = f.persistence.inspect(f.manager);
        expect(changed).toBe(true);
        expect(proof.committed.has(before)).toBe(true);
        expect({ hint: f.hashes.known(entry), included: f.persistence.includes(proof, entry) }).toEqual({
          hint: undefined,
          included: false,
        });
      },
    );
  }
  it("never invokes extra getters on abandoned unsafe native values merely to build disk hints", () => {
    const f = fixture();
    const entry = f.manager.getEntries()[1];
    if (entry.type !== "custom") throw new Error("Missing custom entry");
    let reads = 0;
    Object.defineProperty(entry.data as object, "nested", {
      enumerable: true,
      get() {
        reads++;
        return "unsafe";
      },
    });
    expect(f.persistence.inspect(f.manager).conversation).toBe(true);
    expect(reads).toBe(0);
  });
});
