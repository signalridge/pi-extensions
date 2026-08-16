import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { validatePackageConfig } from "./check-package-config.mjs";
import { extractTarball, validatePackagedDocs } from "./pack-packages.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture(
  check = "bun run lint && bun run typecheck && bun run test",
  directory = "pi-demo",
  packageName = `@signalridge/${directory}`,
) {
  const root = mkdtempSync(join(tmpdir(), "pi-package-config-"));
  tempRoots.push(root);
  const packageRoot = join(root, "packages", directory);
  mkdirSync(packageRoot, { recursive: true });
  for (const file of ["tsconfig.json", "README.md", "CHANGELOG.md", "LICENSE", "src/index.ts"]) {
    const path = join(packageRoot, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.endsWith(".json") ? "{}\n" : "fixture\n");
  }
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        type: "module",
        private: false,
        pi: { extensions: ["./src/index.ts"] },
        piExtension: { lifecycle: "stable" },
        repository: { directory: `packages/${directory}` },
        publishConfig: { access: "public" },
        files: ["CHANGELOG.md"],
        scripts: {
          lint: "biome check .",
          typecheck: "tsc --noEmit",
          test: "bun test",
          check,
          format: "biome check --write .",
        },
      },
      null,
      2,
    ),
  );
  return root;
}

describe("check-package-config", () => {
  it("keeps Changesets updating ordinary internal dependency ranges", () => {
    const config = JSON.parse(readFileSync(new URL("../.changeset/config.json", import.meta.url), "utf8"));
    assert.equal(config.bumpVersionsWithWorkspaceProtocolOnly, false);
  });
  it("accepts a complete publishable package manifest", () => {
    assert.equal(validatePackageConfig(makeFixture()), 1);
  });

  it("rejects a package directory without the pi-* prefix", () => {
    assert.throws(() => validatePackageConfig(makeFixture(undefined, "demo")), /must use a pi-\* directory name/);
  });

  it("rejects a manifest name without the @signalridge/pi-* prefix", () => {
    assert.throws(
      () => validatePackageConfig(makeFixture(undefined, "pi-demo", "@signalridge/demo")),
      /must use a matching @signalridge\/pi-\* package name/,
    );
  });

  it("rejects a check script that omits the package test phase", () => {
    assert.throws(
      () => validatePackageConfig(makeFixture("bun run lint && bun run typecheck")),
      /check script must run test/,
    );
  });
});

