import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ackUpstream } from "./sync-ack.mjs";
import { gitBlobSha } from "./upstream-manifest.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./sync-ack.mjs", import.meta.url));
const TEMP_DIRS = [];

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture({ localFiles = {}, adaptedSkills = [] } = {}) {
  const upstreamDir = makeTemp("omp-pstack-ack-upstream-");
  git(upstreamDir, ["init", "-b", "main"]);
  git(upstreamDir, ["config", "user.name", "Test"]);
  git(upstreamDir, ["config", "user.email", "test@example.com"]);
  fs.mkdirSync(path.join(upstreamDir, "pstack/skills/how"), { recursive: true });
  fs.writeFileSync(path.join(upstreamDir, "pstack/skills/how/SKILL.md"), "upstream how\n");
  git(upstreamDir, ["add", "-A"]);
  git(upstreamDir, ["commit", "-m", "base"]);
  const sha = git(upstreamDir, ["rev-parse", "HEAD"]);
  const tree = git(upstreamDir, ["rev-parse", "HEAD:pstack/skills"]);

  const root = makeTemp("omp-pstack-ack-root-");
  fs.mkdirSync(path.join(root, ".github"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "skills.test.mjs"), "// fixture\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ scripts: { check: "node --test tests/skills.test.mjs" } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, ".github", "upstream-sync.json"),
    `${JSON.stringify(
      {
        cursor: {
          repo: "cursor/plugins",
          branch: "main",
          path: "pstack",
          lastSyncedSha: sha,
          excludedSkills: [],
          adaptedSkills,
        },
      },
      null,
      2,
    )}\n`,
  );
  const files = { "skills/how/SKILL.md": "adapted how\n", ...localFiles };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(
    path.join(root, "upstream.json"),
    `${JSON.stringify(
      {
        schema: "omp-pstack.upstream/1",
        source: {
          repository: "https://github.com/cursor/plugins",
          path: "pstack/skills",
          commit: sha,
          tree,
        },
        entries: [
          {
            source: "pstack/skills/how/SKILL.md",
            target: "skills/how/SKILL.md",
            blob: gitBlobSha(Buffer.from("upstream how\n")),
            mode: "100644",
            rule: "local",
            reason: "Fixture adaptation.",
            tests: ["tests/skills.test.mjs"],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { upstreamDir, root, sha, tree };
}

function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
}

test("ack requires a cursor dir and a valid skill name", () => {
  const fixture = makeFixture();
  assert.throws(() => ackUpstream({ root: fixture.root, adapt: ["how"] }), /--cursor-dir is required/);
  assert.throws(
    () => ackUpstream({ root: fixture.root, cursorDir: fixture.upstreamDir, adapt: ["../evil"] }),
    /invalid skill name/,
  );
});

test("adapt-only rejects a cursor and requires an adapt skill", () => {
  const fixture = makeFixture();
  assert.throws(
    () =>
      ackUpstream({
        root: fixture.root,
        cursorDir: fixture.upstreamDir,
        adapt: ["how"],
        adaptOnly: true,
        cursor: fixture.sha,
      }),
    /cannot be combined/,
  );
  assert.throws(
    () => ackUpstream({ root: fixture.root, cursorDir: fixture.upstreamDir, adaptOnly: true }),
    /requires at least one --adapt/,
  );
});

test("ack reclassifies an adapted skill and advances both pins", () => {
  const fixture = makeFixture();
  ackUpstream({
    root: fixture.root,
    cursorDir: fixture.upstreamDir,
    adapt: ["how"],
    reason: "Ported for omp.",
  });
  const config = readConfig(fixture.root);
  assert.equal(config.cursor.lastSyncedSha, fixture.sha);
  assert.deepEqual(config.cursor.adaptedSkills, ["how"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.root, "upstream.json"), "utf8"));
  assert.equal(manifest.source.commit, fixture.sha);
  assert.equal(manifest.entries[0].rule, "local");
  assert.equal(manifest.entries[0].reason, "Ported for omp.");
});

test("a new localized file needs a reason", () => {
  const fixture = makeFixture();
  fs.mkdirSync(path.join(fixture.upstreamDir, "pstack/skills/new-skill"), { recursive: true });
  fs.writeFileSync(path.join(fixture.upstreamDir, "pstack/skills/new-skill/SKILL.md"), "upstream new\n");
  git(fixture.upstreamDir, ["add", "-A"]);
  git(fixture.upstreamDir, ["commit", "-m", "head"]);
  fs.mkdirSync(path.join(fixture.root, "skills/new-skill"), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, "skills/new-skill/SKILL.md"), "ported new\n");
  assert.throws(
    () =>
      ackUpstream({
        root: fixture.root,
        cursorDir: fixture.upstreamDir,
        adapt: ["new-skill"],
      }),
    /needs --reason/,
  );
});

test("the CLI writes the adapted skill list", () => {
  const fixture = makeFixture();
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "--root",
      fixture.root,
      "--cursor-dir",
      fixture.upstreamDir,
      "--adapt-only",
      "--adapt",
      "how",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readConfig(fixture.root).cursor.adaptedSkills, ["how"]);
});
