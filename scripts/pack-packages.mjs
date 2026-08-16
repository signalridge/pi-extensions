import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const packagesRoot = join(root, "packages");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const includeExperimental = argv.includes("--include-experimental");
const exactSelection = argv.includes("--exact-selection");
const requestedPackages = new Set(
  argv
    .flatMap((arg) => {
      if (arg.startsWith("--package=")) return [arg.slice("--package=".length)];
      if (arg.startsWith("--packages=")) return arg.slice("--packages=".length).split(",");
      return [];
    })
    .map((value) => value.trim())
    .filter(Boolean),
);
const destinationArg = argv.find((arg) => arg.startsWith("--pack-destination="))?.slice("--pack-destination=".length);
const destination = destinationArg ? resolve(destinationArg) : join(root, ".release");

function packageDirs() {
  return readdirSync(packagesRoot)
    .filter((name) => statSync(join(packagesRoot, name)).isDirectory())
    .sort();
}

function packageManifest(directory) {
  return JSON.parse(readFileSync(join(packagesRoot, directory, "package.json"), "utf8"));
}

function localDependencyNames(manifest) {
  return new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
}

function selectedPackageDirs() {
  const dirs = packageDirs();
  if (requestedPackages.size === 0) return dirs;
  const unknown = [...requestedPackages].filter(
    (name) => !dirs.includes(name) && !dirs.some((dir) => `@signalridge/${dir}` === name),
  );
  if (unknown.length > 0) throw new Error(`unknown package selection: ${unknown.join(", ")}`);

  const byPackageName = new Map(dirs.map((directory) => [packageManifest(directory).name, directory]));
  const selected = new Set(
    dirs.filter((name) => requestedPackages.has(name) || requestedPackages.has(`@signalridge/${name}`)),
  );
  if (exactSelection) return dirs.filter((name) => selected.has(name));

  const pending = [...selected];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const dependency of localDependencyNames(packageManifest(directory))) {
      const dependencyDirectory = byPackageName.get(dependency);
      if (dependencyDirectory && !selected.has(dependencyDirectory)) {
        selected.add(dependencyDirectory);
        pending.push(dependencyDirectory);
      }
    }
  }
  return dirs.filter((name) => selected.has(name));
}

function parsePackResult(stdout, packageName) {
  try {
    const parsed = JSON.parse(stdout.trim());
    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!info || typeof info.filename !== "string" || typeof info.integrity !== "string") {
      throw new Error("npm pack returned no filename/integrity");
    }
    if (info.name !== packageName) throw new Error(`npm pack returned ${info.name}, expected ${packageName}`);
    return info;
  } catch (error) {
    throw new Error(
      `could not parse npm pack output for ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runNpmPack(packageRoot, packageName, packDestination) {
  const result = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDestination], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed for ${packageName} with exit ${result.status}`);
  return parsePackResult(result.stdout ?? "", packageName);
}

function command(commandName, args, cwd = root) {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${commandName} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout ?? "";
}

