import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveCommandProbe } from "./command-probe.mjs";
import { resolveOmpCommand } from "./omp-command.mjs";
import { isolatedOmpEnv } from "./verify-install.mjs";
const execute = promisify(execFile);
export const PROOF_SCHEMA = "omp-pstack.install-proof/1";
export const PROOF_COMMAND = "npm run proof:install";
export const PACKAGE_NAME = "omp-pstack";
export const EXTRA_INPUTS = [
  "extensions/pstack/index.ts",
  "extensions/pstack/install.ts",
  "extensions/pstack/interaction.ts",
  "scripts/command-probe.mjs",
  "scripts/install-proof.mjs",
  "scripts/omp-command.mjs",
  "scripts/proof-install.mjs",
  "scripts/test-install-proof.mjs",
  "scripts/verify-install-proof.mjs",
  "scripts/verify-install.mjs",
];

const runNpm = (args, options) => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const resolved = resolveCommandProbe(command, args);
  return execute(resolved.command, resolved.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: resolved.batch,
  });
};

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalPackageJsonBytes(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  delete pkg.gitHead;
  delete pkg.devDependencies;
  return Buffer.from(stableStringify(pkg));
}

export function canonicalPackageJsonHash(root) {
  return crypto.createHash("sha256").update(canonicalPackageJsonBytes(root)).digest("hex");
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function artifactOf(parsed) {
  return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
}

export async function readPackageFiles(root) {
  const packed = JSON.parse(
    (await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root })).stdout,
  );
  const artifact = artifactOf(packed);
  return artifact.files.map((file) => file.path).sort();
}

export async function packAndInstall(root, temporary) {
  const packed = JSON.parse(
    (await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: root })).stdout,
  );
  const artifact = artifactOf(packed);
  const tarballPath = path.join(temporary, artifact.filename);
  const consumer = path.join(temporary, "consumer");
  await runNpm(
    [
      "install",
      "--prefix",
      consumer,
      tarballPath,
      "--omit=dev",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: temporary, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return {
    artifact,
    tarballPath,
    consumer,
    installedRoot: path.join(consumer, "node_modules", PACKAGE_NAME),
    files: artifact.files.map((file) => file.path).sort(),
  };
}

export async function registerInstall({ root, installedRoot, home, agentDir, cwd }) {
  const ompCommand = resolveOmpCommand(root);
  const probe = resolveCommandProbe(ompCommand, ["plugin", "link", installedRoot]);
  await execute(probe.command, probe.args, {
    cwd,
    env: isolatedOmpEnv(home, agentDir),
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: probe.batch,
  });
}

export function collectInputs(root, packageFiles) {
  const paths = new Set([...packageFiles, ...EXTRA_INPUTS]);
  return [...paths].sort().map((relative) => ({
    path: relative,
    sha256:
      relative === "package.json"
        ? canonicalPackageJsonHash(root)
        : sha256File(path.join(root, relative)),
  }));
}

export function hostConstraints(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const version = lock.packages?.["node_modules/@oh-my-pi/pi-coding-agent"]?.version;
  if (typeof version !== "string") return { source: "package-lock.json", informationalOnly: true };
  const [major, minor] = version.split(".");
  return {
    source: "package-lock.json",
    expectedMajorMinor: `${major}.${minor}`,
    informationalOnly: true,
  };
}

export function expectedAgentNames(root) {
  return fs
    .readdirSync(path.join(root, "agents"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

export function observationsFromDiscovery(discovery, packageFileCount, agentNames) {
  const wanted = agentNames === undefined ? undefined : new Set(agentNames);
  return {
    packageFileCount,
    discoveredSkillNames: [...discovery.discoveredSkillNames].sort(),
    discoveredAgentNames: discovery.discoveredAgentNames
      .filter((name) => wanted === undefined || wanted.has(name))
      .sort(),
    extensionCount: discovery.extensionCount,
    runtimeDependencyNames: [...discovery.runtimeDependencyNames].sort(),
  };
}

function isSafeRelative(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function validateProof({ root, proof, packageFiles, observations, agentNames }) {
  const errors = [];
  const add = (message) => errors.push(message);

  if (proof?.schema !== PROOF_SCHEMA) add(`schema must be ${PROOF_SCHEMA}`);
  if (proof?.ok !== true) add("ok must be true");
  if (proof?.command !== PROOF_COMMAND) add(`command must be ${PROOF_COMMAND}`);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (proof?.package?.name !== pkg.name) add(`package.name must be ${pkg.name}`);
  if (proof?.package?.version !== pkg.version) add(`package.version must be ${pkg.version}`);

  const inputs = Array.isArray(proof?.inputs) ? proof.inputs : [];
  if (!Array.isArray(proof?.inputs)) add("inputs must be an array");
  const seen = new Set();
  let previous = "";
  for (const [index, input] of inputs.entries()) {
    if (!isSafeRelative(input?.path)) {
      add(`inputs[${index}]: unsafe path`);
      continue;
    }
    if (seen.has(input.path)) add(`inputs[${index}]: duplicate path ${input.path}`);
    seen.add(input.path);
    if (input.path < previous) add(`inputs must be sorted by path: ${input.path}`);
    previous = input.path;
    const filePath = path.join(root, input.path);
    if (!fs.existsSync(filePath)) {
      add(`inputs[${index}]: file does not exist: ${input.path}`);
      continue;
    }
    const expected =
      input.path === "package.json" ? canonicalPackageJsonHash(root) : sha256File(filePath);
    if (input.sha256 !== expected) add(`inputs[${index}]: hash mismatch for ${input.path}`);
  }

  for (const packageFile of packageFiles) {
    if (!seen.has(packageFile)) add(`package file has no proof input: ${packageFile}`);
  }

  const declared = proof?.observations?.packageFileCount;
  if (declared !== packageFiles.length) {
    add(`observations.packageFileCount must be ${packageFiles.length}, got ${declared}`);
  }
  for (const key of ["discoveredSkillNames", "discoveredAgentNames", "runtimeDependencyNames"]) {
    const value = proof?.observations?.[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      add(`observations.${key} must be a string array`);
    } else if (new Set(value).size !== value.length) {
      add(`observations.${key} must not contain duplicates`);
    }
  }
  if (typeof proof?.observations?.extensionCount !== "number") {
    add("observations.extensionCount must be a number");
  }

  if (proof?.hostConstraints?.source !== "package-lock.json") {
    add("hostConstraints.source must be package-lock.json");
  }
  if (proof?.hostConstraints?.informationalOnly !== true) {
    add("hostConstraints.informationalOnly must be true");
  }
  if (!Array.isArray(proof?.channels) || !proof.channels.includes("npm-tarball")) {
    add('channels must include "npm-tarball"');
  }
  if (!Array.isArray(proof?.limitations) || proof.limitations.length === 0) {
    add("limitations must be a nonempty array");
  }

  if (observations !== undefined) {
    const actual = observationsFromDiscovery(observations, packageFiles.length, agentNames);
    for (const key of Object.keys(actual)) {
      if (stableStringify(actual[key]) !== stableStringify(proof?.observations?.[key])) {
        add(`observations.${key} does not match the current package`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function readProof(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "proofs", "install.json"), "utf8"));
}

export function proofJson(proof) {
  return `${JSON.stringify(proof, null, 2)}\n`;
}
