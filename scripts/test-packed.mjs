import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCommandProbe } from "./command-probe.mjs";

const execute = promisify(execFile);
const PACKAGE_NAME = "omp-pstack";
const REQUIRED_FILES = [
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "agents/comment-sicko.md",
  "agents/poteto-agent.md",
  "extensions/pstack/config.ts",
  "extensions/pstack/index.ts",
  "extensions/pstack/interaction.ts",
  "package.json",
  "skills/poteto-mode/SKILL-INDEX.md",
  "skills/poteto-mode/SKILL.md",
];
const FORBIDDEN_EXACT = new Set([
  ".bun-version",
  ".node-version",
  "package-lock.json",
  "tsconfig.json",
]);

function isForbiddenPath(file) {
  if (FORBIDDEN_EXACT.has(file)) return true;
  if (file.startsWith("tests/") || file.startsWith("scripts/") || file.startsWith(".github/")) return true;
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
  await access(path.join(installed, "extensions", "pstack", "config.ts"));
  await access(path.join(installed, "extensions", "pstack", "interaction.ts"));
  await access(path.join(installed, "skills", "poteto-mode", "SKILL.md"));
  await access(path.join(installed, "agents", "poteto-agent.md"));

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
  const modelsProbe = resolveCommandProbe(ompCommand, ["models", "--no-extensions", "-e", installedExtensionDir, "--json"]);
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
