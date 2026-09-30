import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { preloadSkills } from "../src/skill-loader.js";

// The runner wiring is checked in agent-runner.test.ts. This exercises Pi's
// actual reload -> resources_discover/extendResources -> skillsOverride order:
// noSkills alone only suppresses initial discovery, not extension additions.
describe("Pi SDK extension skill loading", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "subagent-skill-scope-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent-dir");
    const selected = join(cwd, ".pi", "skills", "selected-skill");
    const other = join(cwd, ".pi", "skills", "other-skill");
    const extension = join(root, "extension", "extension-skill");
    for (const dir of [cwd, agentDir, selected, other, extension]) mkdirSync(dir, { recursive: true });
    for (const [dir, name] of [[selected, "selected-skill"], [other, "other-skill"], [extension, "extension-skill"]]) {
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name} content\n`);
    }
    return { cwd, agentDir, extension };
  }

  async function loaderFor(cwd: string, agentDir: string, restricted: boolean) {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      noExtensions: true,
      noSkills: restricted,
      ...(restricted ? { skillsOverride: () => ({ skills: [], diagnostics: [] }) } : {}),
    });
    await loader.reload();
    return loader;
  }

  function contributeExtensionSkill(loader: DefaultResourceLoader, extension: string) {
    // AgentSession.bindExtensions forwards resources_discover skill paths in
    // exactly this shape; the real loader then recomputes the entire skill set.
    loader.extendResources({
      skillPaths: [{ path: extension, metadata: {
        source: "fixture-extension", scope: "temporary", origin: "top-level", baseDir: join(extension, ".."),
      } }],
    });
  }

  it("excludes extension skills with skills: false, including after a second resource update", async () => {
    const { cwd, agentDir, extension } = fixture();
    const loader = await loaderFor(cwd, agentDir, true);
    expect(loader.getSkills().skills).toEqual([]);

    contributeExtensionSkill(loader, extension);
    expect(loader.getSkills().skills).toEqual([]);
    contributeExtensionSkill(loader, extension);
    expect(loader.getSkills().skills).toEqual([]);
  });

  it("keeps only named preloaded skills when an extension contributes another", async () => {
    const { cwd, agentDir, extension } = fixture();
    const selected = preloadSkills(["selected-skill"], cwd);
    expect(selected).toHaveLength(1);
    expect(selected[0].content).toContain("selected-skill content");

    const loader = await loaderFor(cwd, agentDir, true);
    contributeExtensionSkill(loader, extension);
    expect(loader.getSkills().skills).toEqual([]);
  });

  it("keeps ordinary discovery and extension skills with skills: true", async () => {
    const { cwd, agentDir, extension } = fixture();
    const loader = await loaderFor(cwd, agentDir, false);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(expect.arrayContaining([
      "selected-skill", "other-skill",
    ]));

    contributeExtensionSkill(loader, extension);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(expect.arrayContaining([
      "selected-skill", "other-skill", "extension-skill",
    ]));
  });
});
