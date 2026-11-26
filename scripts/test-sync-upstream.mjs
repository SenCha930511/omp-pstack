import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { syncUpstream } from "./sync-upstream.mjs";

const TEMP_DIRS = [];

function createFixture({
  upstreamSkills = {},
  localSkills = {},
  adaptedSkills = ["poteto-mode", "swarm"],
  excludedSkills = ["make-bot-ui"],
  changedFiles = [],
  piMimirCommits = [],
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-sync-test-"));
  TEMP_DIRS.push(dir);

  const root = path.join(dir, "repo");
  const cursorDir = path.join(dir, "cursor-plugins");
  fs.mkdirSync(path.join(root, ".github"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "poteto-mode"), { recursive: true });
  fs.mkdirSync(path.join(cursorDir, "pstack", "skills"), { recursive: true });

  fs.writeFileSync(
    path.join(root, ".github", "upstream-sync.json"),
    `${JSON.stringify(
      {
        cursor: {
          repo: "cursor/plugins",
          branch: "main",
          path: "pstack",
          lastSyncedSha: "1111111111111111111111111111111111111111",
          excludedSkills,
          adaptedSkills,
        },
        piMimir: {
          repo: "casualjim/pi-mimir",
          branch: "main",
          watchPaths: ["packages/pi-pstack/extensions"],
          lastCheckedSha: "2222222222222222222222222222222222222222",
        },
      },
      null,
      2,
    )}\n`,
  );

  for (const [skillName, files] of Object.entries(localSkills)) {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(root, "skills", skillName, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  if (!localSkills["poteto-mode"]?.["SKILL.md"]) {
    fs.writeFileSync(path.join(root, "skills", "poteto-mode", "SKILL.md"), "---\nname: poteto-mode\ndescription: poteto\n---\n");
  }

  for (const [skillName, files] of Object.entries(upstreamSkills)) {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(cursorDir, "pstack", "skills", skillName, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }

  const changedPath = path.join(dir, "changed.txt");
  fs.writeFileSync(changedPath, changedFiles.join("\n"));
  const piCommitsPath = path.join(dir, "pi-commits.json");
  fs.writeFileSync(piCommitsPath, JSON.stringify(piMimirCommits));

  return { root, cursorDir, changedPath, piCommitsPath, dir };
}

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adds new clean skills, updates unadapted skills, and advances SHA", () => {
  const { root, cursorDir, changedPath, piCommitsPath, dir } = createFixture({
    localSkills: {
      tdd: { "SKILL.md": "old tdd\n" },
      swarm: { "SKILL.md": "omp swarm\n" },
    },
    upstreamSkills: {
      "make-bot-ui": { "SKILL.md": "cursor-only\n" },
      reframe: { "SKILL.md": "---\nname: reframe\ndescription: reframe\n---\nNew skill\n" },
      swarm: { "SKILL.md": "upstream swarm with ~/.cursor/ and subagent_type\n" },
      tdd: { "SKILL.md": "updated tdd\n" },
    },
    changedFiles: [
      "M\tpstack/skills/swarm/SKILL.md",
      "M\tpstack/skills/tdd/SKILL.md",
      "A\tpstack/skills/reframe/SKILL.md",
    ],
  });

  const reportOut = path.join(dir, "report.md");
  const summaryOut = path.join(dir, "summary.json");
  const targetSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: targetSha,
    cursorChangedFile: changedPath,
    piMimirCommitsFile: piCommitsPath,
    reportOutput: reportOut,
    summaryJson: summaryOut,
    dryRun: false,
  });

  assert.equal(summary.mode, "pr");
  assert.deepEqual(summary.addedSkills, ["reframe"]);
  assert.deepEqual(summary.updatedSkills, ["tdd"]);
  assert.deepEqual(summary.manualAdaptedSkills, [{ name: "swarm", files: ["pstack/skills/swarm/SKILL.md"] }]);
  assert.equal(fs.existsSync(path.join(root, "skills", "make-bot-ui")), false);
  assert.equal(fs.readFileSync(path.join(root, "skills", "swarm", "SKILL.md"), "utf8"), "omp swarm\n");
  assert.equal(fs.readFileSync(path.join(root, "skills", "tdd", "SKILL.md"), "utf8"), "updated tdd\n");

  const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
  assert.equal(updatedConfig.cursor.lastSyncedSha, targetSha);
  assert.ok(fs.existsSync(reportOut));
  assert.ok(fs.existsSync(summaryOut));
});

