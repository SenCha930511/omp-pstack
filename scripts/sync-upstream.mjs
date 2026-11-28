import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPSTREAM_SCHEMA,
  UPSTREAM_SOURCE_PREFIX,
  addLocalOnly,
  collectFiles,
  gitBlobSha,
  readManifest,
  readSyncConfig,
  sortEntries,
  targetForSource,
  writeManifest,
  writeSyncConfig,
} from "./upstream-manifest.mjs";
import { findForbiddenReferences } from "./upstream-patterns.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const USAGE =
  "Usage: node scripts/sync-upstream.mjs --cursor-dir <dir> --cursor-sha <sha> [--root <dir>] [--cursor-changed-file <file>] [--cursor-commits-file <file>] [--report-output <file>] [--summary-json <file>] [--dry-run]";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".mp4",
  ".mov",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".wasm",
  ".jar",
  ".class",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
]);

export function parseArgs(argv) {
  const options = {
    root: path.resolve(path.dirname(SCRIPT_PATH), ".."),
    cursorDir: undefined,
    cursorSha: undefined,
    cursorChangedFile: undefined,
    cursorCommitsFile: undefined,
    reportOutput: undefined,
    summaryJson: undefined,
    dryRun: false,
  };
  const seen = new Set();
  const valueFlags = new Set([
    "--root",
    "--cursor-dir",
    "--cursor-sha",
    "--cursor-changed-file",
    "--cursor-commits-file",
    "--report-output",
    "--summary-json",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (seen.has(argument)) throw new Error("--dry-run may be supplied only once");
      seen.add(argument);
      options.dryRun = true;
      continue;
    }
    if (!valueFlags.has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value`);
    index += 1;
    if (argument === "--root") options.root = path.resolve(value);
    else if (argument === "--cursor-dir") options.cursorDir = path.resolve(value);
    else if (argument === "--cursor-sha") options.cursorSha = value.trim();
    else if (argument === "--cursor-changed-file") options.cursorChangedFile = path.resolve(value);
    else if (argument === "--cursor-commits-file") options.cursorCommitsFile = path.resolve(value);
    else if (argument === "--report-output") options.reportOutput = path.resolve(value);
    else options.summaryJson = path.resolve(value);
  }
  if (!options.cursorDir) throw new Error("--cursor-dir is required");
  if (!options.cursorSha) throw new Error("--cursor-sha is required");
  return options;
}

function listDirectories(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function shouldScanFile(file) {
  if (file.relative.startsWith("scripts/test/") || file.relative.includes("/test/")) return false;
  const ext = path.extname(file.relative).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  const buf = fs.readFileSync(file.fullPath);
  return !buf.subarray(0, 8192).includes(0);
}

export function scanForbiddenReferences(skillDir) {
  const matches = [];
  for (const file of collectFiles(skillDir)) {
    if (!shouldScanFile(file)) continue;
    const text = fs.readFileSync(file.fullPath, "utf8");
    for (const match of findForbiddenReferences(text)) {
      matches.push({ file: file.relative, pattern: match.pattern });
    }
  }
  return matches;
}

function parseChangedEntries(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length >= 3) {
      const status = parts[0].charAt(0);
      entries.push({
        status,
        oldPath: parts[1].replaceAll("\\", "/"),
        path: parts[2].replaceAll("\\", "/"),
      });
    } else if (parts.length === 2) {
      const status = parts[0].charAt(0);
      entries.push({ status, path: parts[1].replaceAll("\\", "/") });
    } else {
      entries.push({ status: "M", path: parts[0].replaceAll("\\", "/") });
    }
  }
  return entries;
}

function readJsonOptional(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function isPackagingPath(relativeUnderCursorPath) {
  return (
    relativeUnderCursorPath === ".cursor-plugin" ||
    relativeUnderCursorPath.startsWith(".cursor-plugin/") ||
    relativeUnderCursorPath === "plugin.json" ||
    relativeUnderCursorPath === "assets" ||
    relativeUnderCursorPath.startsWith("assets/") ||
    relativeUnderCursorPath === ".gitignore"
  );
}

function formatCodeSpan(text) {
  const clean = String(text).replace(/[\r\n]+/g, " ");
  return clean.includes("`") ? `\`\` ${clean} \`\`` : `\`${clean}\``;
}

function formatCommitList(commits, repo) {
  if (commits.length === 0) return "_No new commits recorded._";
  return commits
    .map((commit) => {
      const short = String(commit.sha ?? "").slice(0, 7);
      const date = commit.date ? ` (${String(commit.date).slice(0, 10)})` : "";
      const url = `https://github.com/${repo}/commit/${commit.sha}`;
      return `- [\`${short}\`](${url})${date}: ${commit.subject ?? ""}`;
    })
    .join("\n");
}

function buildReport(config, summary, cursorCommits) {
  const cursor = config.cursor;
  const oldShort = cursor.lastSyncedSha.slice(0, 7);
  const lines = [
    "## Upstream pstack Sync Summary",
    "",
    `- **Upstream**: [\`${cursor.repo}\`](https://github.com/${cursor.repo}/tree/${cursor.branch}/${cursor.path}) (\`${oldShort}\` → \`${summary.shortSha}\`)`,
    `- **Compare**: https://github.com/${cursor.repo}/compare/${cursor.lastSyncedSha}...${summary.cursorSha}`,
    `- **Action mode**: \`${summary.mode}\``,
    "",
  ];

  if (cursorCommits.length > 0) {
    lines.push("### Upstream Commits", "", formatCommitList(cursorCommits, cursor.repo), "");
  }

  if (summary.addedSkills.length > 0 || summary.updatedSkills.length > 0) {
    lines.push("### Auto-synced Changes", "");
    if (summary.addedSkills.length > 0) {
      lines.push(`- **Added skills**: ${summary.addedSkills.map((s) => `\`${s}\``).join(", ")}`);
    }
    if (summary.updatedSkills.length > 0) {
      lines.push(`- **Updated skills**: ${summary.updatedSkills.map((s) => `\`${s}\``).join(", ")}`);
    }
    lines.push(
      `- **Files copied verbatim**: ${summary.copiedFiles.length}`,
      "",
      summary.pending
        ? "These files are staged in `upstream.json` under `pending.copiedVerbatim` until `sync:ack` accepts them."
        : "These files and the new `upstream.json` pin land in this PR together.",
      "",
    );
  }

  const safeBlockedSkills = summary.blockedCursorSkills.filter((item) => SAFE_SKILL_NAME.test(item.name));
  const unsafeBlockedSkills = summary.blockedCursorSkills.filter((item) => !SAFE_SKILL_NAME.test(item.name));
  const hasManual =
    summary.manualAdaptedSkills.length > 0 ||
    summary.blockedCursorSkills.length > 0 ||
    summary.removedUpstreamSkills.length > 0 ||
    summary.manualOtherFiles.length > 0;

  if (hasManual) {
    lines.push("### Manual Porting Required", "");
    if (summary.manualAdaptedSkills.length > 0) {
      lines.push("**Adapted skills changed upstream (preserved local omp adaptations):**");
      for (const item of summary.manualAdaptedSkills) {
        lines.push(`- ${formatCodeSpan(item.name)}: ${item.files.map((f) => formatCodeSpan(f)).join(", ")}`);
      }
      lines.push("");
    }
    if (summary.blockedCursorSkills.length > 0) {
      lines.push("**Unadapted/new skills skipped due to Cursor-specific references:**");
      for (const item of summary.blockedCursorSkills) {
        const detail = item.matches.map((m) => `${formatCodeSpan(m.file)} (${formatCodeSpan(m.pattern)})`).join(", ");
        lines.push(`- ${formatCodeSpan(item.name)}: ${detail}`);
      }
      if (safeBlockedSkills.length > 0) {
        const adaptFlags = safeBlockedSkills.map((item) => `--adapt ${item.name}`).join(" ");
        lines.push(
          "  - After porting, pass these skills to `sync:ack` as adapted:",
          `    \`${adaptFlags}\``,
        );
      }
      if (unsafeBlockedSkills.length > 0) {
        lines.push(
          `  - Warning: skipped CLI \`--adapt\` suggestions for unsafe skill name(s): ${unsafeBlockedSkills.map((item) => formatCodeSpan(item.name)).join(", ")}. Rename to \`[A-Za-z0-9._-]+\` before recording in \`adaptedSkills\`.`,
        );
      }
      lines.push("");
    }
    if (summary.removedUpstreamSkills.length > 0) {
      lines.push(
        `**Skills removed upstream (kept locally):** ${summary.removedUpstreamSkills.map((s) => formatCodeSpan(s)).join(", ")}`,
        "",
      );
    }
    if (summary.manualOtherFiles.length > 0) {
      lines.push("**Other upstream files changed (review for omp relevance):**");
      for (const file of summary.manualOtherFiles) {
        lines.push(`- ${formatCodeSpan(file)}`);
      }
      lines.push("");
    }
  }

  if (summary.mode === "issue" || (summary.mode === "pr" && hasManual)) {
    const adaptFlags =
      safeBlockedSkills.length > 0 ? safeBlockedSkills.map((item) => ` --adapt ${item.name}`).join("") : "";
    lines.push("### After porting", "");
    lines.push(
      `Run \`npm run sync:ack -- --cursor-dir <resolved-clone> --cursor ${summary.cursorSha}${adaptFlags} [--reason <text>] [--tests <path>]\` and close this ${summary.mode === "issue" ? "issue" : "PR"}.`,
    );
    lines.push(
      "- `--reason` and `--tests` are required for any newly localized file. Reuse the reason for a skill's files or pass one per ack run.",
      "- The ack verifies the clone HEAD and skills tree, accepts the pending copied files, reclassifies the adapted skills, advances the manifest and `cursor.lastSyncedSha` together, and clears `pending`.",
      "",
    );
  }

  if (summary.mode === "pr") {
    lines.push(
      "### Notes",
      "",
      "- Note: If this PR was opened with the default `GITHUB_TOKEN`, GitHub Actions prevents it from triggering PR CI workflows automatically. Close and reopen the PR (or push an amendment commit / set `UPSTREAM_SYNC_TOKEN`) to trigger the required checks.",
    );
    if (hasManual) {
      lines.push(
        `- \`cursor.lastSyncedSha\` and \`upstream.json source.commit\` stay at \`${oldShort}\` until \`sync:ack\` runs.`,
      );
    } else {
      lines.push(
        `- \`cursor.lastSyncedSha\` and \`upstream.json source.commit\` advance together to \`${summary.shortSha}\`.`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
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

function readUpstreamBlob(cursorDir, blob) {
  return execFileSync("git", ["-C", cursorDir, "cat-file", "blob", blob], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveCommit(cursorDir, revision) {
  return execFileSync("git", ["-C", cursorDir, "rev-parse", revision], { encoding: "utf8" }).trim();
}

function skillNameOf(source, sourcePrefix) {
  return source.slice(sourcePrefix.length).split("/")[0];
}

function addSkillFile(list, skill, source) {
  let item = list.find((candidate) => candidate.name === skill);
  if (!item) {
    item = { name: skill, files: [] };
    list.push(item);
  }
  if (!item.files.includes(source)) item.files.push(source);
}

function addBlockedMatch(list, skill, source, matches) {
  let item = list.find((candidate) => candidate.name === skill);
  if (!item) {
    item = { name: skill, files: [], matches: [] };
    list.push(item);
  }
  if (!item.files.includes(source)) item.files.push(source);
  for (const match of matches) {
    item.matches.push({ file: source, pattern: match.pattern });
  }
}

export function syncUpstream(options) {
  const root = path.resolve(options.root);
  const configPath = path.join(root, ".github", "upstream-sync.json");
  const config = readSyncConfig(root);
  const manifest = readManifest(root);
  if (manifest.schema !== UPSTREAM_SCHEMA) {
    throw new Error(`upstream.json schema must be ${UPSTREAM_SCHEMA}`);
  }
  if (manifest.source?.commit !== config.cursor?.lastSyncedSha) {
    throw new Error(
      `baseline mismatch: upstream.json source.commit ${manifest.source?.commit} must equal cursor.lastSyncedSha ${config.cursor?.lastSyncedSha}`,
    );
  }

  const cursorPath = String(config.cursor.path).replace(/^\/+|\/+$/g, "");
  const sourcePrefix = `${cursorPath}/skills/`;
  const excluded = new Set(config.cursor.excludedSkills ?? []);
  const adapted = new Set(config.cursor.adaptedSkills ?? []);

  if (!options.cursorDir) throw new Error("--cursor-dir is required");
  const cursorDir = path.resolve(options.cursorDir);
  const head = resolveCommit(cursorDir, "HEAD");
  if (head !== options.cursorSha) {
    throw new Error(`cursor clone HEAD ${head} does not match --cursor-sha ${options.cursorSha}`);
  }
  const tree = resolveCommit(cursorDir, `${options.cursorSha}:${cursorPath}/skills`);
  const upstreamTree = readUpstreamTree(cursorDir, options.cursorSha, `${cursorPath}/skills`);

  const changedEntries = parseChangedEntries(options.cursorChangedFile);
  const hasChangedFile = Boolean(options.cursorChangedFile && fs.existsSync(options.cursorChangedFile));
  const changedSources = new Set();
  for (const entry of changedEntries) {
    if (entry.path) changedSources.add(entry.path);
    if (entry.oldPath) changedSources.add(entry.oldPath);
  }
  const cursorCommits = readJsonOptional(options.cursorCommitsFile, []);

  const localSkillsDir = path.join(root, "skills");
  const baselineSkills = new Set(
    manifest.entries.map((entry) => skillNameOf(entry.source, sourcePrefix)).filter(Boolean),
  );
  const upstreamSkills = new Set(
    [...upstreamTree.keys()].map((source) => skillNameOf(source, sourcePrefix)).filter(Boolean),
  );

  const copiedVerbatim = [];
  const addedSkills = [];
  const updatedSkills = [];
  const manualAdaptedSkills = [];
  const blockedCursorSkills = [];

  const sources = [...upstreamTree.keys()].sort();
  for (const source of sources) {
    const skill = skillNameOf(source, sourcePrefix);
    if (!skill) continue;
    const target = targetForSource(source);
    const upstreamEntry = upstreamTree.get(source);
    const localPath = path.join(root, target);
    const localExists = fs.existsSync(localPath);
    const upstreamBytes = readUpstreamBlob(cursorDir, upstreamEntry.blob);
    const localBlob = localExists ? gitBlobSha(fs.readFileSync(localPath)) : undefined;
    const same = localExists && localBlob === upstreamEntry.blob;
    if (same) continue;
    if (excluded.has(skill)) continue;

    const changed = !hasChangedFile || changedSources.has(source) || !localExists;
    if (adapted.has(skill)) {
      if (changed) addSkillFile(manualAdaptedSkills, skill, source);
      continue;
    }

    const ext = path.extname(source).toLowerCase();
    const binary = BINARY_EXTENSIONS.has(ext) || upstreamBytes.subarray(0, 8192).includes(0);
    const matches = binary ? [] : findForbiddenReferences(upstreamBytes.toString("utf8"));
    if (matches.length > 0) {
      if (changed) addBlockedMatch(blockedCursorSkills, skill, source, matches);
      continue;
    }

    if (!options.dryRun) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, upstreamBytes);
      if (process.platform !== "win32") {
        fs.chmodSync(localPath, upstreamEntry.mode === "100755" ? 0o755 : 0o644);
      }
    }
    copiedVerbatim.push({ source, target, blob: upstreamEntry.blob, mode: upstreamEntry.mode });
    if (localExists) {
      if (!updatedSkills.includes(skill)) updatedSkills.push(skill);
    } else if (!addedSkills.includes(skill)) {
      addedSkills.push(skill);
    }
  }

  const removedUpstreamSkills = [...baselineSkills]
    .filter(
      (skill) =>
        !upstreamSkills.has(skill) &&
        !excluded.has(skill) &&
        fs.existsSync(path.join(localSkillsDir, skill)),
    )
    .sort();

  const manualOtherFileSet = new Set();
  const cursorPrefix = `${cursorPath}/`;
  for (const entry of changedEntries) {
    for (const candidate of [entry.path, entry.oldPath]) {
      if (!candidate || !candidate.startsWith(cursorPrefix) || candidate.startsWith(sourcePrefix)) continue;
      const relative = candidate.slice(cursorPrefix.length);
      if (!isPackagingPath(relative)) manualOtherFileSet.add(candidate);
    }
  }
  const manualOtherFiles = [...manualOtherFileSet].sort();

  const hasAutoChanges = copiedVerbatim.length > 0;
  const hasManualCursorItems =
    manualAdaptedSkills.length > 0 ||
    blockedCursorSkills.length > 0 ||
    removedUpstreamSkills.length > 0 ||
    manualOtherFiles.length > 0;
  const mode = hasAutoChanges ? "pr" : hasManualCursorItems ? "issue" : "none";

  const unresolved = [
    ...manualAdaptedSkills.map((item) => ({ kind: "adapted", skill: item.name, files: item.files })),
    ...blockedCursorSkills.map((item) => ({
      kind: "blocked",
      skill: item.name,
      files: item.files,
      matches: item.matches,
    })),
    ...removedUpstreamSkills.map((skill) => ({ kind: "removed", skill })),
    ...manualOtherFiles.map((file) => ({ kind: "other", file })),
  ];

  const summary = {
    mode,
    cursorSha: options.cursorSha,
    shortSha: options.cursorSha.slice(0, 7),
    cursorTree: tree,
    cursorShaAdvanced: mode === "pr" && !hasManualCursorItems && !options.dryRun,
    addedSkills,
    updatedSkills,
    copiedFiles: copiedVerbatim.map((entry) => entry.target),
    manualAdaptedSkills,
    blockedCursorSkills,
    removedUpstreamSkills,
    manualOtherFiles,
    pending: mode === "pr" && hasManualCursorItems,
  };

  const report = buildReport(config, summary, cursorCommits);

  if (!options.dryRun) {
    if (mode === "pr") {
      if (hasManualCursorItems) {
        manifest.pending = {
          commit: options.cursorSha,
          tree,
          copiedVerbatim,
          unresolved,
        };
      } else {
        const upstreamSources = new Set(upstreamTree.keys());
        const bySource = new Map(manifest.entries.map((entry) => [entry.source, entry]));
        for (const copied of copiedVerbatim) {
          bySource.set(copied.source, { ...copied, rule: "verbatim" });
        }
        const kept = [];
        for (const entry of bySource.values()) {
          if (upstreamSources.has(entry.source)) {
            kept.push(entry);
            continue;
          }
          if (fs.existsSync(path.join(root, entry.target))) {
            addLocalOnly(
              manifest,
              entry.target,
              `Kept locally after upstream removed ${entry.source}.`,
            );
          }
        }
        manifest.entries = sortEntries(kept);
        manifest.localOnly = (manifest.localOnly ?? []).filter((item) =>
          fs.existsSync(path.join(root, item.target)),
        );
        manifest.source = {
          ...manifest.source,
          commit: options.cursorSha,
          tree,
        };
        delete manifest.pending;
        config.cursor.lastSyncedSha = options.cursorSha;
        writeSyncConfig(root, config);
      }
      writeManifest(root, manifest);
    }
  }

  if (options.reportOutput) {
    fs.mkdirSync(path.dirname(options.reportOutput), { recursive: true });
    fs.writeFileSync(options.reportOutput, report, "utf8");
  }
  if (options.summaryJson) {
    fs.mkdirSync(path.dirname(options.summaryJson), { recursive: true });
    fs.writeFileSync(options.summaryJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  return { summary, report };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { summary } = syncUpstream(options);
    console.log(
      `Upstream sync (${summary.mode}): +${summary.addedSkills.length} added, ~${summary.updatedSkills.length} updated, ${summary.manualAdaptedSkills.length} adapted changed, ${summary.blockedCursorSkills.length} blocked, ${summary.copiedFiles.length} files copied.`,
    );
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    process.exitCode = 2;
  }
}
