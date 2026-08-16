import { spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentFileLockOwnerPath,
  agentFileLockPath,
  atomicCreateFile,
  atomicReplaceFile,
  buildNewAgentFile,
  disableInContent,
  enableInContent,
  isDisabledContent,
  removeFileIfUnchanged,
  serializeAgentFile,
  withAgentFileLock,
} from "../src/agent-file-toggle.js";
import type { AgentConfig } from "../src/types.js";

const FILE_TOGGLE_WORKER = fileURLToPath(new URL("./agent-file-toggle-worker.ts", import.meta.url));

const fsMocks = vi.hoisted(() => ({
  writeSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs") as typeof fs;
  fsMocks.writeSync.mockImplementation(actual.writeSync);
  fsMocks.renameSync.mockImplementation(actual.renameSync);
  fsMocks.unlinkSync.mockImplementation(actual.unlinkSync);
  fsMocks.rmdirSync.mockImplementation(actual.rmdirSync);
  return {
    ...actual,
    writeSync: fsMocks.writeSync,
    renameSync: fsMocks.renameSync,
    unlinkSync: fsMocks.unlinkSync,
    rmdirSync: fsMocks.rmdirSync,
  };
});

describe("atomic agent file writes", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-agent-file-atomic-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    fsMocks.writeSync.mockClear();
    fsMocks.renameSync.mockClear();
    fsMocks.unlinkSync.mockClear();
    fsMocks.rmdirSync.mockClear();
  });

  function filePath(): string {
    return join(directory, "agent.md");
  }


  function recoveryFiles(): string[] {
    return readdirSync(directory).filter((name) => name.endsWith(".recovery"));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function runWorker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const runtime = process.execPath.includes("/bun") ? process.execPath : "bun";
      const child = spawn(runtime, [FILE_TOGGLE_WORKER, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.on("error", error => { stderr += `${error.message}\n`; resolve({ code: null, stdout, stderr }); });
      child.on("close", code => resolve({ code, stdout, stderr }));
    });
  }

  async function waitForReady(paths: string[]): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (paths.every(existsSync)) return;
      await sleep(5);
    }
    throw new Error(`worker barrier timed out: ${paths.join(", ")}`);
  }

  it("replaces normally, flushes through a temp file, and preserves permissions", async () => {
    const path = filePath();
    const source = "---\ndescription: Old\n---\n\nOld body.\n";
    writeFileSync(path, source);
    chmodSync(path, 0o640);

    await atomicReplaceFile(path, "---\ndescription: New\n---\n\nNew body.\n", source);

    expect(readFileSync(path, "utf-8")).toContain("description: New");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(recoveryFiles()).toHaveLength(1);
    expect(readFileSync(join(directory, recoveryFiles()[0]!), "utf-8")).toBe(source);
  });

  it("keeps the original and cleans the temp file when writing fails", async () => {
    const path = filePath();
    const source = "original";
    writeFileSync(path, source);
    fsMocks.writeSync.mockImplementationOnce(() => {
      throw new Error("simulated write failure");
    });

    await expect(atomicReplaceFile(path, "replacement", source)).rejects.toThrow("simulated write failure");
    expect(readFileSync(path, "utf-8")).toBe(source);
    expect(readdirSync(directory)).toEqual(["agent.md"]);
  });

  it("keeps the original and cleans the temp file when renaming fails", async () => {
    const path = filePath();
    const source = "original";
    writeFileSync(path, source);
    fsMocks.renameSync.mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });

    await expect(atomicReplaceFile(path, "replacement", source)).rejects.toThrow("simulated rename failure");
    expect(readFileSync(path, "utf-8")).toBe(source);
    expect(readdirSync(directory)).toEqual(["agent.md"]);
  });

  it("refuses a concurrent source change instead of overwriting it", async () => {
    const path = filePath();
    const source = "original";
    writeFileSync(path, source);
    writeFileSync(path, "concurrent change");

    await expect(atomicReplaceFile(path, "replacement", source)).rejects.toThrow(/source changed/);
    expect(readFileSync(path, "utf-8")).toBe("concurrent change");
  });


  it("preserves an editor replacement that lands between displacement and publication", async () => {
    const path = filePath();
    const source = "original";
    const actualFs = await vi.importActual<typeof fs>("node:fs");
    writeFileSync(path, source);
    fsMocks.renameSync.mockImplementationOnce((from, to) => {
      actualFs.renameSync(from, to);
      writeFileSync(path, "manual save");
    });

    await expect(atomicReplaceFile(path, "generated", source)).rejects.toThrow(/displaced source preserved/);

    expect(readFileSync(path, "utf-8")).toBe("manual save");
    expect(recoveryFiles()).toHaveLength(1);
    expect(readFileSync(join(directory, recoveryFiles()[0]!), "utf-8")).toBe(source);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);

    expect(fsMocks.renameSync).toHaveBeenCalledTimes(1);
  });

  it("creates new files without clobbering an existing target", async () => {
    const path = filePath();
    await atomicCreateFile(path, "created");

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("created");
    await expect(atomicCreateFile(path, "replacement")).rejects.toThrow(/already exists/);
    expect(readFileSync(path, "utf-8")).toBe("created");
    expect(readdirSync(directory)).toEqual(["agent.md"]);
  });

  it("honors umask 022 for newly created files", async () => {
    const path = filePath();
    const previous = process.umask(0o022);
    try {
      await atomicCreateFile(path, "created");
      expect(statSync(path).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previous);
    }
  });

  it("honors umask 077 for newly created files", async () => {
    const path = filePath();
    const previous = process.umask(0o077);
    try {
      await atomicCreateFile(path, "created");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("serializes cooperating replacement writers and preserves the committed change", async () => {
    const path = filePath();
    const source = "original";
    writeFileSync(path, source);
    let waitingWriter: Promise<void> | undefined;

    await withAgentFileLock(path, async () => {
      waitingWriter = atomicReplaceFile(path, "writer two", source);
      await sleep(40);
      writeFileSync(path, "writer one");
    });

    await expect(waitingWriter).rejects.toThrow(/source changed/);
    expect(readFileSync(path, "utf-8")).toBe("writer one");
  });

  it("serializes cooperating replacement and delete writers", async () => {
    const path = filePath();
    const source = "original";
    writeFileSync(path, source);
    let waitingDelete: Promise<void> | undefined;

    await withAgentFileLock(path, async () => {
      waitingDelete = removeFileIfUnchanged(path, source);
      await sleep(40);
      writeFileSync(path, "writer one");
    });

    await expect(waitingDelete).rejects.toThrow(/source changed/);
    expect(readFileSync(path, "utf-8")).toBe("writer one");
  });

  it("writes a unique mode-0600 owner token while a mutation lock is held", async () => {
    const path = filePath();
    writeFileSync(path, "original");
    let ownerPath = "";
    let token = "";

    await withAgentFileLock(path, () => {
      ownerPath = agentFileLockOwnerPath(path);
      token = readFileSync(ownerPath, "utf-8");
      expect(token).toMatch(new RegExp(`^${process.pid}:`));
      expect(ownerPath).not.toBe(agentFileLockPath(path) + "/owner");
      expect(statSync(ownerPath).mode & 0o777).toBe(0o600);
      expect(existsSync(agentFileLockPath(path))).toBe(true);
    });

    expect(token).not.toBe("");
    expect(ownerPath).toContain("/owner-");
    expect(existsSync(agentFileLockPath(path))).toBe(false);
  });

  it("never steals an orphan lock and reports its path after bounded retries", async () => {
    const path = filePath();
    const source = "original";
    writeFileSync(path, source);
    const lockPath = agentFileLockPath(path);
    mkdirSync(lockPath, { mode: 0o700 });
    const ownerPath = agentFileLockOwnerPath(path, "orphan-token");
    writeFileSync(ownerPath, "orphan", { mode: 0o600 });

    const started = Date.now();
    await expect(atomicReplaceFile(path, "replacement", source)).rejects.toThrow(
      new RegExp(`Cannot acquire cooperative agent-file lock.*${lockPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(ownerPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf-8")).toBe(source);
  });


  it("reclaims a valid lock token left by a dead process", async () => {
    const path = filePath();
    const source = "original";
    const token = "999999999:dead_owner";
    writeFileSync(path, source);
    const lockPath = agentFileLockPath(path);
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(agentFileLockOwnerPath(path, token), token, { mode: 0o600 });

    await atomicReplaceFile(path, "replacement", source);

    expect(readFileSync(path, "utf-8")).toBe("replacement");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses release after the owner token changes and leaves the other lock intact", async () => {
    const path = filePath();
    writeFileSync(path, "original");
    let ownerPath = "";

    await expect(withAgentFileLock(path, () => {
      ownerPath = agentFileLockOwnerPath(path);
      writeFileSync(ownerPath, "another-owner");
    })).rejects.toThrow(/owner token mismatch/);

    expect(existsSync(agentFileLockPath(path))).toBe(true);
    expect(readFileSync(ownerPath, "utf-8")).toBe("another-owner");
  });

  it("cannot unlink a replacement owner's token after the lock directory is recreated", async () => {
    const path = filePath();
    writeFileSync(path, "original");
    const lockPath = agentFileLockPath(path);
    const replacementToken = "replacement-owner";
    const replacementPath = agentFileLockOwnerPath(path, replacementToken);

    fsMocks.unlinkSync.mockImplementationOnce(() => {
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(replacementPath, replacementToken, { mode: 0o600 });
      throw Object.assign(new Error("owner token disappeared"), { code: "ENOENT" });
    });

    await expect(withAgentFileLock(path, () => undefined)).rejects.toThrow(/cannot remove token/);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(replacementPath, "utf-8")).toBe(replacementToken);
    expect(readdirSync(lockPath)).toEqual([replacementPath.slice(lockPath.length + 1)]);
  });

  it("does not remove a replacement owner when recreation races with rmdir", async () => {
    const path = filePath();
    writeFileSync(path, "original");
    const lockPath = agentFileLockPath(path);
    const replacementToken = "replacement-before-rmdir";
    const replacementPath = agentFileLockOwnerPath(path, replacementToken);

    fsMocks.rmdirSync.mockImplementationOnce(() => {
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(replacementPath, replacementToken, { mode: 0o600 });
      throw Object.assign(new Error("replacement owner remains"), { code: "ENOTEMPTY" });
    });

    await expect(withAgentFileLock(path, () => undefined)).rejects.toThrow(/not empty/);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(replacementPath, "utf-8")).toBe(replacementToken);
    expect(readdirSync(lockPath)).toEqual([replacementPath.slice(lockPath.length + 1)]);
  });

  it("serializes replace/delete flows in separate cooperating processes", async () => {
    const path = filePath();
    const source = "original";
    writeFileSync(path, source);
    const goPath = join(directory, "go");
    const replaceReady = join(directory, "replace.ready");
    const deleteReady = join(directory, "delete.ready");
    const replace = runWorker(["replace", path, source, "replacement", replaceReady, goPath]);
    const remove = runWorker(["delete", path, source, "", deleteReady, goPath]);

    await waitForReady([replaceReady, deleteReady]);
    writeFileSync(goPath, "go");
    const results = await Promise.all([replace, remove]);
    expect(results.filter(result => result.code === 0)).toHaveLength(1);
    expect(results.filter(result => result.code !== 0)).toHaveLength(1);
    expect(results.find(result => result.code !== 0)?.stderr).toMatch(/source changed/);
    expect(["replacement", undefined]).toContain(existsSync(path) ? readFileSync(path, "utf-8") : undefined);
  });

  it("serializes separate cooperating create processes without clobbering", async () => {
    const path = filePath();
    const goPath = join(directory, "create.go");
    const firstReady = join(directory, "first.ready");
    const secondReady = join(directory, "second.ready");
    const first = runWorker(["create", path, "", "first", firstReady, goPath]);
    const second = runWorker(["create", path, "", "second", secondReady, goPath]);

    await waitForReady([firstReady, secondReady]);
    writeFileSync(goPath, "go");
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.code === 0)).toHaveLength(1);
    expect(results.filter(result => result.code !== 0)).toHaveLength(1);
    expect(results.find(result => result.code !== 0)?.stderr).toMatch(/already exists/);
    expect(["first", "second"]).toContain(readFileSync(path, "utf-8"));
  });

  it("removes a source only when its read snapshot still matches", async () => {
    const path = filePath();
    writeFileSync(path, "original");

    await removeFileIfUnchanged(path, "original");

    expect(existsSync(path)).toBe(false);
    expect(recoveryFiles()).toHaveLength(1);
    expect(readFileSync(join(directory, recoveryFiles()[0]!), "utf-8")).toBe("original");
  });

  it("keeps a source when deletion cannot rename it", async () => {
    const path = filePath();
    writeFileSync(path, "original");
    fsMocks.renameSync.mockImplementationOnce(() => {
      throw new Error("simulated delete failure");
    });

    await expect(removeFileIfUnchanged(path, "original")).rejects.toThrow("simulated delete failure");
    expect(readFileSync(path, "utf-8")).toBe("original");
    expect(readdirSync(directory)).toEqual(["agent.md"]);
  });

  it("refuses to delete a source changed after confirmation", async () => {
    const path = filePath();
    writeFileSync(path, "original");
    writeFileSync(path, "concurrent change");

    await expect(removeFileIfUnchanged(path, "original")).rejects.toThrow(/source changed/);
    expect(readFileSync(path, "utf-8")).toBe("concurrent change");
  });


  it("preserves a source and a concurrent editor recreation during deletion", async () => {
    const path = filePath();
    const actualFs = await vi.importActual<typeof fs>("node:fs");
    writeFileSync(path, "original");
    fsMocks.renameSync.mockImplementationOnce((from, to) => {
      actualFs.renameSync(from, to);
      writeFileSync(path, "manual save");
    });

    await expect(removeFileIfUnchanged(path, "original")).rejects.toThrow(/concurrent writer recreated/);

    expect(readFileSync(path, "utf-8")).toBe("manual save");
    expect(recoveryFiles()).toHaveLength(1);
    expect(readFileSync(join(directory, recoveryFiles()[0]!), "utf-8")).toBe("original");

    expect(fsMocks.renameSync).toHaveBeenCalledTimes(1);
  });
});

describe("agent file frontmatter helpers", () => {
  it("detects and toggles enabled: false without rewriting the body", () => {
    const source = "---\ndescription: \"Review\"\n# keep this comment\n---\n\nPrompt\n";
    const disabled = disableInContent(source);

    expect(disabled.outcome).toBe("disabled");
    expect(disabled.content).toContain("# keep this comment\n");
    expect(disabled.content).toContain("enabled: false\n");
    expect(disabled.content).toContain("---\n\nPrompt\n");
    expect(isDisabledContent(disabled.content)).toBe(true);

    const enabled = enableInContent(disabled.content);
    expect(enabled.changed).toBe(true);
    expect(enabled.content).toBe(source);
  });

  it("uses YAML parsing for disabled detection and declines unsupported rewrites honestly", () => {
    const source = "---\nenabled: FALSE\n---\nbody\n";
    expect(isDisabledContent(source)).toBe(true);
    expect(disableInContent(source).outcome).toBe("already-disabled");
    expect(enableInContent(source)).toEqual({ content: "---\n---\nbody\n", changed: true });
  });

  it("recognizes spaced and quoted YAML keys without inserting a duplicate", () => {
    for (const key of ["enabled", '"enabled"', "'enabled'"]) {
      const source = `---\ndescription: Review\n${key} : true\nmodel: inherit\n---\nPrompt\n`;
      const disabled = disableInContent(source);

      expect(disabled.outcome).toBe("disabled");
      expect(disabled.content).toContain(`${key} : false\n`);
      expect((disabled.content.match(/enabled/g) ?? []).length).toBe(1);
      expect(isDisabledContent(disabled.content)).toBe(true);
    }
  });

  it("removes spaced quoted false keys while preserving comments and order", () => {
    const source = "---\n# header\ndescription: Review\n\"enabled\" : false  # keep this note\nmodel: inherit\n# footer\n---\nPrompt\n";
    const enabled = enableInContent(source);

    expect(enabled).toEqual({
      content: "---\n# header\ndescription: Review\nmodel: inherit\n# footer\n---\nPrompt\n",
      changed: true,
    });
    expect(isDisabledContent(enabled.content)).toBe(false);
  });

  it("only edits keys inside the parser frontmatter fence", () => {
    const source = "---\ndescription: Review\n---\nBody\nenabled : false\n";
    const disabled = disableInContent(source);

    expect(disabled.outcome).toBe("disabled");
    expect(disabled.content).toBe("---\nenabled: false\ndescription: Review\n---\nBody\nenabled : false\n");
    expect(enableInContent(disabled.content).content).toBe("---\ndescription: Review\n---\nBody\nenabled : false\n");
  });

  it("preserves CRLF line endings while toggling parser-supported keys", () => {
    const source = "---\r\n# header\r\n'enabled' : true\r\ndescription: Review\r\n---\r\nPrompt\r\n";
    const disabled = disableInContent(source);

    expect(disabled.outcome).toBe("disabled");
    expect(disabled.content).toContain("'enabled' : false\r\n");
    expect(disabled.content).not.toContain("\nenabled: false\n");
    expect(isDisabledContent(disabled.content)).toBe(true);
    expect(enableInContent(disabled.content)).toEqual({
      content: "---\r\n# header\r\ndescription: Review\r\n---\r\nPrompt\r\n",
      changed: true,
    });
  });

  it("refuses to return malformed edits, including duplicate parser keys", () => {
    const duplicate = "---\nenabled: true\nenabled: false\ndescription: Review\n---\nPrompt\n";
    const result = disableInContent(duplicate);

    expect(result.outcome).toBe("invalid");
    expect(result.content).toBe(duplicate);
    expect(result.error).toBeTruthy();

    const malformed = "---\ndescription: [unterminated\nenabled: true\n---\nPrompt\n";
    expect(disableInContent(malformed)).toMatchObject({
      content: malformed,
      outcome: "invalid",
    });
  });

  it("quotes free-text wizard fields and preserves extension-only/persistent config on eject", () => {
    const created = buildNewAgentFile({
      description: "Scout: audit #security",
      tools: "read, ext:foo # injection",
      model: "provider/model:thinking",
      systemPrompt: "Do the work.",
    });
    expect(created).toContain('description: "Scout: audit #security"\n');
    expect(created).toContain('tools: "read, ext:foo # injection"\n');
    expect(created).toContain('model: "provider/model:thinking"\n');

    const config: AgentConfig = {
      name: "scout",
      description: "Scout",
      builtinToolNames: [],
      extSelectors: ["ext:search"],
      extensions: true,
      skills: true,
      persistSession: true,
      sessionDir: "/tmp/sessions",
      systemPrompt: "Prompt",
      promptMode: "replace",
    };
    const ejected = serializeAgentFile(config);
    expect(ejected).toContain("tools: ext:search\n");
    expect(ejected).toContain("persist_session: true\n");
    expect(ejected).toContain('session_dir: "/tmp/sessions"\n');
  });
});
