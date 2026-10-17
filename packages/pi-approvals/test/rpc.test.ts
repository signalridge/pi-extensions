import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

it("uses the actual 1.0.4 RPC nonce transport for user_bash and ignores nonmatching approval ids", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "approvals-rpc-")));
  const cli = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const holdExtension = fileURLToPath(new URL("./rpc-hold.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      cli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--extension",
      extension,
      "--extension",
      holdExtension,
      "--approvals-native-tools",
    ],
    { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: cwd }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages: Record<string, unknown>[] = [];
  let output = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString("utf8");
    while (output.includes("\n")) {
      const index = output.indexOf("\n");
      const line = output.slice(0, index);
      output = output.slice(index + 1);
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* CLI diagnostics are not protocol responses. */
      }
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString("utf8");
  });
  const send = (command: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(command)}\n`);
  try {
    send({ id: "start", type: "get_state" });
    await vi.waitFor(
      () => {
        expect(child.exitCode, stderr).toBeNull();
        expect(messages.some((message) => message.id === "start")).toBe(true);
      },
      { timeout: 15000 },
    );
    send({ id: "bash", type: "bash", command: "printf approved > rpc-marker; printf stdout; printf stderr >&2" });
    await vi.waitFor(() =>
      expect(
        messages.some(
          (message) => message.method === "setStatus" && String(message.statusText).includes("Approvals: 1"),
        ),
      ).toBe(true),
    );
    send({ id: "hold", type: "prompt", message: "/approval-test-hold" });
    await vi.waitFor(() =>
      expect(
        messages.some(
          (message) => message.method === "setStatus" && String(message.statusText).includes("Approvals: 2"),
        ),
      ).toBe(true),
    );
    send({ id: "list", type: "prompt", message: "/approvals" });
    await vi.waitFor(() =>
      expect(
        messages.some((message) => message.method === "notify" && String(message.message).includes("user-bash")),
      ).toBe(true),
    );
    const notice = messages.find(
      (message) => message.method === "notify" && String(message.message).includes("user-bash"),
    );
    const approvalId = String(notice?.message)
      .split("\n")
      .find((line) => line.includes("user-bash"))
      ?.split(/\s+/u)[0];
    send({ id: "review", type: "prompt", message: `/approvals approve ${approvalId}` });
    await vi.waitFor(() => expect(messages.some((message) => message.method === "confirm")).toBe(true));
    const heldId = String(notice?.message)
      .split("\n")
      .find((line) => line.includes("rpc-test"))
      ?.split(/\s+/u)[0];
    expect(heldId).toBeDefined();
    const confirmation = messages.find((message) => message.method === "confirm");
    expect(confirmation?.id).not.toBe(approvalId);
    expect(confirmation?.message).toContain("printf approved > rpc-marker");
    expect(confirmation?.message).toContain(cwd);
    // A lifecycle request id or a model's approval-looking string is not a transport nonce.
    send({ type: "extension_ui_response", id: approvalId, confirmed: true });
    send({ id: "still-pending", type: "get_state" });
    await vi.waitFor(() => expect(messages.some((message) => message.id === "still-pending")).toBe(true));
    await expect(readFile(join(cwd, "rpc-marker"))).rejects.toThrow();
    send({ type: "extension_ui_response", id: confirmation?.id, confirmed: true });
    await vi.waitFor(() =>
      expect(messages.some((message) => message.id === "bash" && message.type === "response")).toBe(true),
    );
    expect(messages.find((message) => message.id === "bash" && message.type === "response")).toMatchObject({
      success: true,
      data: { exitCode: 0, cancelled: false },
    });
    expect(await readFile(join(cwd, "rpc-marker"), "utf8")).toBe("approved");
    expect(messages.some((message) => message.id === "hold" && message.type === "response")).toBe(false);
    const noticeCount = messages.filter((message) => message.method === "notify").length;
    send({ id: "remaining", type: "prompt", message: "/approvals" });
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.method === "notify").length).toBeGreaterThan(noticeCount),
    );
    const notices = messages.filter((message) => message.method === "notify");
    expect(String(notices.at(-1)?.message)).toContain(String(heldId));
    expect(String(notices.at(-1)?.message)).not.toContain(String(approvalId));
    send({ id: "deny-held", type: "prompt", message: `/approvals deny ${heldId}` });
    await vi.waitFor(() =>
      expect(messages.some((message) => message.id === "hold" && message.type === "response")).toBe(true),
    );
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(cwd, { recursive: true, force: true });
  }
}, 20000);
