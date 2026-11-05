import { appendFileSync, writeFileSync } from "node:fs";

const scenario = process.argv[2];
let buffer = Buffer.alloc(0);

// Stay alive even after the client closes its pipes and sends SIGTERM.
process.on("SIGTERM", () => {
  appendFileSync("signals.log", `${process.pid}:TERM\n`);
  if (scenario === "cooperative") process.exit(0);
});
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
setInterval(() => {}, 1000);
appendFileSync("pids.log", `${process.pid}\n`);

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(message) {
  if (message.method === "initialize") {
    writeFileSync("initialize.flag", "ready");
    if (scenario === "environment") {
      writeFileSync(
        "environment.json",
        JSON.stringify({
          inherited: process.env.PI_LSP_TEST_INHERITED,
          override: process.env.PI_LSP_TEST_OVERRIDE,
          removed: process.env.PI_LSP_TEST_REMOVED,
        }),
      );
    }
    if (scenario === "silent-initialize") return;
    if (scenario === "malformed") {
      process.stdout.write("Content-Length: 1\r\n\r\n{");
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { capabilities: scenario === "clean" ? { diagnosticProvider: {} } : {} },
    });
  }
  if (message.method === "textDocument/didOpen") writeFileSync("didOpen.flag", "ready");
  if (message.method === "textDocument/diagnostic") {
    send({ jsonrpc: "2.0", id: message.id, result: { items: [] } });
  }
  if (message.method === "textDocument/codeAction") {
    send({ jsonrpc: "2.0", id: message.id, result: [] });
  }
  if (message.method === "shutdown") {
    writeFileSync("shutdown.flag", "ready");
    if (scenario !== "silent-shutdown") send({ jsonrpc: "2.0", id: message.id, result: null });
  }
  // Deliberately ignore the exit notification too.
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString("utf8");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    const bodyStart = separator + 4;
    if (!Number.isFinite(length) || buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});

// Optional test bootstrap acknowledgement; silent-initialize still stays silent.
if (process.env.PI_LSP_TEST_READY) writeFileSync(process.env.PI_LSP_TEST_READY, "ready");
