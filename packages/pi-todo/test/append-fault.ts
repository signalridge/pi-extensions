import fs, { mkdirSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { STATE_TYPE } from "../src/state.js";

/** Model a lost write/acknowledgement after the public append has completed.
 * Pi 1.5 rolls back native memory when its own fs write throws. These fixtures
 * deliberately retain a ghost to keep testing Todo's independent durability
 * checks, without editing native entries or patching private SDK methods.
 */
export function postAppendFault(
  manager: SessionManager,
  method: "custom" | "message" = "custom",
  write: "drop" | "commit" | "unreadable" = "drop",
) {
  const file = manager.getSessionFile();
  if (!file) throw new Error("Missing native session file");
  const nativeAppend = fs.appendFileSync;
  let injected = false;
  const spy = vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
    const target = method === "custom" ? String(args[1]).includes(`"customType":"${STATE_TYPE}"`) : true;
    if (args[0] === file && target && !injected) {
      injected = true;
      if (write === "commit") nativeAppend(...args);
      else if (write === "unreadable") {
        renameSync(file, `${file}.saved`);
        mkdirSync(file);
      }
      return;
    }
    nativeAppend(...args);
  });
  const failure = () => Object.assign(new Error("native EIO after public append acknowledgement"), { code: "EIO" });
  if (method === "custom") {
    const append = manager.appendCustomEntry.bind(manager);
    vi.spyOn(manager, "appendCustomEntry").mockImplementationOnce((type, data) => {
      append(type, data);
      throw failure();
    });
  } else {
    const append = manager.appendMessage.bind(manager);
    vi.spyOn(manager, "appendMessage").mockImplementationOnce((message) => {
      append(message);
      throw failure();
    });
  }
  syncBuiltinESMExports();
  return spy;
}
