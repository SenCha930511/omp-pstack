import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCommandProbe } from "./command-probe.mjs";

const execute = promisify(execFile);
const PACKAGE_NAME = "omp-pstack";
const REQUIRED_FILES = [
  "AGENT-INSTALL.md",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "agents/comment-sicko.md",
  "agents/poteto-agent.md",
  "extensions/pstack/index.ts",
  "extensions/pstack/interaction.ts",
  "package.json",
  "skills/poteto-mode/SKILL.md",
];
const FORBIDDEN_EXACT = new Set([
  ".bun-version",
  ".node-version",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.test.json",
]);

function isForbiddenPath(file) {
  if (FORBIDDEN_EXACT.has(file)) return true;
  if (file.startsWith("tests/") || file.startsWith("scripts/") || file.startsWith(".github/")) return true;
  if (file.startsWith("skills/statechart/scripts/test/")) return true;
  if (file.startsWith("skills/") && file.endsWith(".test.ts")) return true;
  if (file.startsWith("node_modules/") || file.includes("/node_modules/")) return true;
  if (file === ".DS_Store" || file.endsWith("/.DS_Store")) return true;
  if (file.endsWith(".tgz")) return true;
  return false;
}

const runNpm = (args, options) => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const resolved = resolveCommandProbe(command, args);
  return execute(resolved.command, resolved.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
};

function resolveOmpCommand(root) {
  if (process.env.OMP_PSTACK_OMP_COMMAND) return process.env.OMP_PSTACK_OMP_COMMAND;
  const localOmp = path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "omp.cmd" : "omp",
  );
  if (existsSync(localOmp)) return localOmp;
  return process.platform === "win32" ? "omp.cmd" : "omp";
}

async function measureUnpackedSize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await measureUnpackedSize(fullPath);
    else total += (await stat(fullPath)).size;
  }
  return total;
}

async function listFilesRecursive(directory, base) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".DS_Store") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(full, base)));
    else files.push(path.relative(base, full).replaceAll("\\", "/"));
  }
  return files;
}

async function expectedPackedFiles(root) {
  const files = [];
  for (const directory of ["extensions", "skills", "agents"]) {
    for (const file of await listFilesRecursive(path.join(root, directory), root)) {
      if (!isForbiddenPath(file)) files.push(file);
    }
  }
  files.push("AGENT-INSTALL.md", "README.md", "LICENSE", "NOTICE.md", "package.json");
  return files.sort();
}

const tarballArgIndex = process.argv.indexOf("--tarball");
assert.ok(tarballArgIndex === -1 || Boolean(process.argv[tarballArgIndex + 1]), "--tarball requires a tarball path");
const suppliedTarball = tarballArgIndex === -1 ? undefined : path.resolve(process.argv[tarballArgIndex + 1]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "omp-pstack-packed-"));

