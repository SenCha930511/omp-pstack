import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectRange } from "./upstream-range.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./upstream-range.mjs", import.meta.url));
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
}

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-range-test-"));
  TEMP_DIRS.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "user.name", "Upstream Range Test"]);
  git(dir, ["config", "user.email", "upstream-range@example.com"]);

  fs.mkdirSync(path.join(dir, "pstack", "skills", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(dir, "other"), { recursive: true });
  const skillFile = path.join(dir, "pstack", "skills", "alpha", "SKILL.md");

  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  fs.writeFileSync(skillFile, "alpha\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "A touches alpha"]);
  fs.writeFileSync(path.join(dir, "other", "notes.md"), "notes\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "B touches only other"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  fs.writeFileSync(skillFile, "alpha v2\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "C touches alpha"]);
  const head = git(dir, ["rev-parse", "HEAD"]);

  return { dir, base, head };
}

test("collectRange starts at the recorded base instead of walking the path-filtered log", () => {
  const { dir, base, head } = createFixture();

  const range = collectRange({ repoDir: dir, base, head, path: "pstack" });

  assert.deepEqual(
    range.commits.map((commit) => commit.sha),
    [head],
  );
  assert.equal(range.commits[0].subject, "C touches alpha");
  assert.match(range.commits[0].date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(range.changedFiles, ["M\tpstack/skills/alpha/SKILL.md"]);
});

test("CLI writes the commits JSON and changed-files TSV", () => {
  const { dir, base, head } = createFixture();
  const commitsOutput = path.join(dir, "out", "commits.json");
  const changedOutput = path.join(dir, "out", "changed.txt");

  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "--repo-dir",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--path",
      "pstack",
      "--commits-output",
      commitsOutput,
      "--changed-output",
      changedOutput,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  const commitsJson = fs.readFileSync(commitsOutput, "utf8");
  assert.ok(commitsJson.endsWith("\n"));
  assert.deepEqual(
    JSON.parse(commitsJson).map((commit) => commit.sha),
    [head],
  );
  assert.equal(fs.readFileSync(changedOutput, "utf8"), "M\tpstack/skills/alpha/SKILL.md\n");
});

test("collectRange and CLI support multiple --path filters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-range-multi-"));
  TEMP_DIRS.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "user.name", "Upstream Range Test"]);
  git(dir, ["config", "user.email", "upstream-range@example.com"]);

  fs.mkdirSync(path.join(dir, "packages", "a"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "b"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "c"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages", "a", "x.ts"), "1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  const base = git(dir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(dir, "packages", "c", "ignored.ts"), "x\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "unrelated"]);

  fs.writeFileSync(path.join(dir, "packages", "b", "y.ts"), "2\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "touch b"]);
  const commitB = git(dir, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(dir, "packages", "a", "x.ts"), "3\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "touch a"]);
  const head = git(dir, ["rev-parse", "HEAD"]);

  const range = collectRange({ repoDir: dir, base, head, paths: ["packages/a", "packages/b"] });
  assert.deepEqual(
    range.commits.map((commit) => commit.sha),
    [head, commitB],
  );
  assert.deepEqual(range.changedFiles, ["M\tpackages/a/x.ts", "A\tpackages/b/y.ts"]);

  const commitsOutput = path.join(dir, "out", "multi-commits.json");
  const changedOutput = path.join(dir, "out", "multi-changed.txt");
  const cli = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "--repo-dir",
      dir,
      "--base",
      base,
      "--head",
      head,
      "--path",
      "packages/a",
      "--path",
      "packages/b",
      "--commits-output",
      commitsOutput,
      "--changed-output",
      changedOutput,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(commitsOutput, "utf8")).map((commit) => commit.sha),
    [head, commitB],
  );
});