function tarEntries(tarball) {
  return new Set(
    command("tar", ["-tzf", tarball])
      .split("\n")
      .map((entry) => entry.replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function sourceCandidates(base) {
  const withoutKnownExtension = base.replace(/\.(?:[cm]?js|jsx|tsx|ts|json)$/, "");
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${withoutKnownExtension}.ts`,
    `${withoutKnownExtension}.tsx`,
    `${withoutKnownExtension}.js`,
    `${withoutKnownExtension}.mjs`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
}

function resolveLocalSource(packageRoot, importer, specifier) {
  const base = resolve(dirname(importer), specifier);
  const packagePrefix = `${resolve(packageRoot)}${sep}`;
  if (base !== resolve(packageRoot) && !base.startsWith(packagePrefix)) {
    throw new Error(`local import escapes package: ${relative(root, importer)} -> ${specifier}`);
  }
  for (const candidate of sourceCandidates(base)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`local import is missing from source tree: ${relative(root, importer)} -> ${specifier}`);
}

function localImportSpecifiers(source) {
  const imports = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
  for (const match of source.matchAll(pattern)) imports.push(match[2]);
  return imports;
}

export function extractTarball(tarball) {
  const entries = tarEntries(tarball);
  const extractedRoot = mkdtempSync(join(tmpdir(), "pi-pack-extract-"));
  try {
    command("tar", ["-xzf", tarball, "-C", extractedRoot]);
  } catch (error) {
    // mkdtemp already created the directory, so a failed extraction would leave
    // it behind: the caller only learns about a root it never received.
    rmSync(extractedRoot, { recursive: true, force: true });
    throw error;
  }
  return { entries, extractedRoot };
}

function validatePackedDependencies(packageRoot, manifest, extraction) {
  const { entries, extractedRoot } = extraction;
  const packagedManifestPath = join(extractedRoot, "package", "package.json");
  if (!existsSync(packagedManifestPath)) throw new Error("tarball does not contain package/package.json");
  const packagedManifest = JSON.parse(readFileSync(packagedManifestPath, "utf8"));
  if (packagedManifest.name !== manifest.name || packagedManifest.version !== manifest.version) {
    throw new Error(`packed manifest identity mismatch for ${manifest.name}`);
  }

  const entrypoints = manifest.pi?.extensions;
  if (!Array.isArray(entrypoints) || entrypoints.length === 0) {
    if (manifest.signalridgePackage?.kind === "library") return { entryCount: entries.size, dependencyCount: 0 };
    throw new Error(`${manifest.name} has no Pi entrypoints`);
  }
  const pending = entrypoints.map((entry) => resolve(packageRoot, entry));
  const visited = new Set();
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!sourcePath || visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    const packageRelative = relative(packageRoot, sourcePath).split(sep).join("/");
    if (packageRelative.startsWith("../") || packageRelative === "..") {
      throw new Error(`entrypoint escapes package: ${packageRelative}`);
    }
    if (!entries.has(`package/${packageRelative}`)) {
      throw new Error(`${manifest.name} tarball omits imported local file: ${packageRelative}`);
    }
    const source = readFileSync(sourcePath, "utf8");
    for (const specifier of localImportSpecifiers(source)) {
      pending.push(resolveLocalSource(packageRoot, sourcePath, specifier));
    }
  }
  return { entryCount: entries.size, dependencyCount: visited.size };
}

// A published README is rendered from the tarball, not from the repository, so
// anything it points at has to be inside the tarball too. Every judgement call
// below leans toward accepting: a false positive blocks the release of correct
// prose, while a missed link only leaves an already broken reference uncaught.
const INLINE_LINK_PATTERN = /!?\[[^\]\n]*\]\(\s*(?:<([^<>\n]*)>|([^()\s]+))\s*(?:"[^"]*"|'[^']*'|\([^()]*\))?\s*\)/g;
// The pattern above matches the innermost link of a nested construct such as a
// linked image; this one tolerates one level of nesting and link text wrapped
// across lines so the outer target is validated as well.
const NESTED_LINK_PATTERN =
  /!?\[(?:[^[\]\n]|\n(?!\s*\n)|\[[^[\]\n]*\])*\]\(\s*(?:<([^<>\n]*)>|([^()\s]+))\s*(?:"[^"]*"|'[^']*'|\([^()]*\))?\s*\)/g;
// Reference definitions carry the target of every [text][ref] and [ref] link.
// Footnote definitions ([^1]: prose) are not links, and requiring the line to
// end after the destination keeps ordinary prose out of the scan.
const REFERENCE_DEFINITION_PATTERN =
  /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(?:<([^<>\n]*)>|(\S+))[ \t]*(?:"[^"]*"|'[^']*'|\([^()]*\))?[ \t]*$/gm;
// GitHub and npm render raw HTML in markdown, so its targets must ship too.
const HTML_TARGET_PATTERN =
  /<(?:img|source|video|audio|embed|iframe|a)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
// URI schemes are case-insensitive (RFC 3986) and a protocol-relative target is
// remote as well, so anything carrying a scheme resolves outside the tarball.
const REMOTE_TARGET_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// A templated target is not a path this gate can resolve.
const TEMPLATED_TARGET_PATTERN = /[{}$]/;
const FENCE_OPEN_PATTERN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_PATTERN = /^(`+|~+)[ \t]*$/;
const ATX_HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/;
const SETEXT_UNDERLINE_PATTERN = /^ {0,3}(?:=+|-+)[ \t]*$/;
const SIGNALRIDGE_PACKAGE_KEYS = ["kind", "requiredPackagedFiles"];

function splitIndent(line) {
  let index = 0;
  let indent = 0;
  while (index < line.length && (line[index] === " " || line[index] === "\t")) {
    indent += line[index] === "\t" ? 4 - (indent % 4) : 1;
    index += 1;
  }
  return { indent, content: line.slice(index) };
}

function stripCommentSpans(content, open) {
  let text = "";
  let rest = content;
  let commented = open;
  while (rest.length > 0) {
    if (commented) {
      const end = rest.indexOf("-->");
      if (end === -1) return [text, true];
      rest = rest.slice(end + 3);
      commented = false;
      continue;
    }
    const start = rest.indexOf("<!--");
    if (start === -1) return [text + rest, false];
    text += rest.slice(0, start);
    rest = rest.slice(start + 4);
    commented = true;
  }
  return [text, commented];
}

// Fenced and indented examples document link syntax; they are not links the
// registry renders. An unterminated comment keeps swallowing lines rather than
// failing, because a lone `<!--` inside an inline code span is ordinary prose.
function scannableMarkdown(markdown) {
  const scanned = [];
  let fence;
  let commented = false;
  let indentedCode = false;
  let previousBlank = true;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const { indent, content } = splitIndent(line);
    if (fence) {
      const close = indent <= fence.indent + 3 ? FENCE_CLOSE_PATTERN.exec(content) : undefined;
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = undefined;
      scanned.push("");
      previousBlank = false;
      continue;
    }
    const [text, stillCommented] = stripCommentSpans(content, commented);
    commented = stillCommented;
    const blank = text.trim().length === 0;
    if (indentedCode) {
      if (blank || indent >= 4) {
        scanned.push("");
        previousBlank = blank;
        continue;
      }
      indentedCode = false;
    }
    // A closing fence carries no info string, so a line like ```js inside a
    // block is content; a backtick fence may not carry a backtick at all.
    const open = FENCE_OPEN_PATTERN.exec(text);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { marker: open[1][0], length: open[1].length, indent };
      scanned.push("");
      previousBlank = false;
      continue;
    }
    if (previousBlank && !blank && indent >= 4) {
      indentedCode = true;
      scanned.push("");
      previousBlank = false;
      continue;
    }
    scanned.push(blank ? "" : `${" ".repeat(indent)}${text}`);
    previousBlank = blank;
  }
  return { text: scanned.join("\n"), unterminatedFence: fence !== undefined };
}

function decodeTarget(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

// GitHub slugs the rendered heading, so inline markup has to go before slugging.
function headingText(raw) {
  return raw
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*~]+/g, "")
    .trim();
}

