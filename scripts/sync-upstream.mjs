import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const USAGE =
  "Usage: node scripts/sync-upstream.mjs --cursor-dir <dir> --cursor-sha <sha> [--root <dir>] [--cursor-changed-file <file>] [--cursor-commits-file <file>] [--pi-mimir-sha <sha>] [--pi-mimir-commits-file <file>] [--report-output <file>] [--summary-json <file>] [--dry-run]";

const FORBIDDEN_PATTERNS = [
  { label: "~/.cursor/", regex: /~\/\.cursor\// },
  { label: "subagent_type", regex: /\bsubagent_type\b/ },
  { label: "cloud_base_branch", regex: /\bcloud_base_branch\b/ },
  { label: "pstack-models.mdc", regex: /pstack-models\.mdc/ },
  { label: 'environment: "cloud"', regex: /environment:\s*"cloud"/ },
  { label: "AskQuestion", regex: /\bAskQuestion\b/ },
  { label: "agent-transcripts/", regex: /agent-transcripts\// },
  { label: "cursor-team-kit", regex: /cursor-team-kit/ },
  { label: "generalPurpose", regex: /\bgeneralPurpose\b/ },
  { label: "/visualize", regex: /\/visualize\b/ },
  { label: "plugins/cache/", regex: /plugins\/cache\// },
  { label: "is_background", regex: /\bis_background\b/ },
  { label: "`subagent`", regex: /`subagent`/ },
  { label: "subagents_write_task_models", regex: /subagents_write_task_models/ },
  { label: "subagents_list", regex: /subagents_list/ },
  { label: "herdr-agents", regex: /herdr-agents/ },
  { label: "`set_tasks`", regex: /`set_tasks`/ },
];

export function parseArgs(argv) {
  const options = {
    root: path.resolve(path.dirname(SCRIPT_PATH), ".."),
    cursorDir: undefined,
    cursorSha: undefined,
    cursorChangedFile: undefined,
    cursorCommitsFile: undefined,
    piMimirSha: undefined,
    piMimirCommitsFile: undefined,
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
    "--pi-mimir-sha",
    "--pi-mimir-commits-file",
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
    else if (argument === "--pi-mimir-sha") options.piMimirSha = value.trim();
    else if (argument === "--pi-mimir-commits-file") options.piMimirCommitsFile = path.resolve(value);
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

function collectFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, base));
    } else if (entry.isFile()) {
      results.push({
        relative: path.relative(base, fullPath).replaceAll("\\", "/"),
        fullPath,
      });
    }
  }
  return results.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

function directoriesMatch(dirA, dirB) {
  if (!fs.existsSync(dirA) || !fs.existsSync(dirB)) return false;
  const filesA = collectFiles(dirA);
  const filesB = collectFiles(dirB);
  if (filesA.length !== filesB.length) return false;
  for (let index = 0; index < filesA.length; index += 1) {
    if (filesA[index].relative !== filesB[index].relative) return false;
    const bytesA = fs.readFileSync(filesA[index].fullPath);
    const bytesB = fs.readFileSync(filesB[index].fullPath);
    if (!bytesA.equals(bytesB)) return false;
  }
  return true;
}

function replaceDirectory(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of collectFiles(srcDir)) {
    const target = path.join(destDir, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.fullPath, target);
  }
}

export function scanForbiddenReferences(skillDir) {
  const matches = [];
  for (const file of collectFiles(skillDir)) {
    if (!file.relative.endsWith(".md")) continue;
    const content = fs.readFileSync(file.fullPath, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.regex.test(content)) {
        matches.push({ file: file.relative, pattern: pattern.label });
      }
    }
  }
  return matches;
}

