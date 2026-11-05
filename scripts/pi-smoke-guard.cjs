// Test-process perimeter only; installed before SDK imports, inherited by owned children.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");
const { resolve, sep, dirname } = require("node:path");
const { fileURLToPath } = require("node:url");
const sandbox = process.env.PI_SMOKE_SANDBOX;
assert.ok(sandbox, "run native Pi qualification through run-pi-smoke.mjs");
const base = fs.realpathSync(sandbox);
const guard = { networkAttempts: 0, deniedWrites: 0 };
globalThis[Symbol.for("pi-smoke:guard")] = guard;
function denyNetwork() {
  guard.networkAttempts++;
  throw new Error("Native Pi qualification forbids network access");
}
for (const [module, names] of [
  [require("node:net"), ["connect", "createConnection"]],
  [require("node:tls"), ["connect"]],
  [require("node:http"), ["request", "get"]],
  [require("node:https"), ["request", "get"]],
  [require("node:dgram"), ["createSocket"]],
  [require("node:dns"), ["lookup", "resolve"]],
]) {
  for (const name of names) module[name] = denyNetwork;
}
require("node:net").Socket.prototype.connect = denyNetwork;
globalThis.fetch = denyNetwork;
function checkWrite(path) {
  // File descriptors were opened through guarded open/openSync.
  if (typeof path === "number") return;
  const target = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
  let existing = target;
  while (!fs.existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = fs.realpathSync(existing);
  if ((target !== base && !target.startsWith(base + sep)) || (real !== base && !real.startsWith(base + sep))) {
    guard.deniedWrites++;
    throw new Error(`Native Pi qualification forbids writing outside sandbox: ${target}`);
  }
}
for (const name of [
  "appendFile",
  "chmod",
  "chown",
  "mkdir",
  "mkdtemp",
  "rm",
  "rmdir",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
]) {
  for (const [object, key] of [
    [fs, name],
    [fs, `${name}Sync`],
    [fsp, name],
  ]) {
    if (typeof object[key] !== "function") continue;
    const original = object[key];
    object[key] = function (path, ...args) {
      checkWrite(path);
      return original.call(this, path, ...args);
    };
  }
}
for (const name of ["rename", "copyFile", "cp", "link", "symlink"]) {
  for (const [object, key] of [
    [fs, name],
    [fs, `${name}Sync`],
    [fsp, name],
  ]) {
    if (typeof object[key] !== "function") continue;
    const original = object[key];
    object[key] = function (source, destination, ...args) {
      if (name === "rename") checkWrite(source);
      checkWrite(destination);
      return original.call(this, source, destination, ...args);
    };
  }
}
for (const [object, key] of [
  [fs, "open"],
  [fs, "openSync"],
  [fsp, "open"],
  [fs, "createWriteStream"],
]) {
  const original = object[key];
  object[key] = function (path, flags, ...args) {
    const mode = key === "createWriteStream" ? (flags?.flags ?? "w") : (flags ?? "r");
    if (
      typeof mode === "number"
        ? mode &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_APPEND)
        : /[wa+]/.test(mode)
    )
      checkWrite(path);
    return original.call(this, path, flags, ...args);
  };
}
syncBuiltinESMExports();
