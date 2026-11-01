import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

const NON_BLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/**
 * Read a UTF-8 file only when it is a regular file.
 *
 * Agent, memory and skill markdown is read synchronously on the main thread.
 * A FIFO under one of those names would block the open, and so all of Pi, until
 * something writes to it. The open never blocks, and the type is checked on the
 * opened descriptor, so swapping the path after a check cannot reintroduce it.
 *
 * @param noFollow  Refuse a symlink at the final path component (fails with ELOOP).
 * @throws When the path cannot be opened or is not a regular file.
 */
export function readRegularFileSync(path: string, options: { noFollow?: boolean } = {}): string {
  const descriptor = openSync(path, constants.O_RDONLY | NON_BLOCK | (options.noFollow ? NO_FOLLOW : 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(descriptor, "utf-8");
  } finally {
    closeSync(descriptor);
  }
}
