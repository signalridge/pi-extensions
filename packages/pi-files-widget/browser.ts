import { lstatSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";

import { mapBounded } from "./async-work.js";
import {
  DEFAULT_BROWSER_HEIGHT,
  LINE_COUNT_BATCH_DELAY_MS,
  LINE_COUNT_BATCH_SIZE,
  MAX_BROWSER_HEIGHT,
  MAX_LINE_COUNT_BYTES,
  MAX_TREE_DEPTH,
  METADATA_CONCURRENCY,
  MIN_PANEL_HEIGHT,
  POLL_INTERVAL_MS,
  SAFE_MODE_ENTRY_THRESHOLD,
  SCAN_BATCH_DELAY_MS,
  SCAN_BATCH_SIZE,
} from "./constants.js";
import { buildFileTreeFromPaths, flattenTree, getIgnoredNames, sortChildren, updateTreeStats } from "./file-tree.js";
import { type GitMetadata, readGitMetadata, resolveGitExecutable } from "./git-async.js";
import { createTextInputBuffer } from "./input-utils.js";
import type { DiffStats, FileNode, FlatNode } from "./types.js";
import { isIgnoredStatus, isUntrackedStatus } from "./utils.js";
import { type CommentPayload, createViewer, type ViewerAction } from "./viewer.js";

export interface BrowserController {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
}

interface BrowserStats {
  totalLines?: number;
  additions: number;
  deletions: number;
}

type ScanMode = "full" | "safe" | "none";

interface ScanState {
  mode: ScanMode;
  isScanning: boolean;
  isPartial: boolean;
  pending: number;
  spinnerIndex: number;
}

interface BrowserState {
  root: FileNode | null;
  flatList: FlatNode[];
  fullList: FlatNode[];
  stats: BrowserStats;
  nodeByPath: Map<string, FileNode>;
  scanState: ScanState;
  selectedIndex: number;
  searchQuery: string;
  searchMode: boolean;
  showOnlyChanged: boolean;
  browserHeight: number;
  lastPollTime: number;
}

interface ChangedFile {
  file: FileNode;
  ancestors: FileNode[];
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function findNodeByPath(root: FileNode | null, path: string): FileNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  if (!root.children) return null;

  for (const child of root.children) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }

  return null;
}

function indexNodes(root: FileNode | null, map: Map<string, FileNode>): void {
  map.clear();
  if (!root) return;
  const stack: FileNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    map.set(node.path, node);
    if (node.children) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
}

function getNodeDepth(node: FileNode, root: string): number {
  if (node.path === root) return 0;
  const rel = relative(root, node.path);
  if (!rel) return 0;
  return rel.split(sep).length;
}

function formatRootPath(path: string): string {
  const home = homedir();
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  return path;
}

function safeRealPathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function getPathInfoSync(path: string): { isDirectory: boolean; isSymlink: boolean; realPath?: string } {
  try {
    const linkStat = lstatSync(path);
    const isSymlink = linkStat.isSymbolicLink();
    const targetStat = isSymlink ? statSync(path) : linkStat;
    return {
      isDirectory: targetStat.isDirectory(),
      isSymlink,
      realPath: targetStat.isDirectory() ? safeRealPathSync(path) : undefined,
    };
  } catch {
    return { isDirectory: false, isSymlink: false };
  }
}

async function getPathInfo(
  path: string,
  isSymlink: boolean,
  isCurrent: () => boolean,
): Promise<{ isDirectory: boolean; isSymlink: boolean; realPath?: string }> {
  try {
    const targetStat = await stat(path);
    if (!isCurrent()) return { isDirectory: false, isSymlink };
    return {
      isDirectory: targetStat.isDirectory(),
      isSymlink,
      realPath: targetStat.isDirectory() ? await realpath(path).catch(() => resolve(path)) : undefined,
    };
  } catch {
    return { isDirectory: false, isSymlink };
  }
}

function hasAncestorRealPath(node: FileNode | undefined, realPath: string): boolean {
  let current = node;
  while (current) {
    if (current.realPath === realPath) return true;
    current = current.parent;
  }
  return false;
}

function shouldSafeMode(path: string): boolean {
  const resolved = resolve(path);
  const home = resolve(homedir());
  const root = resolve(sep);
  return resolved === home || resolved === root;
}

function collectChangedFiles(node: FileNode, ancestors: FileNode[] = []): ChangedFile[] {
  const results: ChangedFile[] = [];

  if (!node.isDirectory && (node.gitStatus || node.agentModified || node.observedChanged)) {
    results.push({ file: node, ancestors: [...ancestors] });
  }

  if (node.children) {
    for (const child of node.children) {
      results.push(...collectChangedFiles(child, [...ancestors, node]));
    }
  }

  return results;
}

function getTreeStats(root: FileNode | null): BrowserStats {
  if (!root) {
    return { totalLines: undefined, additions: 0, deletions: 0 };
  }

  return {
    totalLines: root.lineCountComplete ? (root.totalLines ?? 0) : undefined,
    additions: root.totalAdditions ?? 0,
    deletions: root.totalDeletions ?? 0,
  };
}

function formatNodeStatus(node: FileNode, theme: Theme): string {
  if (isIgnoredStatus(node.gitStatus)) return "";
  if (node.agentModified) return theme.fg("accent", " 🤖");
  if (node.observedChanged) return theme.fg("dim", " ~");
  if (node.gitStatus === "M" || node.gitStatus === "MM") return theme.fg("warning", " M");
  if (isUntrackedStatus(node.gitStatus)) return theme.fg("dim", " ?");
  if (node.gitStatus === "A") return theme.fg("success", " A");
  if (node.gitStatus === "D") return theme.fg("error", " D");
  return "";
}

