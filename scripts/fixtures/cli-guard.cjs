// Acceptance preload: installed BEFORE the SDK in the CLI and inherited Node helpers.
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");
const root = fs.realpathSync(process.env.PI_CLI_SANDBOX);
if (!root.startsWith("/tmp/") && !root.startsWith("/private/tmp/")) throw new Error("Disposable /tmp sandbox required");
const record = (event) =>
  fs.appendFileSync(
    process.env.PI_CLI_PROCESSES,
    JSON.stringify({ ...event, pid: process.pid, ppid: process.ppid }) + "\n",
  );
const deny = () => {
  record({ event: "network-denied" });
  throw new Error("ACCEPTANCE: network disabled");
};
const net = require("node:net");
net.connect = net.createConnection = net.Socket.prototype.connect = deny;
require("node:tls").connect = deny;
for (const name of ["node:http", "node:https"]) {
  const mod = require(name);
  mod.request = mod.get = deny;
}
require("node:http2").connect = deny;
require("node:dgram").createSocket = deny;
for (const obj of [require("node:dns"), require("node:dns").promises]) {
  for (const key of Object.keys(obj))
    if (/^(lookup|resolve|reverse)/.test(key) && typeof obj[key] === "function") obj[key] = deny;
}
globalThis.fetch = deny;
function check(value) {
  if (typeof value === "number") return; // stdout/stderr/owned open descriptors
  const resolved = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error("ACCEPTANCE: write outside disposable sandbox: " + resolved);
}
for (const value of [process.cwd(), process.env.HOME, process.env.PI_CODING_AGENT_DIR]) check(value);
for (const [name, count] of [
  ["writeFile", 1],
  ["appendFile", 1],
  ["mkdir", 1],
  ["mkdtemp", 1],
  ["unlink", 1],
  ["rm", 1],
  ["rmdir", 1],
  ["rename", 2],
  ["copyFile", 2],
  ["symlink", 2],
  ["link", 2],
  ["truncate", 1],
  ["chmod", 1],
  ["chown", 1],
  ["utimes", 1],
]) {
  for (const obj of [fs, fs.promises])
    for (const suffix of obj === fs ? ["", "Sync"] : [""]) {
      const key = name + suffix,
        original = obj[key];
      if (!original) continue;
      obj[key] = function (...args) {
        for (let index = name === "copyFile" ? 1 : 0; index < count; index++) check(args[index]);
        return original.apply(this, args);
      };
    }
}
for (const obj of [fs, fs.promises])
  for (const suffix of obj === fs ? ["", "Sync"] : [""]) {
    const key = "open" + suffix,
      original = obj[key];
    obj[key] = function (value, flags, ...rest) {
      if (
        typeof flags === "number"
          ? (flags &
              (fs.constants.O_WRONLY |
                fs.constants.O_RDWR |
                fs.constants.O_CREAT |
                fs.constants.O_TRUNC |
                fs.constants.O_APPEND)) !==
            0
          : /[wa+]/.test(flags)
      )
        check(value);
      return original.call(this, value, flags, ...rest);
    };
  }
const stream = fs.createWriteStream;
fs.createWriteStream = function (value, ...args) {
  check(value);
  return stream.call(this, value, ...args);
};
syncBuiltinESMExports();
record({ event: "process-start" });
process.on("exit", (code) => record({ event: "process-exit", code }));