function headingAnchors(raw) {
  const text = headingText(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim();
  // GitHub and npm give every space its own hyphen, so dropped punctuation
  // leaves a run of hyphens. Accept the collapsed spelling as well, plus the
  // emphasis-stripped spelling of a heading whose underscores were markup.
  const anchors = new Set([text.replace(/ /g, "-"), text.replace(/ +/g, "-")]);
  for (const anchor of [...anchors]) anchors.add(anchor.replace(/_/g, ""));
  anchors.delete("");
  return anchors;
}

// Anchors come from the unmodified source: a heading the stripper removed is
// still a heading the registry renders, and over-accepting an anchor is the
// harmless direction.
function documentAnchors(markdown) {
  const anchors = new Set();
  for (const match of markdown.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
    anchors.add(match[1]);
    anchors.add(match[1].toLowerCase());
  }
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const heading = ATX_HEADING_PATTERN.exec(line);
    if (heading) {
      for (const anchor of headingAnchors(heading[1] ?? "")) anchors.add(anchor);
      continue;
    }
    if (index === 0 || !SETEXT_UNDERLINE_PATTERN.test(line)) continue;
    const previous = lines[index - 1];
    if (previous.trim().length === 0) continue;
    if (SETEXT_UNDERLINE_PATTERN.test(previous) || ATX_HEADING_PATTERN.test(previous)) continue;
    for (const anchor of headingAnchors(previous.trim())) anchors.add(anchor);
  }
  return anchors;
}