function formatNodeMeta(node: FileNode, theme: Theme): string {
  if (isIgnoredStatus(node.gitStatus)) return "";

  const parts: string[] = [];

  if (node.isDirectory && !node.expanded) {
    if (node.totalAdditions && node.totalAdditions > 0) {
      parts.push(theme.fg("success", `+${node.totalAdditions}`));
    }
    if (node.totalDeletions && node.totalDeletions > 0) {
      parts.push(theme.fg("error", `-${node.totalDeletions}`));
    }
    if (node.totalLines && node.lineCountComplete !== false) {
      parts.push(theme.fg("dim", `${node.totalLines}L`));
    }
  } else if (!node.isDirectory) {
    if (node.diffStats) {
      if (node.diffStats.additions > 0) {
        parts.push(theme.fg("success", `+${node.diffStats.additions}`));
      }
      if (node.diffStats.deletions > 0) {
        parts.push(theme.fg("error", `-${node.diffStats.deletions}`));
      }
    } else if (isUntrackedStatus(node.gitStatus) && node.lineCount !== undefined) {
      parts.push(theme.fg("success", `+${node.lineCount}`));
    }
    if (node.lineCount !== undefined) {
      parts.push(theme.fg("dim", `${node.lineCount}L`));
    }
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function withSymlinkMarker(label: string, node: FileNode, theme: Theme): string {
  return node.isSymlink ? `${label}${theme.fg("dim", " ↗")}` : label;
}

function formatNodeName(node: FileNode, theme: Theme): string {
  const name = sanitizeDisplayText(node.name);
  if (isIgnoredStatus(node.gitStatus)) return withSymlinkMarker(theme.fg("dim", name), node, theme);
  if (node.isDirectory) {
    const label = node.hasChangedChildren ? theme.fg("warning", name) : theme.fg("accent", name);
    const rendered = withSymlinkMarker(label, node, theme);
    return node.loading ? `${rendered}${theme.fg("dim", " ⏳")}` : rendered;
  }
  if (node.gitStatus) return withSymlinkMarker(theme.fg("warning", name), node, theme);
  return withSymlinkMarker(name, node, theme);
}

function collapseAllExcept(node: FileNode, keep: Set<FileNode>): void {
  if (node.isDirectory) {
    node.expanded = keep.has(node);
    if (node.children) {
      for (const child of node.children) {
        collapseAllExcept(child, keep);
      }
    }
  }
}

export function createFileBrowser(
  initialPath: string,
  agentModifiedFiles: Set<string>,
  theme: Theme,
  onClose: () => void,
  requestComment: (payload: CommentPayload, comment: string) => void,
  requestRender: () => void,
  projectCwd: string = initialPath,
  observedChangedFiles: ReadonlySet<string> = new Set(),
  ownerIsCurrent: () => boolean = () => true,
): BrowserController {
  const ignored = getIgnoredNames();

  let rootPath = resolve(initialPath);
  const initialRoot = rootPath;
  let repo = false;
  let gitStatus = new Map<string, string>();
  let diffStats = new Map<string, DiffStats>();
  let gitBranch = "";
  let gitFiles: string[] = [];

  const viewer = createViewer({ getRoot: () => rootPath, projectCwd }, theme, requestComment);
  const textInput = createTextInputBuffer();

  const scanState: ScanState = {
    mode: "none",
    isScanning: false,
    isPartial: false,
    pending: 0,
    spinnerIndex: 0,
  };

  const browser: BrowserState = {
    root: null,
    flatList: [],
    fullList: [],
    stats: { totalLines: undefined, additions: 0, deletions: 0 },
    nodeByPath: new Map<string, FileNode>(),
    scanState,
    selectedIndex: 0,
    searchQuery: "",
    searchMode: false,
    showOnlyChanged: false,
    browserHeight: DEFAULT_BROWSER_HEIGHT,
    lastPollTime: Date.now(),
  };

  const lineCountCache = new Map<string, { size: number; mtimeMs: number; count: number }>();
  const lineCountQueue: FileNode[] = [];
  const lineCountPending = new Set<string>();
  let lineCountTimer: ReturnType<typeof setTimeout> | null = null;
  let lineCountRunning = false;

  const scanQueue: Array<{ node: FileNode; depth: number }> = [];
  const scanQueued = new Set<string>();
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let scanRunning = false;
  let gitRunning = false;
  let gitPending = false;
  let gitRequestGeneration = 0;
  let gitController: AbortController | undefined;
  let gitExecutable: string | undefined;
  let gitState: "loading" | "ready" | "unavailable" = "loading";
  // Incremented on every (re-)root. In-flight async scan/line-count batches
  // capture the value when they start and bail after each await if it changed,
  // so work belonging to an old root can never mutate state for the new one.
  let rootGeneration = 0;
  let disposed = false;

  function isCurrent(generation = rootGeneration): boolean {
    if (disposed || generation !== rootGeneration) return false;
    if (ownerIsCurrent()) return true;
    dispose();
    return false;
  }

  const normalizeGitPath = (path: string): string => path.split(sep).join("/");

  function refreshLists(): void {
    browser.flatList = browser.root ? flattenTree(browser.root) : [];
    browser.fullList = browser.root ? flattenTree(browser.root, 0, true, true) : [];
  }

  function queueLineCount(node: FileNode, force = false): void {
    if (!isCurrent() || node.isDirectory) return;
    if (!force && node.lineCount !== undefined) return;
    if (lineCountPending.has(node.path)) return;
    lineCountPending.add(node.path);
    lineCountQueue.push(node);
    scheduleLineCount();
  }

  function scheduleLineCount(): void {
    if (isCurrent() && !lineCountRunning && !lineCountTimer && lineCountQueue.length > 0) {
      lineCountTimer = setTimeout(processLineCountBatch, LINE_COUNT_BATCH_DELAY_MS);
    }
  }

  function queueLineCountsForTree(rootNode: FileNode | null): void {
    if (!rootNode) return;
    const stack: FileNode[] = [rootNode];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.isDirectory) {
        if (node.children) {
          for (const child of node.children) {
            stack.push(child);
          }
        }
      } else {
        queueLineCount(node);
      }
    }
  }

  async function updateLineCount(node: FileNode, generation: number): Promise<void> {
    try {
      const fileStat = await stat(node.path);
      if (!isCurrent(generation)) return;
      if (fileStat.size > MAX_LINE_COUNT_BYTES) {
        node.lineCount = undefined;
        return;
      }
      const cached = lineCountCache.get(node.path);
      if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
        node.lineCount = cached.count;
        return;
      }
      const content = await readFile(node.path, "utf-8");
      if (!isCurrent(generation)) return;
      const count = content.split("\n").length;
      node.lineCount = count;
      lineCountCache.set(node.path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, count });
    } catch {
      if (isCurrent(generation)) node.lineCount = undefined;
    }
  }

  async function processLineCountBatch(): Promise<void> {
    lineCountTimer = null;
    if (lineCountRunning || !isCurrent() || !browser.root) return;
    lineCountRunning = true;
    const generation = rootGeneration;
    try {
      const batch = lineCountQueue.splice(0, LINE_COUNT_BATCH_SIZE);
      if (batch.length === 0) return;
      await Promise.all(
        batch.map(async (node) => {
          if (!isCurrent(generation)) return;
          await updateLineCount(node, generation);
          if (isCurrent(generation)) lineCountPending.delete(node.path);
        }),
      );
      if (!isCurrent(generation)) return;
      updateTreeStats(browser.root);
      browser.stats = getTreeStats(browser.root);
      refreshLists();
      requestRender();
    } finally {
      lineCountRunning = false;
      // The old generation may have drained while a new root queued work.
      // Only this finalizer schedules it; enqueue cannot start a second pump.
      scheduleLineCount();
    }
  }

  function shouldAutoScan(depth: number): boolean {
    // In git repos the main tree comes from git file lists, not from filesystem
    // crawling. If the user expands a symlinked directory inside that tree, only
    // scan one level on demand; nested directories stay lazy until explicitly
    // expanded so links into large trees (iCloud/Drive/$HOME) don't trigger a
    // broad recursive crawl.
    if (repo) {
      return false;
    }
    if (browser.scanState.mode === "safe") {
      return depth <= 0;
    }
    return depth <= MAX_TREE_DEPTH;
  }

  function getScanBatchSize(): number {
    return browser.scanState.mode === "safe" ? 1 : SCAN_BATCH_SIZE;
  }

  function getScanDelay(): number {
    return browser.scanState.mode === "safe" ? SCAN_BATCH_DELAY_MS * 4 : SCAN_BATCH_DELAY_MS;
  }

  // Injected children are only partial knowledge, not a completed directory scan.
  const incompleteDirectories = new WeakSet<FileNode>();

  function ensureChildren(node: FileNode): FileNode[] {
    if (node.children === undefined) {
      incompleteDirectories.add(node);
      node.children = [];
    }
    return node.children;
  }

  function enqueueScan(node: FileNode, depth: number, force = false): void {
    if (!isCurrent() || depth > MAX_TREE_DEPTH) return;
    // Injected ancestors may already have partial children before a symlink is
    // discovered. Their realpath must fence cycles just like newly scanned links.
    if (node.realPath && hasAncestorRealPath(node.parent, node.realPath)) return;
    if (!force && browser.scanState.mode === "safe" && depth > 0) return;
    if ((node.children !== undefined && !incompleteDirectories.has(node)) || node.loading) return;
    if (scanQueued.has(node.path)) return;

    node.loading = true;
    scanQueued.add(node.path);
    scanQueue.push({ node, depth });
    browser.scanState.pending = scanQueue.length;
    browser.scanState.isScanning = true;

    scheduleScan();
  }

  function scheduleScan(): void {
    if (isCurrent() && !scanRunning && !scanTimer && scanQueue.length > 0) {
      scanTimer = setTimeout(processScanBatch, getScanDelay());
    }
  }

  async function scanDirectory(node: FileNode, depth: number, generation: number): Promise<void> {
    try {
      const entries = await readdir(node.path, { withFileTypes: true });
      if (!isCurrent(generation)) return;
      const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      if (node.path === rootPath && browser.scanState.mode === "full" && sorted.length >= SAFE_MODE_ENTRY_THRESHOLD) {
        browser.scanState.mode = "safe";
        browser.scanState.isPartial = true;
        scanQueue.length = 0;
        scanQueued.clear();
      }

      const dirs: FileNode[] = [];
      const files: FileNode[] = [];

      const visible = sorted.filter((entry) => !ignored.has(entry.name) && !entry.name.startsWith("."));
      const metadata = await mapBounded(
        visible,
        METADATA_CONCURRENCY,
        () => isCurrent(generation),
        async (entry) => {
          const fullPath = join(node.path, entry.name);
          if (entry.isDirectory()) {
            return {
              isDirectory: true,
              isSymlink: false,
              realPath: await realpath(fullPath).catch(() => resolve(fullPath)),
            };
          }
          if (entry.isSymbolicLink()) return getPathInfo(fullPath, true, () => isCurrent(generation));
          return { isDirectory: false, isSymlink: false };
        },
      );
      if (!isCurrent(generation)) return;

      // Commit in sorted order, rechecking nodes injected during metadata awaits.
      for (const [index, entry] of visible.entries()) {
        const fullPath = join(node.path, entry.name);
        const childDepth = depth + 1;
        const existing = browser.nodeByPath.get(fullPath);
        if (existing?.parent === node) {
          existing.isSymlink = metadata[index].isSymlink;
          if (metadata[index].realPath) existing.realPath = metadata[index].realPath;
          (existing.isDirectory ? dirs : files).push(existing);
          if (existing.isDirectory && shouldAutoScan(childDepth)) enqueueScan(existing, childDepth);
          if (!existing.isDirectory) queueLineCount(existing);
          continue;
        }

        if (entry.isDirectory()) {
          const dirRealPath = metadata[index].realPath;
          const dirNode: FileNode = browser.nodeByPath.get(fullPath) ?? {
            name: entry.name,
            path: fullPath,
            isDirectory: true,
            realPath: dirRealPath,
            parent: node,
            children: undefined,
            expanded: childDepth < 1,
            hasChangedChildren: false,
          };
          dirs.push(dirNode);
          browser.nodeByPath.set(fullPath, dirNode);
          if (shouldAutoScan(childDepth)) {
            enqueueScan(dirNode, childDepth);
          }
          continue;
        }

        if (entry.isSymbolicLink()) {
          const pathInfo = metadata[index];
          if (pathInfo.isDirectory) {
            const isCycle = pathInfo.realPath ? hasAncestorRealPath(node, pathInfo.realPath) : false;
            const dirNode: FileNode = browser.nodeByPath.get(fullPath) ?? {
              name: entry.name,
              path: fullPath,
              isDirectory: true,
              isSymlink: true,
              realPath: pathInfo.realPath,
              parent: node,
              children: isCycle ? [] : undefined,
              expanded: childDepth < 1,
              hasChangedChildren: false,
            };
            dirs.push(dirNode);
            browser.nodeByPath.set(fullPath, dirNode);
            if (!isCycle && shouldAutoScan(childDepth)) {
              enqueueScan(dirNode, childDepth);
            }
            continue;
          }

          const symlinkFileNode: FileNode = browser.nodeByPath.get(fullPath) ?? {
            name: entry.name,
            path: fullPath,
            isDirectory: false,
            isSymlink: true,
            parent: node,
            agentModified: agentModifiedFiles.has(fullPath),
            observedChanged: observedChangedFiles.has(fullPath),
          };
          files.push(symlinkFileNode);
          browser.nodeByPath.set(fullPath, symlinkFileNode);
          queueLineCount(symlinkFileNode);
          continue;
        }

        const fileNode: FileNode = {
          name: entry.name,
          path: fullPath,
          isDirectory: false,
          parent: node,
          agentModified: agentModifiedFiles.has(fullPath),
          observedChanged: observedChangedFiles.has(fullPath),
        };
        files.push(fileNode);
        browser.nodeByPath.set(fullPath, fileNode);
        queueLineCount(fileNode);
      }

      // Keep nodes injected while readdir/realpath was in flight, by exact path.
      node.children = [
        ...new Map([...dirs, ...files, ...(node.children ?? [])].map((child) => [child.path, child])).values(),
      ];
      sortChildren(node);
      incompleteDirectories.delete(node);
    } catch {
      if (isCurrent(generation)) {
        node.children ??= [];
      }
    } finally {
      if (isCurrent(generation)) {
        node.loading = false;
        scanQueued.delete(node.path);
      }
    }
  }

  async function processScanBatch(): Promise<void> {
    scanTimer = null;
    if (scanRunning || !isCurrent() || !browser.root) return;
    scanRunning = true;
    const generation = rootGeneration;
    try {
      const batch = scanQueue.splice(0, getScanBatchSize());
      for (const item of batch) {
        if (!isCurrent(generation)) return;
        await scanDirectory(item.node, item.depth, generation);
        if (!isCurrent(generation)) return;
      }
      browser.scanState.pending = scanQueue.length;
      browser.scanState.isScanning = scanQueue.length > 0;
      updateTreeStats(browser.root);
      browser.stats = getTreeStats(browser.root);
      refreshLists();
      requestRender();
    } finally {
      scanRunning = false;
      scheduleScan();
    }
  }

  function stopBackgroundTasks(): void {
    if (lineCountTimer) {
      clearTimeout(lineCountTimer);
      lineCountTimer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    rootGeneration += 1;
    gitRequestGeneration += 1;
    gitPending = false;
    gitController?.abort();
    stopBackgroundTasks();
    scanQueue.length = 0;
    scanQueued.clear();
    lineCountQueue.length = 0;
    lineCountPending.clear();
    lineCountCache.clear();
    textInput.reset();
    viewer.close();
  }

  function applyAgentModified(): void {
    for (const node of browser.nodeByPath.values()) {
      if (!node.isDirectory) {
        node.agentModified = agentModifiedFiles.has(node.path);
        node.observedChanged = observedChangedFiles.has(node.path);
      }
    }
  }

  function applyGitUpdates(): void {
    for (const node of browser.nodeByPath.values()) {
      const relPath = normalizeGitPath(relative(rootPath, node.path));
      node.gitStatus = gitStatus.get(relPath);
      node.diffStats = diffStats.get(relPath);
    }
  }

  function ensureNode(relPath: string, filesystem = false): FileNode | null {
    if (!browser.root) return null;
    const normalized = relPath;
    if (!normalized) return null;
    const parts = normalized.split(filesystem ? sep : "/").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length - 1 > MAX_TREE_DEPTH) return null;

    let current = browser.root;
    let currentRel = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (ignored.has(part) || part.startsWith(".")) return null;
      currentRel = currentRel ? `${currentRel}/${part}` : part;
      const dirPath = join(rootPath, currentRel);
      let dirNode = browser.nodeByPath.get(dirPath);
      if (!dirNode) {
        const depth = i + 1;
        dirNode = {
          name: part,
          path: dirPath,
          isDirectory: true,
          realPath: safeRealPathSync(dirPath),
          parent: current,
          children: filesystem ? undefined : [],
          expanded: depth < 1,
          hasChangedChildren: false,
        };
        ensureChildren(current).push(dirNode);
        sortChildren(current);
        browser.nodeByPath.set(dirPath, dirNode);
      }
      current = dirNode;
    }

    const fileName = parts[parts.length - 1];
    if (ignored.has(fileName) || fileName.startsWith(".")) return null;

    const filePath = join(rootPath, normalized);
    const existing = browser.nodeByPath.get(filePath);
    if (existing) return existing;

    const pathInfo = getPathInfoSync(filePath);
    if (pathInfo.isDirectory) {
      const isCycle = pathInfo.realPath ? hasAncestorRealPath(current, pathInfo.realPath) : false;
      const dirNode: FileNode = {
        name: fileName,
        path: filePath,
        isDirectory: true,
        isSymlink: pathInfo.isSymlink,
        realPath: pathInfo.realPath ?? safeRealPathSync(filePath),
        parent: current,
        children: !isCycle && (filesystem || pathInfo.isSymlink) ? undefined : [],
        expanded: false,
        hasChangedChildren: false,
        gitStatus: gitStatus.get(normalized),
        diffStats: diffStats.get(normalized),
      };

      ensureChildren(current).push(dirNode);
      sortChildren(current);
      browser.nodeByPath.set(filePath, dirNode);
      return dirNode;
    }

    const fileNode: FileNode = {
      name: fileName,
      path: filePath,
      isDirectory: false,
      isSymlink: pathInfo.isSymlink,
      parent: current,
      gitStatus: gitStatus.get(normalized),
      agentModified: agentModifiedFiles.has(filePath),
      observedChanged: observedChangedFiles.has(filePath),
      diffStats: diffStats.get(normalized),
    };

    ensureChildren(current).push(fileNode);
    sortChildren(current);
    browser.nodeByPath.set(filePath, fileNode);
    return fileNode;
  }

  function addUntrackedNodes(): void {
    for (const [relPath, status] of gitStatus.entries()) {
      if (!isUntrackedStatus(status)) continue;
      const node = ensureNode(relPath);
      if (node) {
        node.gitStatus = status;
        node.diffStats = diffStats.get(relPath);
        if (!node.isDirectory) {
          queueLineCount(node, true);
        }
      }
    }
  }

  function requestGitRefresh(): void {
    gitPending = true;
    void processGitRefresh();
  }

  async function processGitRefresh(): Promise<void> {
    if (gitRunning || !gitPending || !isCurrent()) return;
    gitRunning = true;
    gitPending = false;
    const generation = rootGeneration;
    const request = ++gitRequestGeneration;
    const controller = new AbortController();
    gitController = controller;
    const current = () => isCurrent(generation) && request === gitRequestGeneration && !controller.signal.aborted;
    gitState = "loading";
    try {
      gitExecutable ??= await resolveGitExecutable(controller.signal);
      if (!current()) return;
      const snapshot = await readGitMetadata(rootPath, gitExecutable, controller.signal);
      if (!current()) return;
      gitState = "ready";
      refreshMetadata(snapshot);
      requestRender();
    } catch {
      if (current()) {
        // Keep the last complete snapshot, never clear badges on failure.
        gitState = "unavailable";
        if (browser.scanState.mode === "none" && !repo && browser.root) {
          browser.scanState.mode = shouldSafeMode(rootPath) ? "safe" : "full";
          browser.scanState.isPartial = browser.scanState.mode === "safe";
          enqueueScan(browser.root, 0, true);
        }
        requestRender();
      }
    } finally {
      gitRunning = false;
      if (gitController === controller) gitController = undefined;
      // Includes a new root queued during cancellation: wait for confirmed
      // direct-child termination before starting its one coalesced request.
      if (gitPending && isCurrent()) void processGitRefresh();
    }
  }

  function refreshMetadata(snapshot?: GitMetadata): void {
    if (!isCurrent() || !browser.root) return;
    const previousDisplayList = getDisplayList();
    const currentPath = previousDisplayList[browser.selectedIndex]?.node.path;
    const viewingFile = viewer.getFile();
    let viewingFilePath = viewingFile?.path;

    if (snapshot?.repo) {
      gitStatus = snapshot.status;
      diffStats = snapshot.stats;
      const nextBranch = snapshot.branch;
      const nextFiles = snapshot.files;
      if (!repo || nextBranch !== gitBranch || JSON.stringify(nextFiles) !== JSON.stringify(gitFiles)) {
        if (nextBranch !== gitBranch) {
          // A source-selection snapshot from another branch cannot submit a
          // comment against the replacement branch, even at the same path.
          viewer.close();
          viewingFilePath = undefined;
        }
        // Retire scan/count work before replacing nodes, even at the same root.
        rootGeneration += 1;
        stopBackgroundTasks();
        scanQueue.length = 0;
        scanQueued.clear();
        lineCountQueue.length = 0;
        lineCountPending.clear();
        browser.scanState.isScanning = false;
        browser.scanState.pending = 0;
        const previousNodes = new Map(browser.nodeByPath);
        repo = true;
        browser.scanState.mode = "none";
        browser.scanState.isPartial = false;
        browser.root = buildFileTreeFromPaths(
          rootPath,
          nextFiles,
          gitStatus,
          diffStats,
          ignored,
          agentModifiedFiles,
          observedChangedFiles,
        );
        indexNodes(browser.root, browser.nodeByPath);
        for (const node of browser.nodeByPath.values()) {
          if (node.isDirectory) {
            node.expanded = previousNodes.get(node.path)?.expanded ?? node.expanded;
            if (node.expanded && node.children === undefined) enqueueScan(node, getNodeDepth(node, rootPath), true);
          }
        }
        queueLineCountsForTree(browser.root);
      } else {
        applyGitUpdates();
        addUntrackedNodes();
      }
      gitBranch = nextBranch;
      gitFiles = nextFiles;
    } else if (snapshot && !repo && browser.scanState.mode === "none") {
      browser.scanState.mode = shouldSafeMode(rootPath) ? "safe" : "full";
      browser.scanState.isPartial = browser.scanState.mode === "safe";
      enqueueScan(browser.root, 0, true);
    } else if (snapshot && repo) {
      // A removed repository is not a clean Git snapshot; replace its inventory
      // with a fresh filesystem scan rather than retaining phantom tracked rows.
      viewer.close();
      loadRoot(rootPath);
      return;
    }

    // Session-observed writes can create files after a non-Git scan finished.
    for (const path of new Set([...agentModifiedFiles, ...observedChangedFiles])) {
      const relPath = relative(rootPath, path);
      if (relPath && !isAbsolute(relPath) && relPath !== ".." && !relPath.startsWith(`..${sep}`)) {
        ensureNode(relPath, true);
      }
    }
    applyAgentModified();
    updateTreeStats(browser.root);
    browser.stats = getTreeStats(browser.root);
    refreshLists();

    const updatedDisplayList = getDisplayList();
    if (currentPath) {
      const newIdx = updatedDisplayList.findIndex((f) => f.node.path === currentPath);
      if (newIdx !== -1) {
        browser.selectedIndex = newIdx;
      }
    }

    browser.selectedIndex = Math.min(browser.selectedIndex, Math.max(0, updatedDisplayList.length - 1));

    if (viewingFilePath && browser.root) {
      const newNode = browser.nodeByPath.get(viewingFilePath) ?? findNodeByPath(browser.root, viewingFilePath);
      if (newNode) {
        if (newNode.lineCount === undefined && viewingFile?.lineCount !== undefined) {
          newNode.lineCount = viewingFile.lineCount;
        }
        viewer.updateFileRef(newNode);
      } else {
        viewer.close();
      }
    }
  }

  function loadRoot(newRoot: string): void {
    if (!isCurrent()) return;
    rootGeneration += 1;
    gitRequestGeneration += 1;
    gitController?.abort();
    stopBackgroundTasks();
    scanQueue.length = 0;
    scanQueued.clear();
    lineCountQueue.length = 0;
    lineCountPending.clear();
    rootPath = resolve(newRoot);
    repo = false;
    gitState = "loading";
    gitStatus = new Map();
    diffStats = new Map();
    gitBranch = "";
    gitFiles = [];

    const newRootNode: FileNode = {
      name: ".",
      path: rootPath,
      isDirectory: true,
      realPath: safeRealPathSync(rootPath),
      children: undefined,
      expanded: true,
      hasChangedChildren: false,
    };

    browser.root = newRootNode;

    const safeMode = !repo && shouldSafeMode(rootPath);
    browser.scanState.mode = "none";
    browser.scanState.isScanning = false;
    browser.scanState.isPartial = safeMode;
    browser.scanState.pending = 0;

    indexNodes(browser.root, browser.nodeByPath);
    refreshLists();
    browser.stats = getTreeStats(browser.root);

    browser.selectedIndex = 0;
    browser.searchQuery = "";
    browser.searchMode = false;
    textInput.reset();
    browser.lastPollTime = Date.now();

    requestGitRefresh();
  }

  function setRoot(newRoot: string): void {
    if (viewer.isOpen()) {
      viewer.close();
    }
    loadRoot(newRoot);
    requestRender();
  }

  loadRoot(initialRoot);

  function getDisplayList(): FlatNode[] {
    let list = browser.searchQuery ? browser.fullList : browser.flatList;

    if (browser.showOnlyChanged) {
      list = list.filter(
        (f) =>
          f.node.gitStatus ||
          f.node.agentModified ||
          f.node.observedChanged ||
          (f.node.isDirectory && f.node.hasChangedChildren),
      );
    }

    if (browser.searchQuery) {
      const q = browser.searchQuery.toLowerCase();
      list = list.filter((f) => f.node.name.toLowerCase().includes(q));
    }

    return list;
  }

  function navigateToChange(direction: 1 | -1): void {
    if (!browser.root) return;

    const changedFiles = collectChangedFiles(browser.root);
    if (changedFiles.length === 0) return;

    const displayList = getDisplayList();
    const currentNode = displayList[browser.selectedIndex]?.node;

    let currentIdx = -1;
    if (currentNode && !currentNode.isDirectory) {
      currentIdx = changedFiles.findIndex((c) => c.file.path === currentNode.path);
    }

    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 1 ? 0 : changedFiles.length - 1;
    } else {
      nextIdx = currentIdx + direction;
      if (nextIdx < 0) nextIdx = changedFiles.length - 1;
      if (nextIdx >= changedFiles.length) nextIdx = 0;
    }

    const target = changedFiles[nextIdx];

    const ancestorSet = new Set(target.ancestors);
    collapseAllExcept(browser.root, ancestorSet);

    for (const ancestor of target.ancestors) {
      ancestor.expanded = true;
      enqueueScan(ancestor, getNodeDepth(ancestor, rootPath), true);
    }

    browser.flatList = flattenTree(browser.root);

    const newDisplayList = getDisplayList();
    const targetIdx = newDisplayList.findIndex((f) => f.node.path === target.file.path);
    if (targetIdx !== -1) {
      browser.selectedIndex = targetIdx;
    }
  }

  function toggleDir(node: FileNode): void {
    if (node.isDirectory) {
      node.expanded = !node.expanded;
      if (node.expanded) {
        enqueueScan(node, getNodeDepth(node, rootPath), true);
      }
      refreshLists();
    }
  }

  function openFile(node: FileNode): void {
    viewer.setFile(node);
  }

  function renderBrowser(width: number): string[] {
    const lines: string[] = [];
    const pathDisplay = sanitizeDisplayText(formatRootPath(rootPath));
    const branchDisplay = gitBranch ? theme.fg("accent", ` (${sanitizeDisplayText(gitBranch)})`) : "";
    const stats = browser.stats;

    let statsDisplay = "";
    if (stats.totalLines !== undefined) {
      statsDisplay += theme.fg("dim", ` ${stats.totalLines}L`);
    }
    if (stats.additions > 0) statsDisplay += theme.fg("success", ` +${stats.additions}`);
    if (stats.deletions > 0) statsDisplay += theme.fg("error", ` -${stats.deletions}`);

    const hasActivity = browser.scanState.isScanning || lineCountPending.size > 0;
    if (hasActivity) {
      browser.scanState.spinnerIndex = (browser.scanState.spinnerIndex + 1) % SPINNER_FRAMES.length;
    }
    const spinner = SPINNER_FRAMES[browser.scanState.spinnerIndex];
    const activityParts: string[] = [];
    if (browser.scanState.isScanning) activityParts.push(`${spinner} scanning`);
    if (lineCountPending.size > 0) activityParts.push(`${spinner} counts`);
    const activityIndicator = activityParts.length > 0 ? theme.fg("dim", ` ${activityParts.join(" ")}`) : "";
    const partialIndicator = browser.scanState.isPartial ? theme.fg("warning", " [partial]") : "";
    const gitIndicator =
      gitState === "ready"
        ? ""
        : theme.fg("warning", gitState === "loading" ? " [Git loading]" : " [Git unavailable; stale]");

    const searchIndicator = browser.searchMode ? theme.fg("accent", `  /${browser.searchQuery}█`) : "";

    lines.push(
      truncateToWidth(
        theme.bold(pathDisplay) +
          branchDisplay +
          statsDisplay +
          activityIndicator +
          partialIndicator +
          gitIndicator +
          searchIndicator,
        width,
      ),
    );
    lines.push(theme.fg("borderAccent", "─".repeat(width)));

    const displayList = getDisplayList();
    if (displayList.length === 0) {
      const emptyLabel = browser.scanState.isScanning
        ? "  (loading...)"
        : `  (no files${browser.searchQuery ? ` matching '${browser.searchQuery}'` : ""})`;
      lines.push(theme.fg("dim", emptyLabel));
      for (let i = 1; i < browser.browserHeight; i++) {
        lines.push("");
      }
    } else {
      const start = Math.max(
        0,
        Math.min(
          browser.selectedIndex - Math.floor(browser.browserHeight / 2),
          displayList.length - browser.browserHeight,
        ),
      );
      const end = Math.min(displayList.length, start + browser.browserHeight);

      for (let i = start; i < end; i++) {
        const { node, depth } = displayList[i];
        const isSelected = i === browser.selectedIndex;
        const indent = "  ".repeat(depth);
        const icon = node.isDirectory ? (node.expanded ? "▼ " : "▶ ") : "  ";

        const status = formatNodeStatus(node, theme);
        const meta = formatNodeMeta(node, theme);
        const name = formatNodeName(node, theme);

        let line = `${indent}${icon}${name}${status}${meta}`;
        line = truncateToWidth(line, width);

        if (isSelected) {
          line = theme.bg("selectedBg", line);
        }

        lines.push(line);
      }

      const renderedCount = end - start;
      for (let i = renderedCount; i < browser.browserHeight; i++) {
        lines.push("");
      }

      const pct = displayList.length > 1 ? Math.round((browser.selectedIndex / (displayList.length - 1)) * 100) : 100;
      lines.push(theme.fg("dim", `  ${browser.selectedIndex + 1}/${displayList.length} (${pct}%)`));
    }

    lines.push(theme.fg("borderAccent", "─".repeat(width)));
    const changedIndicator = browser.showOnlyChanged ? theme.fg("warning", " [changed only]") : "";
    const help = browser.searchMode
      ? theme.fg("dim", "Type to search  ↑↓: nav  Enter: confirm  Esc: cancel")
      : theme.fg("dim", "j/k: nav  u: up  .: home  []: next/prev change  c: toggle changed  /: search  q: close") +
        changedIndicator;
    lines.push(truncateToWidth(help, width));

    // Every result and status row must fit, including empty-search text and
    // position counters in very narrow viewports.
    return lines.map((line) => truncateToWidth(line, width));
  }

  function handleViewerInput(data: string): void {
    const action: ViewerAction = viewer.handleInput(data);
    if (action.type === "close") {
      viewer.close();
      return;
    }
    if (action.type === "navigate") {
      viewer.close();
      navigateToChange(action.direction);
      const displayList = getDisplayList();
      const item = displayList[browser.selectedIndex];
      if (item && !item.node.isDirectory) {
        openFile(item.node);
      }
    }
  }

  function handleBrowserInput(data: string): void {
    const displayList = getDisplayList();
    const maxIndex = Math.max(0, displayList.length - 1);

    if (matchesKey(data, "q") && !browser.searchMode) {
      dispose();
      onClose();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (browser.searchMode) {
        browser.searchMode = false;
        browser.searchQuery = "";
        textInput.reset();
      } else {
        dispose();
        onClose();
      }
      return;
    }
    if (matchesKey(data, "/") && !browser.searchMode) {
      browser.searchMode = true;
      browser.searchQuery = "";
      textInput.reset();
      return;
    }
    if (browser.searchMode) {
      if (matchesKey(data, Key.enter)) {
        browser.searchMode = false;
        browser.selectedIndex = 0;
        textInput.reset();
      } else if (matchesKey(data, Key.backspace)) {
        browser.searchQuery = browser.searchQuery.slice(0, -1);
        browser.selectedIndex = 0;
      } else if (matchesKey(data, Key.down)) {
        browser.selectedIndex = Math.min(maxIndex, browser.selectedIndex + 1);
      } else if (matchesKey(data, Key.up)) {
        browser.selectedIndex = Math.max(0, browser.selectedIndex - 1);
      } else {
        const text = textInput.push(data);
        if (text) {
          browser.searchQuery += text;
          browser.selectedIndex = 0;
        }
      }
      return;
    }
    if (matchesKey(data, "u")) {
      const parent = resolve(rootPath, "..");
      if (parent !== rootPath) {
        setRoot(parent);
      }
      return;
    }
    if (matchesKey(data, ".")) {
      if (rootPath !== initialRoot) {
        setRoot(initialRoot);
      }
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
      browser.selectedIndex = Math.min(maxIndex, browser.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
      browser.selectedIndex = Math.max(0, browser.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const item = displayList[browser.selectedIndex];
      if (item) {
        if (item.node.isDirectory) {
          toggleDir(item.node);
        } else {
          openFile(item.node);
        }
      }
      return;
    }
    if (matchesKey(data, "l") || matchesKey(data, Key.right)) {
      const item = displayList[browser.selectedIndex];
      if (item?.node.isDirectory && !item.node.expanded) {
        toggleDir(item.node);
      } else if (item && !item.node.isDirectory) {
        openFile(item.node);
      }
      return;
    }
    if (matchesKey(data, "h") || matchesKey(data, Key.left)) {
      const item = displayList[browser.selectedIndex];
      if (item?.node.isDirectory && item.node.expanded) {
        toggleDir(item.node);
      }
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      browser.selectedIndex = Math.min(maxIndex, browser.selectedIndex + browser.browserHeight);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      browser.selectedIndex = Math.max(0, browser.selectedIndex - browser.browserHeight);
      return;
    }
    if (matchesKey(data, "+") || matchesKey(data, "=")) {
      browser.browserHeight = Math.min(MAX_BROWSER_HEIGHT, browser.browserHeight + 5);
      return;
    }
    if (matchesKey(data, "-") || matchesKey(data, "_")) {
      browser.browserHeight = Math.max(MIN_PANEL_HEIGHT, browser.browserHeight - 5);
      return;
    }
    if (matchesKey(data, "c")) {
      browser.showOnlyChanged = !browser.showOnlyChanged;
      browser.selectedIndex = 0;
      return;
    }
    if (matchesKey(data, "]")) {
      navigateToChange(1);
      return;
    }
    if (matchesKey(data, "[")) {
      navigateToChange(-1);
      return;
    }
  }

  return {
    render(width: number): string[] {
      if (!isCurrent()) return [];
      width = Math.max(1, width);
      const now = Date.now();
      if (now - browser.lastPollTime > POLL_INTERVAL_MS) {
        browser.lastPollTime = now;
        refreshMetadata();
        requestGitRefresh();
      }

      if (viewer.isOpen()) {
        return viewer.render(width);
      }

      return renderBrowser(width);
    },

    handleInput(data: string): void {
      if (!isCurrent()) return;
      if (viewer.isOpen()) {
        handleViewerInput(data);
      } else {
        handleBrowserInput(data);
      }
    },

    invalidate(): void {},
    dispose,
  };
}
