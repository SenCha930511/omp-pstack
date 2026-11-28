import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPSTREAM_RULES,
  UPSTREAM_SCHEMA,
  UPSTREAM_SOURCE_PREFIX,
  collectFiles,
  gitBlobSha,
  localFileMode,
  readJson,
  readManifest,
  readSyncConfig,
  targetForSource,
} from "./upstream-manifest.mjs";
import { findForbiddenReferences } from "./upstream-patterns.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function isSafeRelative(relative) {
  if (!relative || relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.includes("\\")) {
    return false;
  }
  return relative.split("/").every((part) => part && part !== "." && part !== "..");
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectCheckArtifacts(root) {
  const scripts = readJson(path.join(root, "package.json")).scripts ?? {};
  const seen = new Set();
  const artifacts = new Set();

  function expand(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const command = scripts[name];
    if (!command) return;
    for (const match of command.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) expand(match[1]);
    for (const raw of command.split(/\s+/)) {
      const token = raw.replace(/^["']|["']$/g, "");
      if (!token || token.startsWith("-") || token.includes("=")) continue;
      if (token.includes("*")) {
        const directory = path.posix.dirname(token);
        const pattern = path.posix.basename(token);
        const absoluteDirectory = path.join(root, directory);
        if (!fs.existsSync(absoluteDirectory)) continue;
        const regex = new RegExp(
          `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
        );
        for (const file of fs.readdirSync(absoluteDirectory)) {
          if (regex.test(file)) artifacts.add(path.posix.join(directory, file));
        }
        continue;
      }
      if (fs.existsSync(path.join(root, token))) artifacts.add(token);
    }
  }

  expand("check");
  return artifacts;
}

function readGitTree(cursorDir, commit, sourcePath) {
  const output = execFileSync("git", ["-C", cursorDir, "ls-tree", "-r", commit, "--", sourcePath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
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

function gitResolve(cursorDir, revision) {
  return execFileSync("git", ["-C", cursorDir, "rev-parse", revision], {
    encoding: "utf8",
  }).trim();
}

function validateEntryBasics(entry, errors, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${label}: must be an object`);
    return false;
  }
  if (typeof entry.source !== "string" || !entry.source.startsWith(UPSTREAM_SOURCE_PREFIX)) {
    errors.push(`${label}: source must start with ${UPSTREAM_SOURCE_PREFIX}: ${JSON.stringify(entry.source)}`);
    return false;
  }
  const sourceRelative = entry.source.slice(UPSTREAM_SOURCE_PREFIX.length);
  if (!isSafeRelative(sourceRelative)) {
    errors.push(`${label}: unsafe source: ${JSON.stringify(entry.source)}`);
    return false;
  }
  const expectedTarget = targetForSource(entry.source);
  if (entry.target !== expectedTarget) {
    errors.push(`${label}: target must be ${expectedTarget}, got ${JSON.stringify(entry.target)}`);
    return false;
  }
  if (!isSafeRelative(entry.target)) {
    errors.push(`${label}: unsafe target: ${JSON.stringify(entry.target)}`);
    return false;
  }
  if (typeof entry.blob !== "string" || !SHA_PATTERN.test(entry.blob)) {
    errors.push(`${label}: blob must be a 40-character lowercase SHA: ${JSON.stringify(entry.blob)}`);
  }
  if (entry.mode !== "100644" && entry.mode !== "100755") {
    errors.push(`${label}: mode must be 100644 or 100755: ${JSON.stringify(entry.mode)}`);
  }
  if (!UPSTREAM_RULES.has(entry.rule)) {
    errors.push(`${label}: rule must be verbatim, local, or excluded: ${JSON.stringify(entry.rule)}`);
    return false;
  }
  return true;
}

function checkLocalFile(entry, root, skillsRoot, errors) {
  const targetPath = path.join(root, entry.target);
  if (!fs.existsSync(targetPath)) {
    errors.push(`${entry.target}: local file is missing for ${entry.rule} entry`);
    return;
  }
  const stats = fs.lstatSync(targetPath);
  if (stats.isSymbolicLink()) {
    errors.push(`${entry.target}: local file must not be a symlink`);
    return;
  }
  if (!isWithin(fs.realpathSync(skillsRoot), fs.realpathSync(targetPath))) {
    errors.push(`${entry.target}: local file resolves outside skills/`);
    return;
  }
  const bytes = fs.readFileSync(targetPath);
  const blob = gitBlobSha(bytes);
  const mode = localFileMode(targetPath);
  if (entry.rule === "verbatim") {
    if (blob !== entry.blob) {
      errors.push(`${entry.target}: blob ${blob} does not match recorded ${entry.blob}`);
    }
    if (mode !== undefined && mode !== entry.mode) {
      errors.push(`${entry.target}: mode ${mode} does not match recorded ${entry.mode}`);
    }
    const matches = findForbiddenReferences(bytes.toString("utf8"));
    if (matches.length > 0) {
      errors.push(
        `${entry.target}: verbatim file contains Cursor-only references: ${matches.map((m) => m.pattern).join(", ")}`,
      );
    }
    return;
  }
  if (blob === entry.blob && (mode === undefined || mode === entry.mode)) {
    errors.push(`${entry.target}: local entry is byte-identical to upstream; use verbatim`);
  }
}

function checkLocalEntryMetadata(entry, root, artifacts, errors) {
  if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
    errors.push(`${entry.target}: local entry needs a nonempty reason`);
  }
  if (!Array.isArray(entry.tests) || entry.tests.length === 0) {
    errors.push(`${entry.target}: local entry needs at least one test artifact`);
    return;
  }
  for (const test of entry.tests) {
    if (typeof test !== "string" || !isSafeRelative(test)) {
      errors.push(`${entry.target}: unsafe test artifact: ${JSON.stringify(test)}`);
      continue;
    }
    if (!fs.existsSync(path.join(root, test))) {
      errors.push(`${entry.target}: test artifact does not exist: ${test}`);
    }
    if (!artifacts.has(test)) {
      errors.push(`${entry.target}: test artifact is not covered by npm run check: ${test}`);
    }
  }
}

function checkPending(pending, root, skillsRoot, errors, pendingTargets) {
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    errors.push("pending: must be an object");
    return;
  }
  if (typeof pending.commit !== "string" || !SHA_PATTERN.test(pending.commit)) {
    errors.push("pending.commit: must be a 40-character lowercase SHA");
  }
  if (typeof pending.tree !== "string" || !SHA_PATTERN.test(pending.tree)) {
    errors.push("pending.tree: must be a 40-character lowercase SHA");
  }
  if (!Array.isArray(pending.copiedVerbatim)) {
    errors.push("pending.copiedVerbatim: must be an array");
  } else {
    for (const [index, item] of pending.copiedVerbatim.entries()) {
      const label = `pending.copiedVerbatim[${index}]`;
      if (!validateEntryBasics({ ...item, rule: "verbatim" }, errors, label)) continue;
      pendingTargets.add(item.target);
      checkLocalFile({ ...item, rule: "verbatim" }, root, skillsRoot, errors);
    }
  }
  if (pending.unresolved !== undefined && !Array.isArray(pending.unresolved)) {
    errors.push("pending.unresolved: must be an array when present");
  }
}

function checkUpstreamTree(cursorDir, commit, tree, entries, pendingEntries, errors, label, mode) {
  if (!cursorDir) return;
  let resolvedCommit;
  let resolvedTree;
  try {
    resolvedCommit = gitResolve(cursorDir, `${commit}^{commit}`);
    resolvedTree = gitResolve(cursorDir, `${resolvedCommit}:pstack/skills`);
  } catch (error) {
    errors.push(`${label}: cannot resolve ${commit} in ${cursorDir}: ${error.message}`);
    return;
  }
  if (resolvedTree !== tree) {
    errors.push(`${label}: tree ${resolvedTree} does not match recorded ${tree}`);
  }
  let upstream;
  try {
    upstream = readGitTree(cursorDir, resolvedCommit, "pstack/skills");
  } catch (error) {
    errors.push(`${label}: cannot read upstream tree: ${error.message}`);
    return;
  }
  const manifestSources = new Set(entries.map((entry) => entry.source));

  if (mode === "baseline") {
    for (const [source, upstreamEntry] of upstream) {
      const entry = entries.find((candidate) => candidate.source === source);
      if (!entry) {
        errors.push(`${label}: upstream file has no manifest entry: ${source}`);
        continue;
      }
      if (entry.blob !== upstreamEntry.blob) {
        errors.push(`${label}: ${source}: blob ${entry.blob} does not match upstream ${upstreamEntry.blob}`);
      }
      if (entry.mode !== upstreamEntry.mode) {
        errors.push(`${label}: ${source}: mode ${entry.mode} does not match upstream ${upstreamEntry.mode}`);
      }
    }
    for (const source of manifestSources) {
      if (!upstream.has(source)) {
        errors.push(`${label}: manifest entry is not in the upstream tree: ${source}`);
      }
    }
    return;
  }

  if (!pendingEntries) return;
  const pendingSources = new Set(pendingEntries.map((entry) => entry.source));
  for (const [source] of upstream) {
    if (manifestSources.has(source) || pendingSources.has(source)) continue;
    errors.push(`${label}: upstream file has no manifest or pending entry: ${source}`);
  }
  for (const entry of pendingEntries) {
    const upstreamEntry = upstream.get(entry.source);
    if (!upstreamEntry) {
      errors.push(`${label}: pending file is not in the upstream tree: ${entry.source}`);
    } else if (entry.blob !== upstreamEntry.blob || entry.mode !== upstreamEntry.mode) {
      errors.push(`${label}: pending ${entry.source} does not match upstream blob or mode`);
    }
  }
}

export function checkUpstream({ root, cursorDir } = {}) {
  const repositoryRoot = path.resolve(root ?? path.join(path.dirname(SCRIPT_PATH), ".."));
  const errors = [];
  let manifest;
  let config;
  try {
    manifest = readManifest(repositoryRoot);
  } catch (error) {
    return { ok: false, errors: [`cannot read upstream.json: ${error.message}`], counts: {} };
  }
  try {
    config = readSyncConfig(repositoryRoot);
  } catch (error) {
    return { ok: false, errors: [`cannot read .github/upstream-sync.json: ${error.message}`], counts: {} };
  }

  if (manifest.schema !== UPSTREAM_SCHEMA) {
    errors.push(`upstream.json: schema must be ${UPSTREAM_SCHEMA}`);
  }
  const source = manifest.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    errors.push("upstream.json: missing source object");
  } else {
    if (source.path !== "pstack/skills") errors.push(`source.path must be pstack/skills: ${source.path}`);
    if (typeof source.commit !== "string" || !SHA_PATTERN.test(source.commit)) {
      errors.push("source.commit must be a 40-character lowercase SHA");
    }
    if (typeof source.tree !== "string" || !SHA_PATTERN.test(source.tree)) {
      errors.push("source.tree must be a 40-character lowercase SHA");
    }
    if (source.commit !== config.cursor?.lastSyncedSha) {
      errors.push(
        `source.commit ${source.commit} must equal cursor.lastSyncedSha ${config.cursor?.lastSyncedSha}`,
      );
    }
  }

  if (!Array.isArray(manifest.entries)) {
    return { ok: false, errors: [...errors, "upstream.json: entries must be an array"], counts: {} };
  }

  const skillsRoot = path.join(repositoryRoot, "skills");
  if (!fs.existsSync(skillsRoot)) {
    errors.push("skills/: directory is missing");
  } else if (fs.lstatSync(skillsRoot).isSymbolicLink()) {
    errors.push("skills/: root must not be a symlink");
  }

  const artifacts = collectCheckArtifacts(repositoryRoot);
  const entries = manifest.entries;
  const seenSources = new Set();
  const seenTargets = new Set();
  const pendingTargets = new Set();

  if (manifest.pending !== undefined) {
    checkPending(manifest.pending, repositoryRoot, skillsRoot, errors, pendingTargets);
  }

  for (const [index, entry] of entries.entries()) {
    if (!validateEntryBasics(entry, errors, `entry ${index}`)) continue;
    if (seenSources.has(entry.source)) {
      errors.push(`${entry.source}: duplicate source`);
      continue;
    }
    if (seenTargets.has(entry.target)) {
      errors.push(`${entry.target}: duplicate target`);
      continue;
    }
    seenSources.add(entry.source);
    seenTargets.add(entry.target);

    if (entry.rule === "excluded") {
      if (fs.existsSync(path.join(repositoryRoot, entry.target))) {
        errors.push(`${entry.target}: excluded entry must not have a local file`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        errors.push(`${entry.target}: excluded entry needs a nonempty reason`);
      }
      continue;
    }

    if (!pendingTargets.has(entry.target)) {
      checkLocalFile(entry, repositoryRoot, skillsRoot, errors);
    }
    if (entry.rule === "local") {
      checkLocalEntryMetadata(entry, repositoryRoot, artifacts, errors);
    }
  }

  const localOnly = Array.isArray(manifest.localOnly) ? manifest.localOnly : [];
  for (const [index, item] of localOnly.entries()) {
    if (!item || typeof item.target !== "string" || !isSafeRelative(item.target)) {
      errors.push(`localOnly[${index}]: unsafe or missing target`);
      continue;
    }
    if (!fs.existsSync(path.join(repositoryRoot, item.target))) {
      errors.push(`${item.target}: localOnly file is missing`);
    }
    if (typeof item.reason !== "string" || item.reason.trim() === "") {
      errors.push(`${item.target}: localOnly entry needs a nonempty reason`);
    }
  }
  const localOnlyTargets = new Set(localOnly.map((item) => item.target));

  for (const file of collectFiles(skillsRoot, repositoryRoot)) {
    if (
      !seenTargets.has(file.relative) &&
      !pendingTargets.has(file.relative) &&
      !localOnlyTargets.has(file.relative)
    ) {
      errors.push(`${file.relative}: local file has no manifest entry`);
    }
  }

  const pendingEntries =
    manifest.pending && Array.isArray(manifest.pending.copiedVerbatim)
      ? manifest.pending.copiedVerbatim
      : undefined;

  if (source && typeof source.commit === "string" && typeof source.tree === "string") {
    checkUpstreamTree(cursorDir, source.commit, source.tree, entries, undefined, errors, "source", "baseline");
  }
  if (manifest.pending && typeof manifest.pending.commit === "string" && typeof manifest.pending.tree === "string") {
    checkUpstreamTree(
      cursorDir,
      manifest.pending.commit,
      manifest.pending.tree,
      entries,
      pendingEntries,
      errors,
      "pending",
      "pending",
    );
  }

  const counts = {
    entries: entries.length,
    verbatim: entries.filter((entry) => entry.rule === "verbatim").length,
    local: entries.filter((entry) => entry.rule === "local").length,
    excluded: entries.filter((entry) => entry.rule === "excluded").length,
    pendingCopied: pendingEntries?.length ?? 0,
    pendingUnresolved: Array.isArray(manifest.pending?.unresolved) ? manifest.pending.unresolved.length : 0,
  };
  return { ok: errors.length === 0, errors, counts };
}

function parseArgs(argv) {
  const options = { root: path.resolve(path.dirname(SCRIPT_PATH), ".."), cursorDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--root" && argument !== "--cursor-dir") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value`);
    index += 1;
    if (argument === "--root") options.root = path.resolve(value);
    else options.cursorDir = path.resolve(value);
  }
  return options;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = checkUpstream(options);
    if (!result.ok) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(
        `Upstream manifest: ${result.counts.entries} entries (${result.counts.verbatim} verbatim, ${result.counts.local} local, ${result.counts.excluded} excluded): PASS`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