function anchorExists(anchors, anchor) {
  const decoded = decodeTarget(anchor);
  for (const candidate of [anchor, anchor.toLowerCase(), decoded, decoded.toLowerCase()]) {
    if (anchors.has(candidate)) return true;
    // GitHub's slugger disambiguates a repeated heading with a -1/-2 suffix.
    const duplicate = /^(.+)-\d+$/.exec(candidate);
    if (duplicate && anchors.has(duplicate[1])) return true;
  }
  return false;
}

function documentTargets(source) {
  const targets = new Set();
  for (const pattern of [INLINE_LINK_PATTERN, NESTED_LINK_PATTERN, REFERENCE_DEFINITION_PATTERN, HTML_TARGET_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (target.length > 0) targets.add(target);
    }
  }
  return targets;
}

// npm tarballs list files only, so a link to a packed directory has no entry of
// its own even though every file under it ships.
function targetIsPacked(entries, packageRelative) {
  if (entries.has(`package/${packageRelative}`)) return true;
  const prefix = `package/${packageRelative}/`;
  for (const entry of entries) {
    if (entry.startsWith(prefix)) return true;
  }
  return false;
}

function packagedDocuments(entries) {
  return [...entries]
    .filter((entry) => entry.startsWith("package/") && entry.endsWith(".md"))
    .map((entry) => entry.slice("package/".length))
    .sort();
}

// An unknown key here is a silent opt-out of whatever check it meant to request.
function validateSignalridgePackage(manifest) {
  const section = manifest.signalridgePackage;
  if (section === undefined) return;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`${manifest.name} signalridgePackage must be an object`);
  }
  const unknown = Object.keys(section)
    .filter((key) => !SIGNALRIDGE_PACKAGE_KEYS.includes(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(
      `${manifest.name} signalridgePackage has unknown keys: ${unknown.join(", ")} (expected ${SIGNALRIDGE_PACKAGE_KEYS.join(", ")})`,
    );
  }
}

function requiredPackagedFiles(manifest) {
  const required = manifest.signalridgePackage?.requiredPackagedFiles;
  if (required === undefined) return [];
  if (!Array.isArray(required) || required.some((file) => typeof file !== "string" || file.trim().length === 0)) {
    throw new Error(`${manifest.name} signalridgePackage.requiredPackagedFiles must be a list of non-empty strings`);
  }
  return required;
}

