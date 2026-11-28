import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveCommandProbe } from "./command-probe.mjs";

const execute = promisify(execFile);

/** Host overrides that could move discovery out of the isolated test home. */
const HOST_LOCATION_OVERRIDES = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
];

const DISCOVERY_SCRIPT = `
import { readFileSync } from "node:fs";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task";
import { discoverExtensionPaths, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const config = JSON.parse(process.env.OMP_PSTACK_VERIFY_CONFIG);
const skills = await loadSkills({ cwd: config.projectDir });
const agents = await discoverAgents(config.projectDir, config.home);
const extensionPaths = await discoverExtensionPaths([], config.projectDir, undefined, {
  ambient: true,
  includeAmbientHooks: false,
});
const loaded = await loadExtensions(extensionPaths, config.projectDir);
const installedPackage = JSON.parse(readFileSync(config.installedPackageJson, "utf8"));
const hostPackage = JSON.parse(readFileSync(config.hostPackageJson, "utf8"));

console.log(JSON.stringify({
  hostVersion: hostPackage.version,
  discoveredSkillNames: skills.skills.map((skill) => skill.name).sort(),
  skillWarnings: skills.warnings,
  discoveredAgentNames: agents.agents.map((agent) => agent.name).sort(),
  agents: agents.agents.map((agent) => ({
    name: agent.name,
    spawns: agent.spawns ?? null,
    autoloadSkills: agent.autoloadSkills ?? null,
    tools: agent.tools ?? null,
  })),
  extensionPaths,
  extensionCount: loaded.extensions.length,
  extensionErrors: loaded.errors,
  runtimeDependencyNames: Object.keys(installedPackage.dependencies ?? {}).sort(),
}));
`;

export function isolatedOmpEnv(home, agentDir) {
  const env = { ...process.env };
  for (const key of HOST_LOCATION_OVERRIDES) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

async function listSkillNames(sourceRoot) {
  const entries = await readdir(path.join(sourceRoot, "skills"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function assertIsolatedLocation(label, location) {
  assert.ok(path.isAbsolute(location), `${label} must be an absolute path: ${location}`);
  assert.notEqual(
    path.resolve(location),
    path.resolve(homedir()),
    `${label} must be a test-created isolated location, not the host home`,
  );
}

/**
 * Discover skills, agents, and extensions from an installed omp-pstack package in an
 * isolated home. Every path is supplied by the test; the host environment's XDG,
 * profile, and config overrides are removed before the child process starts.
 */
export async function verifyInstall({
  sourceRoot,
  installedRoot,
  home,
  agentDir,
  packageName = "omp-pstack",
  expectedSkills,
  projectDir,
}) {
  assertIsolatedLocation("home", home);
  assertIsolatedLocation("agentDir", agentDir);
  await mkdir(agentDir, { recursive: true });

  const neutralProject =
    projectDir ?? (await mkdtemp(path.join(tmpdir(), "omp-pstack-verify-project-")));
  const ownsProjectDir = projectDir === undefined;

  const config = {
    projectDir: path.resolve(neutralProject),
    home: path.resolve(home),
    installedRoot: path.resolve(installedRoot),
    installedPackageJson: path.join(path.resolve(installedRoot), "package.json"),
    hostPackageJson: path.join(
      path.resolve(sourceRoot),
      "node_modules",
      "@oh-my-pi",
      "pi-coding-agent",
      "package.json",
    ),
  };
  const env = isolatedOmpEnv(home, agentDir);
  env.OMP_PSTACK_VERIFY_CONFIG = JSON.stringify(config);

  try {
    const probe = resolveCommandProbe("bun", ["-e", DISCOVERY_SCRIPT]);
    let stdout;
    try {
      ({ stdout } = await execute(probe.command, probe.args, {
        cwd: path.resolve(sourceRoot),
        env,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: probe.batch,
      }));
    } catch (error) {
      const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`install discovery failed for ${packageName}: ${detail || error.message}`);
    }

    const observed = JSON.parse(stdout);
    const wantedSkills = expectedSkills ?? (await listSkillNames(sourceRoot));
    assert.deepEqual(
      observed.discoveredSkillNames,
      [...wantedSkills].sort(),
      "discovered skills do not match the source tree",
    );

    const potetoAgent = observed.agents.find((agent) => agent.name === "poteto-agent");
    assert.ok(potetoAgent, "discovery missed poteto-agent");
    assert.equal(potetoAgent.spawns, "*", 'poteto-agent must declare spawns: "*"');
    assert.deepEqual(potetoAgent.autoloadSkills, ["poteto-mode"], 'poteto-agent must autoload "poteto-mode"');

    const commentSicko = observed.agents.find((agent) => agent.name === "comment-sicko");
    assert.ok(commentSicko, "discovery missed comment-sicko");
    assert.equal(commentSicko.spawns, null, "comment-sicko must not declare spawns");
    for (const tool of ["read", "grep", "glob", "edit", "bash"]) {
      assert.ok(commentSicko.tools?.includes(tool), `comment-sicko must include ${tool}`);
    }
    for (const tool of ["ls", "task", "write"]) {
      assert.ok(!commentSicko.tools?.includes(tool), `comment-sicko must not include ${tool}`);
    }

    assert.deepEqual(observed.extensionErrors, [], `extension load errors: ${JSON.stringify(observed.extensionErrors)}`);
    assert.ok(observed.extensionCount > 0, "no extension loaded");
    assert.deepEqual(
      observed.runtimeDependencyNames,
      [],
      `runtime package must not declare dependencies: ${JSON.stringify(observed.runtimeDependencyNames)}`,
    );

    return observed;
  } finally {
    if (ownsProjectDir) await rm(neutralProject, { recursive: true, force: true });
  }
}
