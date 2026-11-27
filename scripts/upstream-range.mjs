import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const USAGE =
  "Usage: node scripts/upstream-range.mjs --repo-dir <dir> --base <sha> --head <sha> --path <path> [--path <path> ...] --commits-output <file> --changed-output <file>";

const FLAGS = {
  "--repo-dir": "repoDir",
  "--base": "base",
  "--head": "head",
  "--path": "paths",
  "--commits-output": "commitsOutput",
  "--changed-output": "changedOutput",
};

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseCommitLine(line) {
  const firstTab = line.indexOf("\t");
  const secondTab = line.indexOf("\t", firstTab + 1);
  return {
    sha: line.slice(0, firstTab),
    date: line.slice(firstTab + 1, secondTab),
    subject: line.slice(secondTab + 1),
  };
}

export function collectRange({ repoDir, base, head, path: singlePath, paths }) {
  const rangePaths = Array.isArray(paths) && paths.length > 0 ? paths : singlePath ? [singlePath] : [];
  if (rangePaths.length === 0) {
    throw new Error("at least one path is required");
  }

  try {
    git(repoDir, ["cat-file", "-e", `${base}^{commit}`]);
  } catch {
    throw new Error(
      `base commit ${base} is not in the upstream clone; reset lastSyncedSha in .github/upstream-sync.json`,
    );
  }

  try {
    git(repoDir, ["merge-base", "--is-ancestor", base, head]);
  } catch {
    throw new Error(
      `base commit ${base} is not an ancestor of ${head}; reset lastSyncedSha in .github/upstream-sync.json`,
    );
  }

  const commits = [];
  const log = git(repoDir, ["log", "--format=%H%x09%cI%x09%s", `${base}..${head}`, "--", ...rangePaths]);
  for (const line of log.split(/\r?\n/)) {
    if (line) commits.push(parseCommitLine(line));
  }

  const changedFiles = git(repoDir, [
    "diff",
    "--name-status",
    `${base}..${head}`,
    "--",
    ...rangePaths,
  ])
    .split(/\r?\n/)
    .filter(Boolean);

  return { commits, changedFiles };
}

function parseArgs(argv) {
  const options = { paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = FLAGS[flag];
    if (key === undefined) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (key === "paths") options.paths.push(value);
    else options[key] = value;
    index += 1;
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (key === "paths") {
      if (options.paths.length === 0) throw new Error(`missing ${flag}`);
    } else if (options[key] === undefined) {
      throw new Error(`missing ${flag}`);
    }
  }
  return options;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { commits, changedFiles } = collectRange(options);
    fs.mkdirSync(path.dirname(options.commitsOutput), { recursive: true });
    fs.mkdirSync(path.dirname(options.changedOutput), { recursive: true });
    fs.writeFileSync(options.commitsOutput, `${JSON.stringify(commits, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      options.changedOutput,
      changedFiles.map((line) => `${line}\n`).join(""),
      "utf8",
    );
    console.log(`Collected ${commits.length} commit(s) and ${changedFiles.length} changed file(s).`);
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    process.exitCode = 2;
  }
}