export function validatePackagedDocs(manifest, extraction) {
  const { entries, extractedRoot } = extraction;
  const packagedRoot = join(extractedRoot, "package");
  validateSignalridgePackage(manifest);
  for (const file of requiredPackagedFiles(manifest)) {
    if (!entries.has(`package/${file}`)) {
      throw new Error(
        `${manifest.name} tarball omits required packaged file: ${file} (add it to package.json "files")`,
      );
    }
  }
  // Without a packaged README the whole gate would pass on an empty scan.
  if (!entries.has("package/README.md")) {
    throw new Error(`${manifest.name} tarball omits README.md (add it to package.json "files")`);
  }

  const documents = new Map();
  const readDocument = (document) => {
    const cached = documents.get(document);
    if (cached !== undefined) return cached;
    const raw = readFileSync(join(packagedRoot, document), "utf8");
    const scanned = scannableMarkdown(raw);
    if (scanned.unterminatedFence) {
      throw new Error(`${manifest.name} documentation has an unterminated code fence: ${document}`);
    }
    const record = { text: scanned.text, raw, anchors: undefined };
    documents.set(document, record);
    return record;
  };
  const anchorsOf = (record) => {
    record.anchors ??= documentAnchors(record.raw);
    return record.anchors;
  };

  let linkCount = 0;
  for (const document of packagedDocuments(entries)) {
    const record = readDocument(document);
    for (const target of documentTargets(record.text)) {
      if (REMOTE_TARGET_PATTERN.test(target) || TEMPLATED_TARGET_PATTERN.test(target)) continue;
      linkCount += 1;
      const hash = target.indexOf("#");
      const anchor = hash === -1 ? undefined : target.slice(hash + 1);
      const beforeHash = hash === -1 ? target : target.slice(0, hash);
      const query = beforeHash.indexOf("?");
      const path = query === -1 ? beforeHash : beforeHash.slice(0, query);
      if (path.length === 0) {
        if (anchor && !anchorExists(anchorsOf(record), anchor)) {
          throw new Error(`${manifest.name} documentation anchor does not resolve: ${document} -> ${target}`);
        }
        continue;
      }

      const documentRoot = dirname(join(packagedRoot, document));
      const resolved = [...new Set([path, decodeTarget(path)])].map((candidate) =>
        relative(packagedRoot, resolve(documentRoot, candidate)).split(sep).join("/"),
      );
      if (resolved.every((packageRelative) => packageRelative === ".." || packageRelative.startsWith("../"))) {
        throw new Error(`${manifest.name} documentation target escapes package: ${document} -> ${target}`);
      }
      const packed = resolved.find((packageRelative) => targetIsPacked(entries, packageRelative));
      if (packed === undefined) {
        throw new Error(
          `${manifest.name} tarball omits documentation target: ${document} -> ${target} (add ${resolved[0]} to package.json "files")`,
        );
      }
      if (anchor && packed.endsWith(".md") && !anchorExists(anchorsOf(readDocument(packed)), anchor)) {
        throw new Error(`${manifest.name} documentation anchor does not resolve: ${document} -> ${target}`);
      }
    }
  }
  return { documentCount: documents.size, linkCount };
}

function packOne(directory, packDestination) {
  const packageRoot = join(packagesRoot, directory);
  const manifest = packageManifest(directory);
  if (manifest.private === true) throw new Error(`refusing to pack private package ${manifest.name}`);
  if (manifest.piExtension?.lifecycle === "experimental" && !includeExperimental) return undefined;
  const info = runNpmPack(packageRoot, manifest.name, packDestination);
  const tarball = join(packDestination, info.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);
  const extraction = extractTarball(tarball);
  let packed;
  let docs;
  try {
    packed = validatePackedDependencies(packageRoot, manifest, extraction);
    docs = validatePackagedDocs(manifest, extraction);
  } finally {
    rmSync(extraction.extractedRoot, { recursive: true, force: true });
  }
  console.log(
    `pack: ${manifest.name}@${manifest.version} ${info.integrity} (${packed.dependencyCount} local files, ${docs.linkCount} doc links)`,
  );
  return { directory, packageRoot, manifest, info, tarball };
}

function main() {
  const temporaryDestination = dryRun && !destinationArg ? mkdtempSync(join(tmpdir(), "pi-pack-check-")) : undefined;
  const packDestination = temporaryDestination ?? destination;
  mkdirSync(packDestination, { recursive: true });
  try {
    const packed = selectedPackageDirs()
      .map((directory) => packOne(directory, packDestination))
      .filter(Boolean);
    if (packed.length === 0) throw new Error("no packages selected for packing");
    console.log(`pack-packages: ${dryRun ? "validated" : `wrote ${packed.length} tarballs to ${packDestination}`}`);
  } finally {
    if (temporaryDestination) rmSync(temporaryDestination, { recursive: true, force: true });
  }
}

// A release gate that exits 0 without running is the worst failure mode, so
// resolve symlinks before deciding this module was the process entrypoint.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
