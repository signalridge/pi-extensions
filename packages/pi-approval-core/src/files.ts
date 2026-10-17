import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import {
  type ApprovalOperation,
  type ApprovalRequestOptions,
  assertCurrent,
  escapeDisplay,
  MAX_FILE_BYTES,
  MAX_REVIEW_BYTES,
  snapshot,
  validateOperation,
} from "./contract.js";

interface Identity {
  readonly path: string;
  readonly token: string | null;
}
interface Capture {
  readonly bytes: Buffer | null;
  readonly identities: readonly Identity[];
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function identity(path: string, target: boolean): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (target && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1))
      throw new Error("Approval target must be a regular non-aliased file");
    if (!target && !stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("Invalid approval ancestor");
    if (target && stat.size > MAX_FILE_BYTES) throw new Error("File exceeds approval size limit");
    return JSON.stringify([
      await realpath(path),
      stat.dev,
      stat.ino,
      stat.mode,
      ...(target ? [stat.size, stat.mtimeMs, stat.ctimeMs] : []),
    ]);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function boundedRead(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error("File exceeds approval size limit or is not regular");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_FILE_BYTES) throw new Error("File exceeds approval size limit");
    const result = buffer.subarray(0, count);
    snapshot(result);
    return result;
  } finally {
    await handle.close();
  }
}
async function capture(path: string): Promise<Capture> {
  const identities: Identity[] = [];
  const token = await identity(path, true);
  identities.push({ path, token });
  let parent = dirname(path);
  while (true) {
    identities.push({ path: parent, token: await identity(parent, false) });
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const bytes = token === null ? null : await boundedRead(path);
  const result = { bytes, identities };
  await recheck(result);
  return result;
}
async function recheck(captured: Capture, directoriesCreated = false): Promise<void> {
  for (const [index, item] of captured.identities.entries()) {
    if (directoriesCreated && index > 0 && item.token === null) {
      // These directories were absent during review and have just been created.
      // This is not proof against an external writer racing mkdir/lstat/write.
      if (!(await lstat(item.path)).isDirectory()) throw new Error("Created approval ancestor changed");
    } else if ((await identity(item.path, index === 0)) !== item.token)
      throw new Error("Approval target or ancestor changed");
  }
  const target = captured.identities[0];
  if (!target) throw new Error("Missing approval capture");
  if (captured.bytes && !(await boundedRead(target.path)).equals(captured.bytes))
    throw new Error("Approval file contents changed");
}
export interface FileInvocation {
  readonly kind: "write" | "edit";
  readonly cwd: string;
  readonly toolCallId: string;
  readonly source: string;
  readonly inputHash: string;
  readonly options: ApprovalRequestOptions;
  readonly request: (operation: ApprovalOperation, options: ApprovalRequestOptions) => Promise<void>;
}
function review(invocation: FileInvocation, path: string, before: Buffer | null, after: Buffer): ApprovalOperation {
  const prior = before ? snapshot(before) : null;
  const next = snapshot(after);
  // Myers line diff is quadratic for disjoint inputs. Bound tokens BEFORE
  // entering the synchronous SDK diff; byte/payload limits alone cannot do so.
  // split includes a terminal empty token, deliberately a conservative count.
  if ((prior?.text ?? "").split("\n").length + next.text.split("\n").length > 2048)
    throw new Error(
      "File exceeds approval review computational limit (2048 combined line tokens); changes were not clipped",
    );
  // Diff the escaped text so BOM, CRLF and invisible changes are explicit.
  const patch = generateUnifiedPatch(escapeDisplay(path), escapeDisplay(prior?.text ?? ""), escapeDisplay(next.text));
  const preview = `Source: ${invocation.source}\nCWD: ${escapeDisplay(invocation.cwd)}\nFile: ${escapeDisplay(path)}\nEscaped display (backslashes doubled; controls shown as \\u{hex})\nBefore: ${prior?.sha256 ?? "missing"}\nAfter: ${next.sha256}\n${patch}`;
  if (Buffer.byteLength(preview) > MAX_REVIEW_BYTES)
    throw new Error("Generated review exceeds approval size limit; changes were not clipped");
  return validateOperation({
    kind: invocation.kind,
    toolName: invocation.kind,
    source: invocation.source,
    cwd: invocation.cwd,
    toolCallId: invocation.toolCallId,
    inputHash: invocation.inputHash,
    filePath: path,
    before: prior,
    after: next,
    preview,
  });
}
/** Invocation-local operations. The SDK factory owns the only mutation queue. */
export function createFileOperations(invocation: FileInvocation) {
  let original: Capture | undefined;
  return {
    access: (path: string) => access(path, constants.R_OK | constants.W_OK),
    // SDK write calls mkdir before writeFile: deliberately defer it until approval.
    mkdir: async (_dir: string): Promise<void> => {},
    readFile: async (path: string): Promise<Buffer> => {
      assertCurrent(invocation.options);
      original = await capture(path);
      assertCurrent(invocation.options);
      if (!original.bytes) throw new Error("Edit target disappeared");
      return Buffer.from(original.bytes);
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      assertCurrent(invocation.options);
      const captured = invocation.kind === "edit" ? original : await capture(path);
      if (!captured) throw new Error("Edit did not capture its input");
      const after = Buffer.from(content, "utf8");
      if (after.toString("utf8") !== content) throw new Error("Invalid UTF-8 output");
      const operation = review(invocation, path, captured.bytes, after);
      await invocation.request(operation, invocation.options);
      assertCurrent(invocation.options);
      await recheck(captured);
      assertCurrent(invocation.options);
      if (invocation.kind === "write") {
        await mkdir(dirname(path), { recursive: true });
        // Failure after mkdir may leave directories behind; no rollback promise.
        assertCurrent(invocation.options);
        await recheck(captured, true);
        assertCurrent(invocation.options);
      }
      await writeFile(path, after);
      assertCurrent(invocation.options);
    },
  };
}