// The packed tarball is what the registry renders, so documentation targets are
// validated against tarball entries rather than the working tree.
function makePackedFixture(files, signalridgePackage) {
  const extractedRoot = mkdtempSync(join(tmpdir(), "pi-packed-docs-"));
  tempRoots.push(extractedRoot);
  const manifest = { name: "@signalridge/pi-demo", version: "1.0.0", signalridgePackage };
  const entries = new Set();
  for (const [path, content] of Object.entries({ "package.json": "{}\n", "README.md": "# Demo\n", ...files })) {
    const absolute = join(extractedRoot, "package", path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
    entries.add(`package/${path}`);
  }
  return [manifest, { entries, extractedRoot }];
}

describe("packaged documentation", () => {
  it("rejects a README image that the tarball omits", () => {
    assert.throws(
      () => validatePackagedDocs(...makePackedFixture({ "README.md": "![shot](assets/shot.png)\n" })),
      /tarball omits documentation target: README\.md -> assets\/shot\.png/,
    );
  });

  it("accepts a packed documentation target", () => {
    const packed = makePackedFixture({
      "README.md": "![shot](./assets/shot.png)\n",
      "assets/shot.png": "png\n",
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 1);
  });

  it("resolves targets against the linking document, not the package root", () => {
    assert.throws(
      () =>
        validatePackagedDocs(...makePackedFixture({ "docs/guide.md": "[license](LICENSE)\n", LICENSE: "license\n" })),
      /tarball omits documentation target: docs\/guide\.md -> LICENSE \(add docs\/LICENSE/,
    );
  });

  it("rejects a documentation target outside the package", () => {
    assert.throws(
      () => validatePackagedDocs(...makePackedFixture({ "README.md": "[escape](../../etc/passwd)\n" })),
      /documentation target escapes package/,
    );
  });

  it("skips remote link targets and counts only the links it validated", () => {
    const packed = makePackedFixture({
      "README.md": "[pi](https://pi.dev) [mail](mailto:dev@example.com) [insecure](http://example.com/x.png)\n",
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  // URI schemes are case-insensitive and the registry resolves every one of
  // them itself; treating them as package-relative paths breaks the release.
  it("skips uppercase, non-http and protocol-relative remote targets", () => {
    const packed = makePackedFixture({
      "README.md": [
        "[a](HTTPS://example.com)",
        "[b](Https://example.com)",
        "![c](data:image/png;base64,iVBORw0KGgo=)",
        "[d](tel:+15551234)",
        "[e](vscode://file/x)",
        "[f](//cdn.example.com/x.png)",
        "[g](MAILTO:dev@example.com)",
      ].join("\n"),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  it("accepts heading and explicit anchors, including punctuation-collapsed slugs", () => {
    const packed = makePackedFixture({
      "README.md": [
        "[a](#export)",
        "[b](#tool--extension-scoping)",
        '[c](#manual)<a id="manual"></a>',
        "[d](guide.md#deep-dive)",
        "## Export",
        "## Tool & extension scoping",
      ].join("\n"),
      "guide.md": "### Deep dive\n",
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 4);
  });

  it("rejects an anchor no heading defines", () => {
    assert.throws(
      () => validatePackagedDocs(...makePackedFixture({ "README.md": "[a](#exports)\n\n## Export\n" })),
      /documentation anchor does not resolve: README\.md -> #exports/,
    );
  });

  it("rejects a cross-document anchor no heading defines", () => {
    assert.throws(
      () =>
        validatePackagedDocs(
          ...makePackedFixture({ "README.md": "[a](guide.md#missing)\n", "guide.md": "## Deep dive\n" }),
        ),
      /documentation anchor does not resolve: README\.md -> guide\.md#missing/,
    );
  });

  it("ignores links inside fenced code blocks", () => {
    const packed = makePackedFixture({
      "README.md": ["Write it like this:", "", "```markdown", "![shot](assets/missing.png)", "```", ""].join("\n"),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  it("enforces requiredPackagedFiles that no link points at", () => {
    assert.throws(
      () =>
        validatePackagedDocs(
          ...makePackedFixture({ "README.md": "docs\n" }, { requiredPackagedFiles: ["examples/template.md"] }),
        ),
      /tarball omits required packaged file: examples\/template\.md/,
    );
    const packed = makePackedFixture(
      { "README.md": "docs\n", "examples/template.md": "template\n" },
      { requiredPackagedFiles: ["examples/template.md"] },
    );
    assert.equal(validatePackagedDocs(...packed).documentCount, 2);
  });

  it("rejects a malformed requiredPackagedFiles declaration", () => {
    assert.throws(
      () => validatePackagedDocs(...makePackedFixture({ "README.md": "docs\n" }, { requiredPackagedFiles: "src" })),
      /requiredPackagedFiles must be a list of non-empty strings/,
    );
  });

  it("rejects an unknown signalridgePackage key instead of ignoring the check it meant to request", () => {
    assert.throws(
      () =>
        validatePackagedDocs(
          ...makePackedFixture({ "README.md": "docs\n" }, { requiredPackagedFile: ["examples/template.md"] }),
        ),
      /signalridgePackage has unknown keys: requiredPackagedFile /,
    );
  });

  it("rejects a tarball with no packaged README", () => {
    const [manifest, extraction] = makePackedFixture({});
    extraction.entries.delete("package/README.md");
    assert.throws(() => validatePackagedDocs(manifest, extraction), /tarball omits README\.md/);
  });
});

// Every fixture below is a construct GitHub and npm render correctly. Rejecting
// one blocks a release on valid prose, so the scanner has to accept them all.
describe("packaged documentation false positives", () => {
  it("keeps a four-backtick wrapper around a fenced example closed", () => {
    const packed = makePackedFixture({
      "README.md": ["Document a fence like this:", "", "````md", "```", "![x](./example.png)", "```", "````", ""].join(
        "\n",
      ),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  it("treats an info-string line inside a block as content, not as the closing fence", () => {
    const packed = makePackedFixture({
      "README.md": ["```", "```js", "![x](./example.png)", "```", ""].join("\n"),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  it("recognizes a fence indented inside a list item", () => {
    const packed = makePackedFixture({
      "README.md": ["1. Step one:", "", "    ```md", "    ![x](./example.png)", "    ```", ""].join("\n"),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  it("ignores an indented code block that carries no fence at all", () => {
    const packed = makePackedFixture({
      "README.md": ["Write it like this:", "", "    ![x](./example.png)", "", "Done.", ""].join("\n"),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  it("ignores links inside an HTML comment", () => {
    const packed = makePackedFixture({
      "README.md": ["<!--", "[old](./deleted.md)", "-->", "", "parked <!-- [x](./gone.md) --> inline too", ""].join(
        "\n",
      ),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });

  it("accepts a link to a packed directory, which npm tarballs never list", () => {
    const packed = makePackedFixture({ "README.md": "[sources](./src)\n", "src/index.ts": "export {};\n" });
    assert.equal(validatePackagedDocs(...packed).linkCount, 1);
  });

  it("accepts a percent-encoded target", () => {
    const packed = makePackedFixture({ "README.md": "![shot](./assets/my%20shot.png)\n", "assets/my shot.png": "png" });
    assert.equal(validatePackagedDocs(...packed).linkCount, 1);
  });

  it("accepts the anchor spellings GitHub actually serves", () => {
    const packed = makePackedFixture({
      "README.md": [
        "[a](#foo-1)",
        "[b](#中文标题)",
        "[c](#café-au-lait)",
        "[d](#setext-equals)",
        "[e](#setext-dashes)",
        "[f](#see-docs)",
        "[g](#custom)",
        "[h](#indented-heading)",
        "",
        "# Foo",
        "# Foo",
        "# 中文标题",
        "# Café au lait",
        "",
        "Setext equals",
        "=============",
        "",
        "Setext dashes",
        "-------------",
        "",
        "# See [docs](https://example.com)",
        '<a name="custom"></a>',
        "  ### Indented heading",
        "",
      ].join("\n"),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 8);
  });

  it("closes fences and reads headings in a CRLF document", () => {
    const packed = makePackedFixture({
      "README.md": ["```md", "![x](./example.png)", "```", "", "## Real heading", "", "[a](#real-heading)", ""].join(
        "\r\n",
      ),
    });
    assert.equal(validatePackagedDocs(...packed).linkCount, 1);
  });
});

// The opposite failure: constructs whose broken target used to slip through.
describe("packaged documentation false negatives", () => {
  const missing = (files) => assert.throws(() => validatePackagedDocs(...makePackedFixture(files)), /missing\.png/);

  it("validates reference-style link definitions", () => {
    missing({ "README.md": "[text][ref]\n\n[ref]: ./missing.png\n" });
  });

  it("validates HTML img and anchor targets", () => {
    missing({ "README.md": '<img src="./missing.png">\n' });
    assert.throws(
      () => validatePackagedDocs(...makePackedFixture({ "README.md": '<a href="./missing.md">x</a>\n' })),
      /missing\.md/,
    );
  });

  it("validates angle-bracket targets that contain spaces", () => {
    assert.throws(
      () => validatePackagedDocs(...makePackedFixture({ "README.md": "[a](<./mis sing.png>)\n" })),
      /mis sing\.png/,
    );
  });

  it("validates titled links, nested brackets and wrapped link text", () => {
    missing({ "README.md": '[a](./missing.png "title")\n' });
    missing({ "README.md": "[a](./missing.png (t))\n" });
    missing({ "README.md": "[a [b] c](./missing.png)\n" });
    missing({ "README.md": "[a\nb](./missing.png)\n" });
  });

  it("still validates the inner target of a linked image", () => {
    const files = { "README.md": "[![alt](./missing.png)](./other.md)\n", "other.md": "# Other\n" };
    missing(files);
  });

  it("rejects an unterminated fence rather than silently skipping the rest of the file", () => {
    assert.throws(
      () => validatePackagedDocs(...makePackedFixture({ "README.md": "```\ncode\n\ntext\n[a](./missing.png)\n" })),
      /unterminated code fence: README\.md/,
    );
  });

  it("treats a backticked inline span as prose, not as a fence that hides the rest", () => {
    missing({ "README.md": "``` this is inline ```\n[a](./missing.png)\n" });
  });

  it("still validates links that follow a closed fence", () => {
    missing({ "README.md": ["```md", "![x](./example.png)", "```", "", "[a](./missing.png)", ""].join("\n") });
  });

  it("does not mistake a footnote definition for a link", () => {
    const packed = makePackedFixture({ "README.md": "Text[^1]\n\n[^1]: missing.png is only prose here\n" });
    assert.equal(validatePackagedDocs(...packed).linkCount, 0);
  });
});

// A ustar member listing cleanly is no promise that it extracts: this archive
// declares a file and then a path under it, so `tar -tzf` succeeds while
// `tar -xzf` fails after the temporary directory already exists.
function unextractableTarball(directory) {
  const member = (name, body) => {
    const content = Buffer.from(body, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar", 257, 5, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512, 0)]);
  };
  const tarball = join(directory, "unextractable.tgz");
  writeFileSync(
    tarball,
    gzipSync(
      Buffer.concat([member("package", "not a directory\n"), member("package/x", "x\n"), Buffer.alloc(1024, 0)]),
    ),
  );
  return tarball;
}

describe("tarball extraction", () => {
  it("removes its temporary directory when extraction fails", () => {
    const holder = mkdtempSync(join(tmpdir(), "pi-pack-holder-"));
    tempRoots.push(holder);
    const tarball = unextractableTarball(holder);
    const isolatedTemp = mkdtempSync(join(tmpdir(), "pi-pack-isolated-"));
    tempRoots.push(isolatedTemp);
    const previousTemp = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTemp;
    try {
      assert.throws(() => extractTarball(tarball), /tar -xzf .* failed/);
      assert.deepEqual(readdirSync(isolatedTemp), []);
    } finally {
      if (previousTemp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemp;
    }
  });
});

// A release gate that exits 0 without running is the worst failure mode.
describe("pack-packages entrypoint", () => {
  it("runs when the script is invoked through a symlink", () => {
    const linkRoot = mkdtempSync(join(tmpdir(), "pi-pack-link-"));
    tempRoots.push(linkRoot);
    const link = join(linkRoot, "pack-link.mjs");
    symlinkSync(fileURLToPath(new URL("./pack-packages.mjs", import.meta.url)), link);
    const result = spawnSync(process.execPath, [link, "--dry-run", "--packages=pi-not-a-real-package"], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown package selection: pi-not-a-real-package/);
  });
});