function parseChangedFiles(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const paths = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const chosen = parts.length >= 3 ? parts[2] : parts.length === 2 ? parts[1] : parts[0];
    if (chosen) paths.add(chosen.replaceAll("\\", "/"));
  }
  return [...paths].sort();
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
    lines.push("");
  }

  const hasManualCursorItems =
    summary.manualAdaptedSkills.length > 0 ||
    summary.blockedCursorSkills.length > 0 ||
    summary.removedUpstreamSkills.length > 0 ||
    summary.manualOtherFiles.length > 0;
  const hasManual = hasManualCursorItems || summary.piMimirCommits.length > 0;

  if (hasManual) {
    lines.push("### Manual Porting Required", "");
    if (summary.manualAdaptedSkills.length > 0) {
      lines.push("**Adapted skills changed upstream (preserved local omp adaptations):**");
      for (const item of summary.manualAdaptedSkills) {
        lines.push(`- \`${item.name}\`: ${item.files.map((f) => `\`${f}\``).join(", ")}`);
      }
      lines.push("");
    }
    if (summary.blockedCursorSkills.length > 0) {
      lines.push("**Unadapted/new skills skipped due to Cursor or pi-herdr references:**");
      for (const item of summary.blockedCursorSkills) {
        const detail = item.matches.map((m) => `\`${m.file}\` (\`${m.pattern}\`)`).join(", ");
        lines.push(`- \`${item.name}\`: ${detail}`);
      }
      lines.push("");
    }
    if (summary.removedUpstreamSkills.length > 0) {
      lines.push(`**Skills removed upstream (kept locally):** ${summary.removedUpstreamSkills.map((s) => `\`${s}\``).join(", ")}`, "");
    }
    if (summary.manualOtherFiles.length > 0) {
      lines.push("**Other upstream files changed (review for omp relevance):**");
      for (const file of summary.manualOtherFiles) {
        lines.push(`- \`${file}\``);
      }
      lines.push("");
    }
    if (summary.piMimirCommits.length > 0) {
      const piRepo = config.piMimir?.repo ?? "casualjim/pi-mimir";
      lines.push(`**\`${piRepo}\` extension/agent updates:**`, "", formatCommitList(summary.piMimirCommits, piRepo), "");
    }
  }

  if (summary.mode === "issue" || (summary.mode === "pr" && hasManual)) {
    const piMimirArg = summary.piMimirCommits[0]?.sha ? ` --pi-mimir ${summary.piMimirCommits[0].sha}` : "";
    const suffix = summary.mode === "issue" ? " and close this issue." : " after porting the manual items above.";
    lines.push(
      "### After porting",
      "",
      `Run \`npm run sync:ack -- --cursor ${summary.cursorSha}${piMimirArg}\`${suffix}`,
      "",
    );
  }

  if (summary.mode === "pr") {
    lines.push(
      "### Notes",
      "",
      "- Note: If this PR was opened with the default `GITHUB_TOKEN`, GitHub Actions prevents it from triggering PR CI workflows automatically. Close and reopen the PR (or push an amendment commit / set `UPSTREAM_SYNC_TOKEN`) to trigger the required checks.",
    );
    if (hasManualCursorItems) {
      lines.push(
        `- \`cursor.lastSyncedSha\` was intentionally left at \`${oldShort}\` so remaining manual items stay tracked until \`sync:ack\` runs.`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function syncUpstream(options) {
  const configPath = path.join(options.root, ".github", "upstream-sync.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const cursorPath = config.cursor.path.replace(/^\/+|\/+$/g, "");
  const excluded = new Set(config.cursor.excludedSkills ?? []);
  const adapted = new Set(config.cursor.adaptedSkills ?? []);

  const upstreamSkillsDir = path.join(options.cursorDir, cursorPath, "skills");
  if (!fs.existsSync(upstreamSkillsDir)) {
    throw new Error(`upstream skills directory not found: ${upstreamSkillsDir}`);
  }
  const localSkillsDir = path.join(options.root, "skills");

  const changedFiles = parseChangedFiles(options.cursorChangedFile);
  const cursorCommits = readJsonOptional(options.cursorCommitsFile, []);
  const piMimirCommits = readJsonOptional(options.piMimirCommitsFile, []);

  const upstreamSkillNames = listDirectories(upstreamSkillsDir);
  const upstreamSkillSet = new Set(upstreamSkillNames);
  const localSkillNames = listDirectories(localSkillsDir);

  const addedSkills = [];
  const updatedSkills = [];
  const manualAdaptedSkills = [];
  const blockedCursorSkills = [];

  for (const name of upstreamSkillNames) {
    if (excluded.has(name)) continue;
    const upstreamSkill = path.join(upstreamSkillsDir, name);
    const localSkill = path.join(localSkillsDir, name);

    if (adapted.has(name)) {
      const skillPrefix = `${cursorPath}/skills/${name}/`;
      const matching = changedFiles.filter((file) => file.startsWith(skillPrefix));
      if (matching.length > 0) {
        manualAdaptedSkills.push({ name, files: matching });
      }
      continue;
    }

    const existsLocally = fs.existsSync(localSkill);
    if (existsLocally && directoriesMatch(upstreamSkill, localSkill)) {
      continue;
    }

    const forbiddenMatches = scanForbiddenReferences(upstreamSkill);
    if (forbiddenMatches.length > 0) {
      blockedCursorSkills.push({ name, matches: forbiddenMatches });
      continue;
    }

    if (existsLocally) updatedSkills.push(name);
    else addedSkills.push(name);

    if (!options.dryRun) {
      replaceDirectory(upstreamSkill, localSkill);
    }
  }

  const removedUpstreamSkills = localSkillNames.filter(
    (name) => !adapted.has(name) && !upstreamSkillSet.has(name),
  );

  const skillsPrefix = `${cursorPath}/skills/`;
  const cursorPrefix = `${cursorPath}/`;
  const manualOtherFiles = changedFiles.filter((file) => {
    if (!file.startsWith(cursorPrefix)) return false;
    if (file.startsWith(skillsPrefix)) return false;
    const rel = file.slice(cursorPrefix.length);
    return !isPackagingPath(rel);
  });

  const hasAutoChanges = addedSkills.length > 0 || updatedSkills.length > 0;
  const hasManualCursorItems =
    manualAdaptedSkills.length > 0 ||
    blockedCursorSkills.length > 0 ||
    removedUpstreamSkills.length > 0 ||
    manualOtherFiles.length > 0;
  const hasManualItems = hasManualCursorItems || piMimirCommits.length > 0;

  const mode = hasAutoChanges ? "pr" : hasManualItems ? "issue" : "none";

  const summary = {
    mode,
    cursorSha: options.cursorSha,
    shortSha: options.cursorSha.slice(0, 7),
    cursorShaAdvanced: mode === "pr" && !hasManualCursorItems,
    addedSkills,
    updatedSkills,
    manualAdaptedSkills,
    blockedCursorSkills,
    removedUpstreamSkills,
    manualOtherFiles,
    piMimirCommits,
  };

  const report = buildReport(config, summary, cursorCommits);

  if (mode === "pr" && !options.dryRun) {
    let configChanged = false;
    if (!hasManualCursorItems) {
      config.cursor.lastSyncedSha = options.cursorSha;
      configChanged = true;
    }
    if (options.piMimirSha && piMimirCommits.length === 0 && config.piMimir) {
      config.piMimir.lastCheckedSha = options.piMimirSha;
      configChanged = true;
    }
    if (configChanged) {
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
      `Upstream sync (${summary.mode}): +${summary.addedSkills.length} added, ~${summary.updatedSkills.length} updated, ${summary.manualAdaptedSkills.length} adapted changed, ${summary.blockedCursorSkills.length} blocked.`,
    );
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    process.exitCode = 2;
  }
}
