import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, vi } from "vitest";
import { flushDiagnostics } from "../src/diagnostics.js";

// Observability tests must never read/write the invoking user's agent files.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "pi-compact-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
afterAll(async () => {
  await flushDiagnostics();
  rmSync(agentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
