import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveCommandProbe } from "./command-probe.mjs";
import { resolveOmpCommand } from "./omp-command.mjs";
import { isolatedOmpEnv, verifyInstall } from "./verify-install.mjs";

const execute = promisify(execFile);
const PACKAGE_NAME = "omp-pstack";
const NEW_MARKETPLACE = "omp-pstack";
const OLD_MARKETPLACE = "sencha930511";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ompCommand = resolveOmpCommand(root);

async function runCommand(file, args, options = {}) {
  const probe = resolveCommandProbe(file, args);
  try {
    const result = await execute(probe.command, probe.args, {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: probe.batch,
      ...options,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      message: error.message,
    };
  }
}

function runOmp(args, { cwd, env }) {
  return runCommand(ompCommand, args, { cwd, env });
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}\n${result.message ?? ""}`;
}

function assertSucceeded(result, label) {
  assert.equal(result.code, 0, `${label} failed:\n${outputOf(result)}`);
}

async function listPlugins({ cwd, env }) {
  const result = await runOmp(["plugin", "list", "--json"], { cwd, env });
  assertSucceeded(result, "omp plugin list --json");
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed.marketplace) ? parsed.marketplace : [];
}

function findInstalledPath(plugins, pluginId) {
  const entry = plugins.find((plugin) => plugin.id === pluginId);
  assert.ok(entry, `omp plugin list did not report ${pluginId}: ${JSON.stringify(plugins)}`);
  assert.ok(Array.isArray(entry.entries) && entry.entries.length > 0, `${pluginId} has no install entry`);
  const installPath = entry.entries[0].installPath;
  assert.ok(installPath, `${pluginId} has no installPath`);
  assert.ok(existsSync(installPath), `${pluginId} installPath does not exist: ${installPath}`);
  return installPath;
}

async function extractCatalog(destination, temporary) {
  await mkdir(destination, { recursive: true });
  const archive = path.join(temporary, "catalog.tar");
  assertSucceeded(
    await runCommand("git", ["-C", root, "archive", "--format=tar", "--output", archive, "HEAD"]),
    "git archive HEAD",
  );
  assertSucceeded(await runCommand("tar", ["-xf", archive, "-C", destination]), "tar extract");
  await rm(archive, { force: true });
  assert.ok(
    existsSync(path.join(destination, ".omp-plugin", "marketplace.json")),
    "catalog copy is missing .omp-plugin/marketplace.json",
  );
  assert.ok(!existsSync(path.join(destination, "node_modules")), "catalog copy must not include node_modules");
  assert.ok(!existsSync(path.join(destination, ".git")), "catalog copy must not include .git");
}

async function renameCatalog(destination, name) {
  const catalogPath = path.join(destination, ".omp-plugin", "marketplace.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.name = name;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

async function makeHome(temporary, label) {
  const home = path.join(temporary, `home ${label}`);
  const agentDir = path.join(home, "agent");
  const projectDir = path.join(temporary, `project ${label}`);
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { home, agentDir, projectDir, env: isolatedOmpEnv(home, agentDir) };
}

const temporary = await mkdtemp(path.join(tmpdir(), "omp pstack marketplace "));

try {
  const catalog = path.join(temporary, "catalog");
  await extractCatalog(catalog, temporary);

  const current = await makeHome(temporary, "new");
  assertSucceeded(
    await runOmp(["plugin", "marketplace", "add", catalog], current),
    "marketplace add from an absolute local path",
  );
  assertSucceeded(
    await runOmp(["plugin", "install", `${PACKAGE_NAME}@${NEW_MARKETPLACE}`], current),
    "install from the repo marketplace",
  );

  const installed = findInstalledPath(
    await listPlugins(current),
    `${PACKAGE_NAME}@${NEW_MARKETPLACE}`,
  );
  const firstDiscovery = await verifyInstall({
    sourceRoot: root,
    installedRoot: installed,
    home: current.home,
    agentDir: current.agentDir,
    packageName: PACKAGE_NAME,
    projectDir: current.projectDir,
  });
  assert.ok(firstDiscovery.discoveredSkillNames.includes("poteto-mode"), "discovery missed poteto-mode");

  const repeat = await runOmp(["plugin", "install", `${PACKAGE_NAME}@${NEW_MARKETPLACE}`], current);
  assert.notEqual(repeat.code, 0, "a second install without --force must not silently reinstall");
  assert.match(outputOf(repeat), /already installed/);

  assertSucceeded(
    await runOmp(["plugin", "marketplace", "update", NEW_MARKETPLACE], current),
    "marketplace update",
  );
  assert.equal(
    findInstalledPath(await listPlugins(current), `${PACKAGE_NAME}@${NEW_MARKETPLACE}`),
    installed,
    "marketplace update must not move an installed plugin at the same version",
  );
  await verifyInstall({
    sourceRoot: root,
    installedRoot: installed,
    home: current.home,
    agentDir: current.agentDir,
    packageName: PACKAGE_NAME,
    projectDir: current.projectDir,
  });

  assertSucceeded(
    await runOmp(["plugin", "install", `${PACKAGE_NAME}@${NEW_MARKETPLACE}`, "--force"], current),
    "force reinstall at the same version",
  );
  assert.equal(
    findInstalledPath(await listPlugins(current), `${PACKAGE_NAME}@${NEW_MARKETPLACE}`),
    installed,
    "force reinstall must keep the same versioned cache path",
  );

  const oldCatalog = path.join(temporary, "catalog old");
  await cp(catalog, oldCatalog, { recursive: true });
  await renameCatalog(oldCatalog, OLD_MARKETPLACE);

  const legacy = await makeHome(temporary, "old");
  assertSucceeded(
    await runOmp(["plugin", "marketplace", "add", oldCatalog], legacy),
    "add the legacy marketplace catalog",
  );
  assertSucceeded(
    await runOmp(["plugin", "install", `${PACKAGE_NAME}@${OLD_MARKETPLACE}`], legacy),
    "install the legacy marketplace entry",
  );
  assert.ok(
    findInstalledPath(await listPlugins(legacy), `${PACKAGE_NAME}@${OLD_MARKETPLACE}`),
    "legacy entry must be installed before the conflict check",
  );

  assertSucceeded(
    await runOmp(["plugin", "marketplace", "add", catalog], legacy),
    "add the new marketplace beside the legacy one",
  );
  const conflict = await runOmp(["plugin", "install", `${PACKAGE_NAME}@${NEW_MARKETPLACE}`], legacy);
  assert.notEqual(conflict.code, 0, "same-name runtime packages must not coexist");
  assert.match(
    outputOf(conflict),
    /Runtime package name "omp-pstack" conflicts with installed plugin "omp-pstack@sencha930511"/,
  );
  findInstalledPath(await listPlugins(legacy), `${PACKAGE_NAME}@${OLD_MARKETPLACE}`);

  assertSucceeded(
    await runOmp(["plugin", "uninstall", `${PACKAGE_NAME}@${OLD_MARKETPLACE}`], legacy),
    "uninstall the legacy entry",
  );
  assertSucceeded(
    await runOmp(["plugin", "install", `${PACKAGE_NAME}@${NEW_MARKETPLACE}`], legacy),
    "install the new entry after uninstalling the legacy one",
  );
  const migrated = findInstalledPath(await listPlugins(legacy), `${PACKAGE_NAME}@${NEW_MARKETPLACE}`);
  await verifyInstall({
    sourceRoot: root,
    installedRoot: migrated,
    home: legacy.home,
    agentDir: legacy.agentDir,
    packageName: PACKAGE_NAME,
    projectDir: legacy.projectDir,
  });

  console.log("Local marketplace add, install, list, update, conflict, and migration: PASS");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
