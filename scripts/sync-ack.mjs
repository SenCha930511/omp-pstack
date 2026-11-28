import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkUpstream } from "./check-upstream.mjs";
import {
  addLocalOnly,
  collectFiles,
  gitBlobSha,
  localFileMode,
  readManifest,
  readSyncConfig,
  sortEntries,
  targetForSource,
  writeManifest,
  writeSyncConfig,
} from "./upstream-manifest.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const USAGE =
  "Usage: node scripts/sync-ack.mjs --cursor-dir <dir> [--cursor <sha>] [--adapt <skill> ...] [--exclude <skill> ...] [--adapt-only] [--reason <text>] [--tests <path> ...] [--root <dir>]";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const DEFAULT_TESTS = ["tests/skills.test.mjs"];

function parseArgs(argv) {
  const options = {
    root: path.resolve(path.dirname(SCRIPT_PATH), ".."),
    cursor: undefined,
    cursorDir: undefined,
    adapt: [],
    exclude: [],
    adaptOnly: false,
    reason: undefined,
  };
  const seen = new Set();
  const singleFlags = new Set(["--root", "--cursor", "--cursor-dir", "--reason"]);
  const multiFlags = new Set(["--adapt", "--exclude", "--tests"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--adapt-only") {
      if (seen.has(argument)) throw new Error("--adapt-only may be supplied only once");
      seen.add(argument);
      options.adaptOnly = true;
      continue;
    }
    if (!singleFlags.has(argument) && !multiFlags.has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (singleFlags.has(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`);
      seen.add(argument);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value`);
    index += 1;
    if (argument === "--root") options.root = path.resolve(value);
    else if (argument === "--cursor") options.cursor = value.trim();
    else if (argument === "--cursor-dir") options.cursorDir = path.resolve(value);
    else if (argument === "--reason") options.reason = value.trim();
    else if (argument === "--adapt") options.adapt.push(value.trim());
    else if (argument === "--exclude") options.exclude.push(value.trim());
    else options.tests.push(value.trim());
  }
  if (!options.cursorDir) throw new Error("--cursor-dir is required");
  if (options.adaptOnly) {
    if (options.cursor !== undefined) {
      throw new Error("--adapt-only cannot be combined with --cursor");
    }
    if (options.adapt.length === 0) {
      throw new Error("--adapt-only requires at least one --adapt <skill>");
    }
    if (options.exclude.length > 0) {
      throw new Error("--adapt-only cannot be combined with --exclude");
    }
  }
  return options;
}

function assertSha(flag, sha) {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${flag} must be a full 40-character lowercase SHA: ${sha}`);
  }
}

function validateSkillName(rawSkill) {
  const skill = rawSkill.trim();
  if (!skill) throw new Error("--adapt requires a nonempty skill name");
  if (!SAFE_SKILL_NAME.test(skill) || skill === "." || skill === "..") {
    throw new Error(`invalid skill name for --adapt: ${skill}`);
  }
  return skill;
}

function resolveCommit(cursorDir, revision) {
  return execFileSync("git", ["-C", cursorDir, "rev-parse", revision], { encoding: "utf8" }).trim();
}

function readUpstreamTree(cursorDir, commit, sourcePath) {
  const output = execFileSync("git", ["-C", cursorDir, "ls-tree", "-r", commit, "--", sourcePath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) continue;
    entries.set(match[3], { mode: match[1], blob: match[2] });
  }
  return entries;
}

function replaceEntry(entries, entry) {
  const index = entries.findIndex((candidate) => candidate.source === entry.source);
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
}



function reconcileRemoved({ root, manifest, upstreamTree, reason }) {
  const sources = new Set(upstreamTree.keys());
  const removed = manifest.entries.filter((entry) => !sources.has(entry.source));
  if (removed.length === 0) return;
  for (const entry of removed) {
    if (fs.existsSync(path.join(root, entry.target))) {
      addLocalOnly(
        manifest,
        entry.target,
        reason ?? `Kept locally after upstream removed ${entry.source}.`,
      );
    }
  }
  const removedSources = new Set(removed.map((entry) => entry.source));
  manifest.entries = manifest.entries.filter((entry) => !removedSources.has(entry.source));
}

function reclassifySkill({
  root,
  manifest,
  skill,
  upstreamTree,
  sourcePrefix,
  reason,
  tests,
}) {
  const sources = [...upstreamTree.keys()].filter((source) => source.startsWith(`${sourcePrefix}${skill}/`));
  if (sources.length === 0) throw new Error(`adapted skill does not exist upstream: ${skill}`);

  for (const source of sources.sort()) {
    const target = targetForSource(source);
    const localPath = path.join(root, target);
    if (!fs.existsSync(localPath)) {
      throw new Error(`adapted skill file is missing locally: ${target}`);
    }
    const upstreamEntry = upstreamTree.get(source);
    const existing = manifest.entries.find((entry) => entry.source === source);
    const localBlob = gitBlobSha(fs.readFileSync(localPath));
    if (localBlob === upstreamEntry.blob) {
      replaceEntry(manifest.entries, {
        source,
        target,
        blob: upstreamEntry.blob,
        mode: upstreamEntry.mode,
        rule: "verbatim",
      });
      continue;
    }
    const finalReason = reason ?? existing?.reason;
    const finalTests = tests.length > 0 ? tests : existing?.tests ?? DEFAULT_TESTS;
    if (!finalReason) throw new Error(`local entry needs --reason: ${target}`);
    replaceEntry(manifest.entries, {
      source,
      target,
      blob: upstreamEntry.blob,
      mode: upstreamEntry.mode,
      rule: "local",
      reason: finalReason,
      tests: finalTests,
    });
  }

  const targets = new Set(sources.map((source) => targetForSource(source)));
  for (const file of collectFiles(path.join(root, "skills", skill), root)) {
    if (targets.has(file.relative)) continue;
    addLocalOnly(manifest, file.relative, reason ?? "Local-only file kept after upstream removal.");
  }
}

function excludeSkill({ root, manifest, skill, upstreamTree, sourcePrefix, reason }) {
  const sources = [...upstreamTree.keys()].filter((source) => source.startsWith(`${sourcePrefix}${skill}/`));
  if (sources.length === 0) throw new Error(`excluded skill does not exist upstream: ${skill}`);
  for (const source of sources.sort()) {
    const target = targetForSource(source);
    if (fs.existsSync(path.join(root, target))) {
      throw new Error(`excluded skill file exists locally: ${target}`);
    }
    const upstreamEntry = upstreamTree.get(source);
    const existing = manifest.entries.find((entry) => entry.source === source);
    replaceEntry(manifest.entries, {
      source,
      target,
      blob: upstreamEntry.blob,
      mode: upstreamEntry.mode,
      rule: "excluded",
      reason: reason ?? existing?.reason ?? `Excluded upstream file in ${skill}.`,
    });
  }
}

function verifyPendingCopies({ root, pending }) {
  if (!Array.isArray(pending.copiedVerbatim)) return;
  for (const item of pending.copiedVerbatim) {
    const targetPath = path.join(root, item.target);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`pending copied file is missing: ${item.target}`);
    }
    const blob = gitBlobSha(fs.readFileSync(targetPath));
    if (blob !== item.blob) {
      throw new Error(`pending copied file ${item.target} has blob ${blob}, expected ${item.blob}`);
    }
    const mode = localFileMode(targetPath);
    if (mode !== undefined && mode !== item.mode) {
      throw new Error(`pending copied file ${item.target} has mode ${mode}, expected ${item.mode}`);
    }
  }
}

function validateAndWrite({ root, cursorDir, configPath, manifestPath, configBackup, manifestBackup, config, manifest }) {
  writeSyncConfig(root, config);
  writeManifest(root, manifest);
  const result = checkUpstream({ root, cursorDir });
  if (!result.ok) {
    fs.writeFileSync(configPath, configBackup, "utf8");
    fs.writeFileSync(manifestPath, manifestBackup, "utf8");
    throw new Error(`ack would leave an invalid manifest:\n${result.errors.join("\n")}`);
  }
}

export function ackUpstream({
  root,
  cursor,
  cursorDir,
  adapt = [],
  exclude = [],
  adaptOnly = false,
  reason,
  tests = [],
}) {
  const repositoryRoot = path.resolve(root);
  const configPath = path.join(repositoryRoot, ".github", "upstream-sync.json");
  const manifestPath = path.join(repositoryRoot, "upstream.json");
  const configBackup = fs.readFileSync(configPath, "utf8");
  const manifestBackup = fs.readFileSync(manifestPath, "utf8");
  const config = JSON.parse(configBackup);
  const manifest = JSON.parse(manifestBackup);

  if (!cursorDir) throw new Error("--cursor-dir is required");
  const resolvedCursorDir = path.resolve(cursorDir);
  const head = resolveCommit(resolvedCursorDir, "HEAD");
  const tree = resolveCommit(resolvedCursorDir, `${head}:${config.cursor.path.replace(/^\/+|\/+$/g, "")}/skills`);

  const adaptedSkills = new Set(config.cursor.adaptedSkills ?? []);
  const excludedSkills = new Set(config.cursor.excludedSkills ?? []);
  const requested = adapt.map(validateSkillName);
  const requestedExcluded = exclude.map(validateSkillName);
  if (adaptOnly && cursor !== undefined) {
    throw new Error("--adapt-only cannot be combined with --cursor");
  }
  if (adaptOnly && requested.length === 0) {
    throw new Error("--adapt-only requires at least one --adapt <skill>");
  }
  if (adaptOnly && requestedExcluded.length > 0) {
    throw new Error("--adapt-only cannot be combined with --exclude");
  }

  const sourcePrefix = `${config.cursor.path.replace(/^\/+|\/+$/g, "")}/skills/`;
  const upstreamTree = readUpstreamTree(
    resolvedCursorDir,
    head,
    `${config.cursor.path.replace(/^\/+|\/+$/g, "")}/skills`,
  );
  const reasons = reason ? [reason] : [];

  let resolvedSkills = new Set(requested);
  if (adaptOnly && manifest.pending) {
    throw new Error("--adapt-only cannot run while upstream.json has pending copies; run a full ack");
  }
  if (manifest.pending) {
    const pending = manifest.pending;
    if (pending.commit !== head) {
      throw new Error(`pending.commit ${pending.commit} does not match clone HEAD ${head}`);
    }
    if (cursor !== undefined && cursor !== pending.commit) {
      throw new Error(`--cursor ${cursor} does not match pending.commit ${pending.commit}`);
    }
    if (pending.tree !== tree) {
      throw new Error(`pending.tree ${pending.tree} does not match clone tree ${tree}`);
    }
    verifyPendingCopies({ root: repositoryRoot, pending });
    for (const item of pending.copiedVerbatim ?? []) {
      replaceEntry(manifest.entries, {
        source: item.source,
        target: item.target,
        blob: item.blob,
        mode: item.mode,
        rule: "verbatim",
      });
    }

    for (const item of pending.unresolved ?? []) {
      if (item.kind === "adapted") {
        if (!adaptedSkills.has(item.skill) && !requested.includes(item.skill)) {
          throw new Error(`adapted skill still unresolved; pass --adapt ${item.skill}`);
        }
        resolvedSkills.add(item.skill);
      } else if (item.kind === "blocked") {
        if (!requested.includes(item.skill)) {
          throw new Error(`blocked skill still unresolved; port it and pass --adapt ${item.skill}`);
        }
        resolvedSkills.add(item.skill);
      } else if (item.kind === "excluded") {
        excludeSkill({
          root: repositoryRoot,
          manifest,
          skill: item.skill,
          upstreamTree,
          sourcePrefix,
          reason,
        });
        excludedSkills.add(item.skill);
        adaptedSkills.delete(item.skill);
      } else if (item.kind === "removed") {
        for (const file of collectFiles(path.join(repositoryRoot, "skills", item.skill), repositoryRoot)) {
          addLocalOnly(
            manifest,
            file.relative,
            reason ?? `Kept locally after upstream removed ${item.skill}.`,
          );
        }
      } else if (item.kind === "other" && reasons.length === 0) {
        throw new Error(`other upstream file needs review; pass --reason after porting: ${item.file}`);
      }
    }

    for (const skill of resolvedSkills) {
      adaptedSkills.add(skill);
      reclassifySkill({
        root: repositoryRoot,
        manifest,
        skill,
        upstreamTree,
        sourcePrefix,
        reason,
        tests,
      });
    }
    for (const skill of requestedExcluded) {
      excludeSkill({
        root: repositoryRoot,
        manifest,
        skill,
        upstreamTree,
        sourcePrefix,
        reason,
      });
      excludedSkills.add(skill);
      adaptedSkills.delete(skill);
    }

    reconcileRemoved({ root: repositoryRoot, manifest, upstreamTree, reason });
    manifest.source = { ...manifest.source, commit: pending.commit, tree: pending.tree };
    delete manifest.pending;
    manifest.entries = sortEntries(manifest.entries);
    config.cursor.excludedSkills = [...excludedSkills].sort();
    config.cursor.adaptedSkills = [...adaptedSkills]
      .filter((skill) => !excludedSkills.has(skill))
      .sort();
    config.cursor.lastSyncedSha = pending.commit;
    validateAndWrite({
      root: repositoryRoot,
      cursorDir: resolvedCursorDir,
      configPath,
      manifestPath,
      configBackup,
      manifestBackup,
      config,
      manifest,
    });
    return { cursor: pending.commit, tree: pending.tree, skills: [...resolvedSkills].sort(), pending: false };
  }

  if (cursor !== undefined) {
    assertSha("--cursor", cursor);
    if (cursor !== head) throw new Error(`--cursor ${cursor} does not match clone HEAD ${head}`);
  }

  for (const skill of resolvedSkills) adaptedSkills.add(skill);
  if (!adaptOnly) {
    for (const skill of requestedExcluded) {
      excludeSkill({
        root: repositoryRoot,
        manifest,
        skill,
        upstreamTree,
        sourcePrefix,
        reason,
      });
      excludedSkills.add(skill);
      adaptedSkills.delete(skill);
    }
    resolvedSkills = new Set([...resolvedSkills].filter((skill) => !excludedSkills.has(skill)));
  }

  if (!adaptOnly) {
    for (const skill of resolvedSkills) {
      reclassifySkill({
        root: repositoryRoot,
        manifest,
        skill,
        upstreamTree,
        sourcePrefix,
        reason,
        tests,
      });
    }
    reconcileRemoved({ root: repositoryRoot, manifest, upstreamTree, reason });
    manifest.source = { ...manifest.source, commit: head, tree };
    manifest.entries = sortEntries(manifest.entries);
    config.cursor.lastSyncedSha = head;
  }
  config.cursor.excludedSkills = [...excludedSkills].sort();
  config.cursor.adaptedSkills = [...adaptedSkills]
    .filter((skill) => !excludedSkills.has(skill))
    .sort();
  validateAndWrite({
    root: repositoryRoot,
    cursorDir: resolvedCursorDir,
    configPath,
    manifestPath,
    configBackup,
    manifestBackup,
    config,
    manifest,
  });
  return { cursor: adaptOnly ? config.cursor.lastSyncedSha : head, tree, skills: [...resolvedSkills].sort(), pending: false };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = ackUpstream(options);
    if (!options.adaptOnly) console.log(`cursor.lastSyncedSha: ${result.cursor}`);
    if (options.adapt.length > 0) console.log(`cursor.adaptedSkills added: ${options.adapt.join(", ")}`);
    if (options.exclude.length > 0) console.log(`cursor.excludedSkills added: ${options.exclude.join(", ")}`);
    if (result.pending) console.log("pending ack incomplete");
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    process.exitCode = 2;
  }
}