try {
  let tarballPath;
  let files;
  let packedSize;
  let unpackedSize;

  if (suppliedTarball) {
    tarballPath = suppliedTarball;
    packedSize = (await stat(tarballPath)).size;
    const listed = await execute("tar", ["-tzf", path.basename(tarballPath)], { cwd: path.dirname(tarballPath) });
    files = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"))
      .map((line) => line.replace(/^package\//, ""));
  } else {
    const packed = JSON.parse((await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
      cwd: root,
    })).stdout);
    const artifact = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    tarballPath = path.join(temporary, artifact.filename);
    files = artifact.files.map((file) => file.path);
    packedSize = artifact.size;
    unpackedSize = artifact.unpackedSize;
  }

  const fileSet = new Set(files);

  const expected = await expectedPackedFiles(root);
  assert.deepEqual(
    [...fileSet].sort(),
    expected,
    "packed tarball contents do not match the package source tree",
  );
  for (const required of REQUIRED_FILES) {
    assert.ok(fileSet.has(required), `packed tarball is missing required file: ${required}`);
  }
  const forbidden = files.filter(isForbiddenPath);
  assert.deepEqual(forbidden, [], `packed tarball contains forbidden files: ${JSON.stringify(forbidden)}`);
  console.log(`Packed ${path.basename(tarballPath)}: ${packedSize} bytes (${files.length} files)`);

  const install = path.join(temporary, "consumer");
  await runNpm(
    [
      "install",
      "--prefix",
      install,
      tarballPath,
      "--omit=dev",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: temporary, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );

  const installed = path.join(install, "node_modules", PACKAGE_NAME);
  await access(path.join(installed, "extensions", "pstack", "index.ts"));
  await access(path.join(installed, "extensions", "pstack", "interaction.ts"));
  await access(path.join(installed, "skills", "poteto-mode", "SKILL.md"));
  await access(path.join(installed, "agents", "poteto-agent.md"));

  if (process.platform !== "win32") {
    for (const rel of [
      "skills/statechart/scripts/statechart",
      "skills/poteto-mode/scripts/worktree-audit.sh",
      "skills/poteto-mode/scripts/watch-pr/watch-pr",
      "skills/show-me-your-work/scripts/log.sh",
    ]) {
      const mode = (await stat(path.join(installed, rel))).mode;
      assert.notEqual(mode & 0o111, 0, `installed script must keep executable bit: ${rel}`);
    }
  }

  const installedPkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedPkg.dependencies, undefined, "package must not declare runtime dependencies");

  const topModules = (await readdir(path.join(install, "node_modules"))).filter((name) => !name.startsWith("."));
  assert.deepEqual(topModules, [PACKAGE_NAME], `runtime install must not pull external dependencies: ${JSON.stringify(topModules)}`);

  unpackedSize ??= await measureUnpackedSize(installed);
  assert.ok(unpackedSize < 10 * 1024 * 1024, `${PACKAGE_NAME} unpacked size unexpectedly large: ${unpackedSize} bytes`);
  console.log(`Clean production install: ${unpackedSize} unpacked bytes, zero runtime dependencies: PASS`);

  const installedExtensionDir = path.join(installed, "extensions", "pstack");
  const installedEntry = path.join(installedExtensionDir, "index.ts");
  await execute(
    "bun",
    ["-e", `const m = await import(${JSON.stringify(pathToFileURL(installedEntry).href)}); if (typeof m.default !== "function") process.exit(1);`],
    { cwd: temporary, timeout: 30_000 },
  );
  console.log("Installed tarball Bun import smoke check: PASS");

  const ompHome = path.join(temporary, "omp-home");
  await mkdir(ompHome, { recursive: true });
  const ompEnv = {
    ...process.env,
    HOME: ompHome,
    USERPROFILE: ompHome,
    PI_CODING_AGENT_DIR: path.join(ompHome, "agent"),
  };
  const ompCommand = resolveOmpCommand(root);

  const linkProbe = resolveCommandProbe(ompCommand, ["plugin", "link", installed]);
  await execute(linkProbe.command, linkProbe.args, {
    cwd: temporary,
    env: ompEnv,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });

  const listProbe = resolveCommandProbe(ompCommand, ["plugin", "list", "--json"]);
  const listed = await execute(listProbe.command, listProbe.args, {
    cwd: temporary,
    env: ompEnv,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
  const plugins = JSON.parse(listed.stdout);
  assert.ok(
    Array.isArray(plugins.npm) && plugins.npm.some((plugin) => plugin.name === PACKAGE_NAME),
    `omp plugin list did not register ${PACKAGE_NAME}: ${listed.stdout}`,
  );

  const discoveryScript = path.join(root, `.omp-pstack-discovery-${process.pid}.mjs`);
  await writeFile(
    discoveryScript,
    [
      'import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";',
      'import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task";',
      'import { discoverExtensionPaths, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";',
      "const [projectDir, home] = process.argv.slice(2);",
      "const skills = await loadSkills({ cwd: projectDir });",
      "const agents = await discoverAgents(projectDir, home);",
      "const extensionPaths = await discoverExtensionPaths([], projectDir, undefined, { ambient: true, includeAmbientHooks: false });",
      "const loaded = await loadExtensions(extensionPaths, projectDir);",
      "console.log(JSON.stringify({",
      "  skills: skills.skills.map((skill) => skill.name).sort(),",
      "  skillWarnings: skills.warnings,",
      "  agents: agents.agents.map((agent) => ({ name: agent.name, spawns: agent.spawns ?? null, autoloadSkills: agent.autoloadSkills ?? null, tools: agent.tools ?? null })),",
      "  extensionPaths,",
      "  extensionErrors: loaded.errors,",
      "  extensionCount: loaded.extensions.length,",
      "}));",
    ].join("\n"),
  );
  let discovered;
  try {
    const discoveryProbe = resolveCommandProbe("bun", [discoveryScript, temporary, ompHome]);
    const discovery = await execute(discoveryProbe.command, discoveryProbe.args, {
      cwd: root,
      env: ompEnv,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
    });
    discovered = JSON.parse(discovery.stdout);
  } finally {
    await rm(discoveryScript, { force: true });
  }

  const expectedSkills = (await readdir(path.join(root, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(discovered.skills, expectedSkills, "discovered skills do not match the source tree");
  assert.ok(discovered.skills.includes("poteto-mode"), "discovery missed poteto-mode");
  assert.ok(discovered.skills.includes("reframe"), "discovery missed reframe");

  const potetoAgent = discovered.agents.find((agent) => agent.name === "poteto-agent");
  const commentSicko = discovered.agents.find((agent) => agent.name === "comment-sicko");
  assert.ok(potetoAgent, "discovery missed poteto-agent");
  assert.equal(potetoAgent.spawns, "*", 'poteto-agent must declare spawns: "*"');
  assert.deepEqual(potetoAgent.autoloadSkills, ["poteto-mode"], 'poteto-agent must autoload "poteto-mode"');
  assert.ok(commentSicko, "discovery missed comment-sicko");
  assert.equal(commentSicko.spawns, null, "comment-sicko must not declare spawns");
  assert.ok(commentSicko.tools?.includes("glob"), "comment-sicko must include glob");
  assert.ok(commentSicko.tools?.includes("edit"), "comment-sicko must include edit");
  assert.ok(commentSicko.tools?.includes("bash"), "comment-sicko must include bash");
  assert.ok(!commentSicko.tools?.includes("ls"), "comment-sicko must not include ls");
  assert.ok(!commentSicko.tools?.includes("task"), "comment-sicko must not include task");
  assert.ok(!commentSicko.tools?.includes("write"), "comment-sicko must not include write");

  const discoveredExtension = discovered.extensionPaths.find(
    (extensionPath) =>
      extensionPath.includes(PACKAGE_NAME) && extensionPath.includes(path.join("extensions", "pstack")),
  );
  assert.ok(
    discoveredExtension,
    `discovery missed the pstack extension: ${JSON.stringify(discovered.extensionPaths)}`,
  );
  assert.deepEqual(discovered.extensionErrors, [], `extension load errors: ${JSON.stringify(discovered.extensionErrors)}`);
  assert.ok(discovered.extensionCount > 0, "no extension loaded");
  console.log(`OMP discovery: ${discovered.skills.length} skills, 2 pstack agents, ${discovered.extensionCount} extension: PASS`);

  const modelsProbe = resolveCommandProbe(ompCommand, ["models", "--json"]);
  const catalog = await execute(modelsProbe.command, modelsProbe.args, {
    cwd: temporary,
    env: ompEnv,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
  assert.ok(!catalog.stderr.includes("Failed to load extension"), `OMP reported extension load failure:\n${catalog.stderr}`);
  const parsed = JSON.parse(catalog.stdout);
  assert.ok(Array.isArray(parsed.models), "expected omp models --json to return models array");
  console.log("Installed npm tarball loads in OMP with an isolated home: PASS");
} finally {
  await rm(temporary, { recursive: true, force: true });
  console.log("Removed temporary package and consumer installation");
}
