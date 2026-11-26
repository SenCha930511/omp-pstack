import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const USAGE =
  "Usage: node scripts/upstream-range.mjs --repo-dir <dir> --base <sha> --head <sha> --path <path> --commits-output <file> --changed-output <file>";

const FLAGS = {
  "--repo-dir": "repoDir",
  "--base": "base",
  "--head": "head",
  "--path": "path",
  "--commits-output": "commitsOutput",
  "--changed-output": "changedOutput",
};

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
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

export function collectRange({ repoDir, base, head, path: rangePath }) {
  const commits = [];
  const log = git(repoDir, ["log", "--format=%H%x09%cI%x09%s", head, "--", rangePath]);
  for (const line of log.split(/\r?\n/)) {
    if (!line) continue;
    const commit = parseCommitLine(line);
    if (commit.sha === base) break;
    commits.push(commit);
  }

  const changedFiles = [];
  for (const commit of commits) {
    const diff = git(repoDir, ["diff", "--name-status", `${commit.sha}^`, commit.sha, "--", rangePath]);
    for (const line of diff.split(/\r?\n/)) {
      if (line && !changedFiles.includes(line)) changedFiles.push(line);
    }
  }

  return { commits, changedFiles };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = FLAGS[argv[index]];
    if (key === undefined) throw new Error(`unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} requires a value`);
    options[key] = value;
    index += 1;
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (options[key] === undefined) throw new Error(`missing ${flag}`);
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