test("blocks new or updated skills containing Cursor references without writing them", () => {
  const { root, cursorDir, changedPath } = createFixture({
    localSkills: {
      tdd: { "SKILL.md": "clean local tdd\n" },
    },
    upstreamSkills: {
      tdd: { "SKILL.md": "uses ~/.cursor/rules\n" },
      "bad-new": { "SKILL.md": "uses subagent_type: generalPurpose\n" },
    },
    changedFiles: ["M\tpstack/skills/tdd/SKILL.md", "A\tpstack/skills/bad-new/SKILL.md"],
  });

  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    cursorChangedFile: changedPath,
  });

  assert.equal(summary.mode, "issue");
  assert.deepEqual(summary.addedSkills, []);
  assert.deepEqual(summary.updatedSkills, []);
  assert.equal(summary.blockedCursorSkills.length, 2);
  assert.equal(fs.readFileSync(path.join(root, "skills", "tdd", "SKILL.md"), "utf8"), "clean local tdd\n");
  assert.equal(fs.existsSync(path.join(root, "skills", "bad-new")), false);
});

test("returns issue mode for pi-mimir or adapted-only updates and none when up to date", () => {
  const manualOnly = createFixture({
    localSkills: { tdd: { "SKILL.md": "same\n" } },
    upstreamSkills: {
      tdd: { "SKILL.md": "same\n" },
      "make-bot-ui": { "SKILL.md": "changed excluded\n" },
    },
    changedFiles: ["M\tpstack/skills/make-bot-ui/SKILL.md"],
    piMimirCommits: [{ sha: "cccccccccccccccccccccccccccccccccccccccc", date: "2026-11-25T00:00:00Z", subject: "fix(pi-pstack): ask" }],
  });

  const issueRes = syncUpstream({
    root: manualOnly.root,
    cursorDir: manualOnly.cursorDir,
    cursorSha: "dddddddddddddddddddddddddddddddddddddddd",
    cursorChangedFile: manualOnly.changedPath,
    piMimirCommitsFile: manualOnly.piCommitsPath,
    reportOutput: path.join(manualOnly.dir, "issue-report.md"),
  });
  assert.equal(issueRes.summary.mode, "issue");

  const issueReport = fs.readFileSync(path.join(manualOnly.dir, "issue-report.md"), "utf8");
  assert.ok(issueReport.includes("### After porting"));
  assert.ok(
    issueReport.includes(
      "npm run sync:ack -- --cursor dddddddddddddddddddddddddddddddddddddddd --pi-mimir cccccccccccccccccccccccccccccccccccccccc",
    ),
  );

  const noop = createFixture({
    localSkills: { tdd: { "SKILL.md": "same\n" } },
    upstreamSkills: {
      tdd: { "SKILL.md": "same\n" },
      "make-bot-ui": { "SKILL.md": "ignored\n" },
    },
    changedFiles: ["M\tpstack/skills/make-bot-ui/SKILL.md"],
  });
  const noopRes = syncUpstream({
    root: noop.root,
    cursorDir: noop.cursorDir,
    cursorSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    cursorChangedFile: noop.changedPath,
  });
  assert.equal(noopRes.summary.mode, "none");
});

test("dry-run computes PR summary without modifying repository files", () => {
  const { root, cursorDir, changedPath } = createFixture({
    localSkills: { tdd: { "SKILL.md": "old\n" } },
    upstreamSkills: {
      tdd: { "SKILL.md": "new\n" },
      reframe: { "SKILL.md": "new skill\n" },
    },
    changedFiles: ["M\tpstack/skills/tdd/SKILL.md", "A\tpstack/skills/reframe/SKILL.md"],
  });

  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: "ffffffffffffffffffffffffffffffffffffffff",
    cursorChangedFile: changedPath,
    dryRun: true,
  });

  assert.equal(summary.mode, "pr");
  assert.deepEqual(summary.addedSkills, ["reframe"]);
  assert.deepEqual(summary.updatedSkills, ["tdd"]);
  assert.equal(fs.readFileSync(path.join(root, "skills", "tdd", "SKILL.md"), "utf8"), "old\n");
  assert.equal(fs.existsSync(path.join(root, "skills", "reframe")), false);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
  assert.equal(cfg.cursor.lastSyncedSha, "1111111111111111111111111111111111111111");
});
