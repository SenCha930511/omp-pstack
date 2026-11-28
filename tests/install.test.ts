import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePotetoSkill } from "../extensions/pstack/install.ts";

const TEMP_DIRS: string[] = [];
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_CONFIG_DIR = process.env.PI_CONFIG_DIR;

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.PI_CONFIG_DIR;
  else process.env.PI_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

function makeTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function makeCacheRoot({
  pluginsRoot,
  marketplace = "omp-pstack",
  version = "0.3.3",
  packageName = "omp-pstack",
  skillName = "poteto-mode",
  body = "cached body",
}: {
  pluginsRoot: string;
  marketplace?: string;
  version?: string;
  packageName?: string;
  skillName?: string;
  body?: string;
}): string {
  const root = path.join(pluginsRoot, "cache", "plugins", `${marketplace}___omp-pstack___${version}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: packageName })}\n`);
  const skillFile = path.join(root, "skills", "poteto-mode", "SKILL.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, `---\nname: ${skillName}\ndescription: test\n---\n\n${body}\n`);
  return root;
}

function linkDirectory(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function makeProject(base: string, cacheRoot: string, configName = ".omp"): string {
  fs.mkdirSync(base, { recursive: true });
  const project = path.join(base, "project");
  const configDir = path.join(project, configName);
  const plugins = path.join(configDir, "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, "installed_plugins.json"), `${JSON.stringify({ version: 2, plugins: {} })}\n`);
  linkDirectory(cacheRoot, path.join(plugins, "node_modules", "omp-pstack"));
  return project;
}

function makeUserRoot(base: string, cacheRoot: string): { agentDir: string; pluginsRoot: string } {
  const agentDir = path.join(base, ".omp", "agent");
  const pluginsRoot = path.join(base, ".omp", "plugins");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(pluginsRoot, "node_modules"), { recursive: true });
  linkDirectory(cacheRoot, path.join(pluginsRoot, "node_modules", "omp-pstack"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { agentDir, pluginsRoot };
}

function removeSkill(root: string): void {
  fs.rmSync(path.join(root, "skills", "poteto-mode", "SKILL.md"));
}

function skillPath(cacheRoot: string): string {
  return fs.realpathSync.native(path.join(cacheRoot, "skills", "poteto-mode", "SKILL.md"));
}

describe("resolvePotetoSkill", () => {
  test("keeps the loaded package while its skill file exists", () => {
    const base = makeTemp("omp-pstack-install-");
    const loaded = makeCacheRoot({ pluginsRoot: base });
    const anchor = resolvePotetoSkill({ loadedRoot: loaded });
    expect(anchor).toEqual({
      skillFile: path.join(loaded, "skills", "poteto-mode", "SKILL.md"),
      skillDir: path.join(loaded, "skills", "poteto-mode"),
      usingFallback: false,
    });
  });

  test("falls back to the project link after the loaded cache root disappears", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const next = makeCacheRoot({ pluginsRoot, version: "0.4.0", body: "project body" });
    const project = makeProject(base, next);
    removeSkill(loaded);

    const anchor = resolvePotetoSkill({ loadedRoot: loaded, cwd: path.join(project, "src") });
    expect(anchor.skillFile).toBe(skillPath(next));
    expect(anchor.usingFallback).toBe(true);
    expect(fs.readFileSync(anchor.skillFile, "utf8")).toContain("project body");
  });

  test("project link wins over the user link", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const projectCache = makeCacheRoot({ pluginsRoot, version: "0.4.0", body: "project" });
    const userCache = makeCacheRoot({ pluginsRoot, version: "0.5.0", body: "user" });
    makeUserRoot(base, userCache);
    const project = makeProject(base, projectCache);
    removeSkill(loaded);

    const anchor = resolvePotetoSkill({ loadedRoot: loaded, cwd: project });
    expect(anchor.skillFile).toBe(skillPath(projectCache));
    expect(anchor.usingFallback).toBe(true);
  });

  test("falls back to the user link when the project has no valid link", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const userCache = makeCacheRoot({ pluginsRoot, version: "0.4.0", body: "user" });
    makeUserRoot(base, userCache);
    const project = path.join(base, "empty-project");
    fs.mkdirSync(project);
    removeSkill(loaded);

    const anchor = resolvePotetoSkill({ loadedRoot: loaded, cwd: project });
    expect(anchor.skillFile).toBe(skillPath(userCache));
  });

  test("rejects a different marketplace and uses the same-marketplace user link", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const foreign = makeCacheRoot({ pluginsRoot, marketplace: "sencha930511", version: "0.4.0" });
    const userCache = makeCacheRoot({ pluginsRoot, version: "0.5.0" });
    makeUserRoot(base, userCache);
    const project = makeProject(base, foreign);
    removeSkill(loaded);

    const anchor = resolvePotetoSkill({ loadedRoot: loaded, cwd: project });
    expect(anchor.skillFile).toBe(skillPath(userCache));
  });

  test("rejects a wrong package name or skill name", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const wrongPackage = makeCacheRoot({ pluginsRoot, version: "0.4.0", packageName: "other" });
    const wrongSkill = makeCacheRoot({ pluginsRoot, version: "0.5.0", skillName: "other" });
    removeSkill(loaded);

    const packageProject = makeProject(path.join(base, "package-project"), wrongPackage);
    const skillProject = makeProject(path.join(base, "skill-project"), wrongSkill);
    expect(resolvePotetoSkill({ loadedRoot: loaded, cwd: packageProject }).usingFallback).toBe(false);
    expect(resolvePotetoSkill({ loadedRoot: loaded, cwd: skillProject }).usingFallback).toBe(false);
  });

  test("rejects a link that escapes the loaded cache parent", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const outside = makeCacheRoot({ pluginsRoot: path.join(base, "outside"), version: "0.4.0" });
    const project = makeProject(base, outside);
    removeSkill(loaded);

    const anchor = resolvePotetoSkill({ loadedRoot: loaded, cwd: project });
    expect(anchor.usingFallback).toBe(false);
    expect(anchor.skillFile).toBe(path.join(loaded, "skills", "poteto-mode", "SKILL.md"));
  });

  test("skips the project fallback when cwd is missing", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const projectCache = makeCacheRoot({ pluginsRoot, version: "0.4.0" });
    makeProject(base, projectCache);
    removeSkill(loaded);

    const anchor = resolvePotetoSkill({ loadedRoot: loaded });
    expect(anchor.usingFallback).toBe(false);
  });

  test("does not fall back for a normal checkout", () => {
    const base = makeTemp("omp-pstack-install-");
    const checkout = path.join(base, "checkout");
    fs.mkdirSync(path.join(checkout, "skills", "poteto-mode"), { recursive: true });
    const anchor = resolvePotetoSkill({ loadedRoot: checkout, cwd: base });
    expect(anchor.usingFallback).toBe(false);
    expect(anchor.skillFile).toBe(path.join(checkout, "skills", "poteto-mode", "SKILL.md"));
  });

  test("uses a legacy PI_CONFIG_DIR project install when .omp is absent", () => {
    const base = makeTemp("omp-pstack-install-");
    const pluginsRoot = path.join(base, "user");
    const loaded = makeCacheRoot({ pluginsRoot, version: "0.3.3" });
    const legacyCache = makeCacheRoot({ pluginsRoot, version: "0.4.0" });
    const project = makeProject(base, legacyCache, ".legacy");
    process.env.PI_CONFIG_DIR = ".legacy";
    removeSkill(loaded);

    const anchor = resolvePotetoSkill({ loadedRoot: loaded, cwd: project });
    expect(anchor.skillFile).toBe(skillPath(legacyCache));
  });
});
