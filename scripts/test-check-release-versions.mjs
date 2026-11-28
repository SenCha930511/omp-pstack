import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-release-versions.mjs", import.meta.url));
const TEMP_DIRS = [];

function createFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-version-check-"));
  TEMP_DIRS.push(dir);
  const files = {
    "package.json": `${JSON.stringify({ name: "omp-pstack", version: "0.2.0" }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify(
      {
        name: "omp-pstack",
        version: "0.2.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "omp-pstack", version: "0.2.0" },
        },
      },
      null,
      2,
    )}\n`,
    "CHANGELOG.md": [
      "# Changelog",
      "",
      "## 0.2.0 - 2026-11-26",
      "",
      "- Added release verification.",
      "",
      "## 0.1.0 - 2026-11-25",
      "",
      "- Initial release.",
      "",
    ].join("\n"),
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, relative), content);
  }
  return dir;
}

function runCheck(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts matching versions and extracts release notes", () => {
  const dir = createFixture();
  const notes = path.join(dir, "notes.md");

  const base = runCheck(["--root", dir]);
  assert.equal(base.status, 0, base.stderr);

  const rel = runCheck(["--root", dir, "--release", "--tag", "v0.2.0", "--notes-output", notes]);
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(fs.readFileSync(notes, "utf8"), "- Added release verification.\n");
});

test("accepts an Unreleased section before the version heading", () => {
  const dir = createFixture({
    "CHANGELOG.md": [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- Next work.",
      "",
      "## 0.2.0 - 2026-11-26",
      "",
      "- Added release verification.",
      "",
      "## 0.1.0 - 2026-11-25",
      "",
      "- Initial release.",
      "",
    ].join("\n"),
  });
  const notes = path.join(dir, "notes.md");
  assert.equal(runCheck(["--root", dir]).status, 0);
  const rel = runCheck(["--root", dir, "--release", "--tag", "v0.2.0", "--notes-output", notes]);
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(fs.readFileSync(notes, "utf8"), "- Added release verification.\n");
});

test("accepts em-dash changelog headings and ignores fenced blocks and HTML comments", () => {
  const dir = createFixture({
    "CHANGELOG.md": [
      "# Changelog",
      "<!-- ## 9.9.9 - 2026-01-01 -->",
      "",
      "```markdown",
      "## 8.8.8 - 2026-01-01",
      "```",
      "",
      "## 0.2.0 — 2026-11-26",
      "",
      "- Em dash entry.",
      "",
    ].join("\n"),
  });
  const rel = runCheck(["--root", dir, "--release", "--tag", "v0.2.0"]);
  assert.equal(rel.status, 0, rel.stderr);
});

test("rejects mismatched lockfile versions", () => {
  const dir = createFixture({
    "package-lock.json": `${JSON.stringify(
      {
        name: "omp-pstack",
        version: "0.1.0",
        lockfileVersion: 3,
        packages: { "": { name: "omp-pstack", version: "0.2.0" } },
      },
      null,
      2,
    )}\n`,
  });
  const result = runCheck(["--root", dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package-lock\.json version: 0\.1\.0 does not match/);
});

test("rejects invalid semver, tag mismatch, invalid dates, duplicate headings, and empty sections", () => {
  const prerelease = createFixture({
    "package.json": `${JSON.stringify({ name: "omp-pstack", version: "0.2.0-beta.1" }, null, 2)}\n`,
  });
  assert.equal(runCheck(["--root", prerelease]).status, 1);

  const mismatchTag = createFixture();
  assert.equal(runCheck(["--root", mismatchTag, "--release", "--tag", "v0.2.1"]).status, 1);

  const badDate = createFixture({
    "CHANGELOG.md": "# Changelog\n\n## 0.2.0 - 2026-02-30\n\n- Invalid date.\n",
  });
  const badDateResult = runCheck(["--root", badDate, "--release", "--tag", "v0.2.0"]);
  assert.equal(badDateResult.status, 1);
  assert.match(badDateResult.stderr, /valid YYYY-MM-DD date/);

  const duplicate = createFixture({
    "CHANGELOG.md": "# Changelog\n\n## 0.2.0 - 2026-11-26\n\n- First.\n\n## 0.2.0 - 2026-11-25\n\n- Second.\n",
  });
  const dupResult = runCheck(["--root", duplicate, "--release", "--tag", "v0.2.0"]);
  assert.equal(dupResult.status, 1);
  assert.match(dupResult.stderr, /duplicate heading/);

  const emptySection = createFixture({
    "CHANGELOG.md": "# Changelog\n\n## 0.2.0 - 2026-11-26\n\n## 0.1.0 - 2026-11-25\n\n- Init.\n",
  });
  const emptyResult = runCheck(["--root", emptySection, "--release", "--tag", "v0.2.0"]);
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /must not be empty/);
});
