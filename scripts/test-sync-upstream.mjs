import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ackUpstream } from "./sync-ack.mjs";
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

test("clean PR advances lastSyncedSha without manual items", () => {
  const { root, cursorDir, changedPath, piCommitsPath } = createFixture({
    localSkills: {
      tdd: { "SKILL.md": "old tdd\n" },
    },
    upstreamSkills: {
      "make-bot-ui": { "SKILL.md": "cursor-only\n" },
      reframe: { "SKILL.md": "---\nname: reframe\ndescription: reframe\n---\nNew skill\n" },
      tdd: { "SKILL.md": "updated tdd\n" },
    },
    changedFiles: [
      "M\tpstack/skills/tdd/SKILL.md",
      "A\tpstack/skills/reframe/SKILL.md",
    ],
  });

  const targetSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: targetSha,
    cursorChangedFile: changedPath,
    piMimirCommitsFile: piCommitsPath,
    dryRun: false,
  });

  assert.equal(summary.mode, "pr");
  assert.equal(summary.cursorShaAdvanced, true);
  assert.deepEqual(summary.addedSkills, ["reframe"]);
  assert.deepEqual(summary.updatedSkills, ["tdd"]);
  assert.equal(fs.existsSync(path.join(root, "skills", "make-bot-ui")), false);
  assert.equal(fs.readFileSync(path.join(root, "skills", "tdd", "SKILL.md"), "utf8"), "updated tdd\n");

  const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
  assert.equal(updatedConfig.cursor.lastSyncedSha, targetSha);
});

test("mixed PR syncs clean skills while holding cursor.lastSyncedSha for manual items", () => {
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
  const { summary, report } = syncUpstream({
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
  assert.equal(summary.cursorShaAdvanced, false);
  assert.deepEqual(summary.addedSkills, ["reframe"]);
  assert.deepEqual(summary.updatedSkills, ["tdd"]);
  assert.deepEqual(summary.manualAdaptedSkills, [{ name: "swarm", files: ["pstack/skills/swarm/SKILL.md"] }]);
  assert.equal(fs.readFileSync(path.join(root, "skills", "swarm", "SKILL.md"), "utf8"), "omp swarm\n");
  assert.equal(fs.readFileSync(path.join(root, "skills", "tdd", "SKILL.md"), "utf8"), "updated tdd\n");
  assert.ok(report.includes("### After porting"));
  assert.ok(report.includes(`npm run sync:ack -- --cursor ${targetSha}`));

  const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
  assert.equal(updatedConfig.cursor.lastSyncedSha, "1111111111111111111111111111111111111111");
  assert.ok(fs.existsSync(reportOut));
  assert.ok(fs.existsSync(summaryOut));

  const followUp = syncUpstream({
    root,
    cursorDir,
    cursorSha: targetSha,
    cursorChangedFile: changedPath,
    piMimirCommitsFile: piCommitsPath,
    dryRun: false,
  });
  assert.equal(followUp.summary.mode, "issue");
  assert.deepEqual(followUp.summary.manualAdaptedSkills, [{ name: "swarm", files: ["pstack/skills/swarm/SKILL.md"] }]);
});

test("blocks new or updated skills containing Cursor references without writing them", () => {
  const { root, cursorDir, changedPath } = createFixture({
    localSkills: {
      tdd: { "SKILL.md": "clean local tdd\n" },
    },
    upstreamSkills: {
      tdd: { "SKILL.md": "uses ~/.cursor/rules\n" },
      "bad-new": { "SKILL.md": "uses subagent_type: generalPurpose\n" },
      "bad-ask": { "SKILL.md": "call AskQuestion and read plugins/cache/foo\n" },
      "bad-bg": { "SKILL.md": "check agent-transcripts/ or cursor-team-kit or /visualize\n" },
    },
    changedFiles: [
      "M\tpstack/skills/tdd/SKILL.md",
      "A\tpstack/skills/bad-new/SKILL.md",
      "A\tpstack/skills/bad-ask/SKILL.md",
      "A\tpstack/skills/bad-bg/SKILL.md",
    ],
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
  assert.equal(summary.blockedCursorSkills.length, 4);
  assert.equal(fs.readFileSync(path.join(root, "skills", "tdd", "SKILL.md"), "utf8"), "clean local tdd\n");
  assert.equal(fs.existsSync(path.join(root, "skills", "bad-new")), false);
  assert.equal(fs.existsSync(path.join(root, "skills", "bad-ask")), false);
  assert.equal(fs.existsSync(path.join(root, "skills", "bad-bg")), false);
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
  assert.equal(summary.cursorShaAdvanced, false);
  assert.deepEqual(summary.addedSkills, ["reframe"]);
  assert.deepEqual(summary.updatedSkills, ["tdd"]);
  assert.equal(fs.readFileSync(path.join(root, "skills", "tdd", "SKILL.md"), "utf8"), "old\n");
  assert.equal(fs.existsSync(path.join(root, "skills", "reframe")), false);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
  assert.equal(cfg.cursor.lastSyncedSha, "1111111111111111111111111111111111111111");
});

test("blocks forbidden references inside non-Markdown scripts and JSON files", () => {
  const { root, cursorDir, changedPath } = createFixture({
    upstreamSkills: {
      "bad-ts": {
        "SKILL.md": "clean docs\n",
        "scripts/run.ts": "export const tool = 'AskQuestion';\n",
      },
      "bad-sh": {
        "SKILL.md": "clean docs\n",
        "scripts/helper": "#!/usr/bin/env bash\nread ~/.cursor/rules\n",
      },
      "bad-json": {
        "SKILL.md": "clean docs\n",
        "assets/config.json": '{"agent":"generalPurpose"}\n',
      },
    },
    changedFiles: [
      "A\tpstack/skills/bad-ts/SKILL.md",
      "A\tpstack/skills/bad-sh/SKILL.md",
      "A\tpstack/skills/bad-json/SKILL.md",
    ],
  });

  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: "9999999999999999999999999999999999999999",
    cursorChangedFile: changedPath,
  });

  assert.equal(summary.mode, "issue");
  assert.equal(summary.blockedCursorSkills.length, 3);
  assert.deepEqual(summary.addedSkills, []);
});

test("accurately reports deleted adapted skills and ignores local omp-only or unchanged blocked skills", () => {
  const { root, cursorDir, changedPath } = createFixture({
    localSkills: {
      "omp-only": { "SKILL.md": "local only\n" },
      swarm: { "SKILL.md": "adapted swarm\n" },
      "already-ported": { "SKILL.md": "omp port\n" },
    },
    upstreamSkills: {
      "already-ported": { "SKILL.md": "upstream with ~/.cursor/rules\n" },
    },
    changedFiles: ["D\tpstack/skills/swarm/SKILL.md"],
  });

  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: "8888888888888888888888888888888888888888",
    cursorChangedFile: changedPath,
  });

  assert.equal(summary.mode, "issue");
  assert.deepEqual(summary.removedUpstreamSkills, ["swarm"]);
  assert.deepEqual(summary.blockedCursorSkills, []);
});

test("preserves executable bit changes when syncing scripts on POSIX", { skip: process.platform === "win32" }, () => {
  const { root, cursorDir, changedPath } = createFixture({
    localSkills: {
      statechart: {
        "SKILL.md": "statechart\n",
        "scripts/statechart": "#!/bin/sh\necho hi\n",
      },
    },
    upstreamSkills: {
      statechart: {
        "SKILL.md": "statechart\n",
        "scripts/statechart": "#!/bin/sh\necho hi\n",
      },
    },
    changedFiles: ["M\tpstack/skills/statechart/scripts/statechart"],
  });

  fs.chmodSync(path.join(root, "skills", "statechart", "scripts", "statechart"), 0o644);
  fs.chmodSync(path.join(cursorDir, "pstack", "skills", "statechart", "scripts", "statechart"), 0o755);

  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: "7777777777777777777777777777777777777777",
    cursorChangedFile: changedPath,
    dryRun: false,
  });

  assert.equal(summary.mode, "pr");
  assert.deepEqual(summary.updatedSkills, ["statechart"]);
  assert.notEqual(
    fs.statSync(path.join(root, "skills", "statechart", "scripts", "statechart")).mode & 0o111,
    0,
  );
});

test("continuing an open chore/upstream-sync PR branch preserves maintainer commits across fresh checkouts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-pr-resume-"));
  TEMP_DIRS.push(dir);
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const configure = (cwd) => {
    git(["config", "core.autocrlf", "false"], cwd);
    git(["config", "commit.gpgsign", "false"], cwd);
    git(["config", "user.name", "Sync Test"], cwd);
    git(["config", "user.email", "sync-test@example.com"], cwd);
  };

  const bareRemote = path.join(dir, "remote.git");
  fs.mkdirSync(bareRemote, { recursive: true });
  git(["init", "--bare", "-b", "main"], bareRemote);

  const seed = path.join(dir, "seed");
  git(["clone", "-c", "core.autocrlf=false", bareRemote, seed], dir);
  configure(seed);
  fs.mkdirSync(path.join(seed, ".github"), { recursive: true });
  fs.mkdirSync(path.join(seed, "skills", "swarm"), { recursive: true });
  fs.mkdirSync(path.join(seed, "skills", "poteto-mode"), { recursive: true });
  fs.writeFileSync(path.join(seed, "skills", "poteto-mode", "SKILL.md"), "---\nname: poteto-mode\ndescription: poteto\n---\n");
  fs.writeFileSync(path.join(seed, "skills", "swarm", "SKILL.md"), "omp swarm v1\n");
  fs.writeFileSync(
    path.join(seed, ".github", "upstream-sync.json"),
    `${JSON.stringify(
      {
        cursor: {
          repo: "cursor/plugins",
          branch: "main",
          path: "pstack",
          lastSyncedSha: "1".repeat(40),
          excludedSkills: ["make-bot-ui"],
          adaptedSkills: ["poteto-mode", "swarm"],
        },
      },
      null,
      2,
    )}\n`,
  );
  git(["add", "-A"], seed);
  git(["commit", "-m", "init"], seed);
  git(["push", "origin", "main"], seed);

  const cursorDir = path.join(dir, "cursor-plugins");
  fs.mkdirSync(path.join(cursorDir, "pstack", "skills", "reframe"), { recursive: true });
  fs.mkdirSync(path.join(cursorDir, "pstack", "skills", "swarm"), { recursive: true });
  fs.writeFileSync(path.join(cursorDir, "pstack", "skills", "reframe", "SKILL.md"), "---\nname: reframe\ndescription: r\n---\n");
  fs.writeFileSync(path.join(cursorDir, "pstack", "skills", "swarm", "SKILL.md"), "upstream swarm v2\n");
  const changed1 = path.join(dir, "changed1.txt");
  fs.writeFileSync(changed1, "A\tpstack/skills/reframe/SKILL.md\nM\tpstack/skills/swarm/SKILL.md\n");
  const sha1 = "a".repeat(40);

  // Run 1: bot opens mixed PR from main
  const botRun1 = path.join(dir, "bot-run1");
  git(["clone", "-c", "core.autocrlf=false", "--branch", "main", bareRemote, botRun1], dir);
  configure(botRun1);
  git(["checkout", "-B", "chore/upstream-sync"], botRun1);
  const res1 = syncUpstream({ root: botRun1, cursorDir, cursorSha: sha1, cursorChangedFile: changed1 });
  assert.equal(res1.summary.mode, "pr");
  assert.equal(res1.summary.cursorShaAdvanced, false);
  git(["add", "-A"], botRun1);
  git(["commit", "-m", "chore(sync): sync upstream pstack"], botRun1);
  git(["push", "--force-with-lease", "origin", "HEAD:refs/heads/chore/upstream-sync"], botRun1);

  // Maintainer checks out PR branch, manually ports swarm, and runs sync:ack
  const maintainer = path.join(dir, "maintainer");
  git(["clone", "-c", "core.autocrlf=false", "--branch", "chore/upstream-sync", bareRemote, maintainer], dir);
  configure(maintainer);
  fs.writeFileSync(path.join(maintainer, "skills", "swarm", "SKILL.md"), "omp swarm v2 ported\n");
  ackUpstream({ root: maintainer, cursor: sha1 });
  git(["add", "-A"], maintainer);
  git(["commit", "-m", "chore(sync): port swarm and ack"], maintainer);
  git(["push", "origin", "chore/upstream-sync"], maintainer);

  // Run 2: fresh checkout resumes open chore/upstream-sync PR branch when a new clean skill arrives
  fs.mkdirSync(path.join(cursorDir, "pstack", "skills", "fresh"), { recursive: true });
  fs.writeFileSync(path.join(cursorDir, "pstack", "skills", "fresh", "SKILL.md"), "---\nname: fresh\ndescription: f\n---\n");
  const changed2 = path.join(dir, "changed2.txt");
  fs.writeFileSync(changed2, "A\tpstack/skills/fresh/SKILL.md\n");
  const sha2 = "b".repeat(40);

  const botRun2 = path.join(dir, "bot-run2");
  git(["clone", "-c", "core.autocrlf=false", "--branch", "main", bareRemote, botRun2], dir);
  configure(botRun2);
  const remotePrSha = git(["ls-remote", "--heads", "origin", "refs/heads/chore/upstream-sync"], botRun2).split(/\s+/)[0];
  git(["fetch", "--depth=1", "origin", "refs/heads/chore/upstream-sync"], botRun2);
  git(["checkout", "-B", "chore/upstream-sync", "FETCH_HEAD"], botRun2);
  const res2 = syncUpstream({ root: botRun2, cursorDir, cursorSha: sha2, cursorChangedFile: changed2 });
  assert.equal(res2.summary.mode, "pr");
  assert.equal(res2.summary.cursorShaAdvanced, true);
  git(["add", "-A"], botRun2);
  git(["commit", "-m", "chore(sync): sync fresh"], botRun2);
  git(["push", `--force-with-lease=refs/heads/chore/upstream-sync:${remotePrSha}`, "origin", "HEAD:refs/heads/chore/upstream-sync"], botRun2);

  // Verify maintainer's manual swarm port survived!
  const verify = path.join(dir, "verify");
  git(["clone", "-c", "core.autocrlf=false", "--branch", "chore/upstream-sync", bareRemote, verify], dir);
  assert.equal(fs.readFileSync(path.join(verify, "skills", "swarm", "SKILL.md"), "utf8"), "omp swarm v2 ported\n");
  assert.ok(fs.existsSync(path.join(verify, "skills", "reframe", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(verify, "skills", "fresh", "SKILL.md")));
  const finalCfg = JSON.parse(fs.readFileSync(path.join(verify, ".github", "upstream-sync.json"), "utf8"));
  assert.equal(finalCfg.cursor.lastSyncedSha, sha2);
});

test("multiple blocked skills stay tracked after partial --adapt-only and missing adapted skills are flagged", () => {
  const { root, cursorDir, changedPath } = createFixture({
    localSkills: {
      swarm: { "SKILL.md": "local swarm\n" },
    },
    upstreamSkills: {
      "blocked-a": { "SKILL.md": "uses ~/.cursor/rules\n" },
      "blocked-b": { "SKILL.md": "uses subagent_type\n" },
      swarm: { "SKILL.md": "upstream swarm\n" },
    },
    changedFiles: [
      "A\tpstack/skills/blocked-a/SKILL.md",
      "A\tpstack/skills/blocked-b/SKILL.md",
    ],
  });

  const sha = "a".repeat(40);
  const first = syncUpstream({
    root,
    cursorDir,
    cursorSha: sha,
    cursorChangedFile: changedPath,
  });
  assert.equal(first.summary.mode, "issue");
  assert.deepEqual(
    first.summary.blockedCursorSkills.map((item) => item.name),
    ["blocked-a", "blocked-b"],
  );
  assert.ok(first.report.includes("--adapt-only --adapt <skill>"));
  assert.ok(first.report.includes(`npm run sync:ack -- --cursor ${sha} --adapt blocked-a --adapt blocked-b`));

  // Port blocked-a locally and record it with --adapt-only; blocked-b is still unported.
  fs.mkdirSync(path.join(root, "skills", "blocked-a"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "blocked-a", "SKILL.md"), "---\nname: blocked-a\ndescription: a\n---\n");
  ackUpstream({ root, adapt: ["blocked-a"], adaptOnly: true });

  const second = syncUpstream({
    root,
    cursorDir,
    cursorSha: sha,
    cursorChangedFile: changedPath,
  });
  assert.equal(second.summary.mode, "issue");
  assert.deepEqual(
    second.summary.blockedCursorSkills.map((item) => item.name),
    ["blocked-b"],
  );
  assert.deepEqual(second.summary.manualAdaptedSkills, [
    { name: "blocked-a", files: ["pstack/skills/blocked-a/SKILL.md"] },
  ]);

  // If a skill in adaptedSkills is missing locally, do not silently skip it.
  fs.rmSync(path.join(root, "skills", "swarm"), { recursive: true, force: true });
  const missingAdapted = syncUpstream({
    root,
    cursorDir,
    cursorSha: sha,
  });
  assert.ok(
    missingAdapted.summary.manualAdaptedSkills.some(
      (item) => item.name === "swarm" && item.files.some((f) => f.includes("missing locally")),
    ),
  );
});

test("scans all non-binary text files regardless of extension while skipping binary assets", () => {
  const { root, cursorDir, changedPath } = createFixture({
    upstreamSkills: {
      "bad-tla": {
        "SKILL.md": "clean docs\n",
        "specs/Model.tla": "\\* mentions ~/.cursor/rules\n",
      },
      "clean-with-png": {
        "SKILL.md": "clean docs\n",
        "assets/diagram.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
      },
    },
    changedFiles: [
      "A\tpstack/skills/bad-tla/SKILL.md",
      "A\tpstack/skills/clean-with-png/SKILL.md",
    ],
  });

  const { summary } = syncUpstream({
    root,
    cursorDir,
    cursorSha: "c".repeat(40),
    cursorChangedFile: changedPath,
  });

  assert.equal(summary.mode, "pr");
  assert.deepEqual(summary.addedSkills, ["clean-with-png"]);
  assert.deepEqual(summary.blockedCursorSkills, [
    { name: "bad-tla", matches: [{ file: "specs/Model.tla", pattern: "~/.cursor/" }] },
  ]);
});

test("surfaces --pi-mimir-error-file without failing sync or advancing piMimir.lastCheckedSha", () => {
  const { root, cursorDir, changedPath, piCommitsPath, dir } = createFixture({
    localSkills: { tdd: { "SKILL.md": "old\n" } },
    upstreamSkills: { tdd: { "SKILL.md": "new\n" } },
    changedFiles: ["M\tpstack/skills/tdd/SKILL.md"],
  });
  const piErrorPath = path.join(dir, "pi-error.txt");
  fs.writeFileSync(piErrorPath, "base commit 2222222 is not an ancestor; reset piMimir.lastCheckedSha\n");
  const piHeadSha = "d".repeat(40);
  const cursorHeadSha = "e".repeat(40);

  const { summary, report } = syncUpstream({
    root,
    cursorDir,
    cursorSha: cursorHeadSha,
    cursorChangedFile: changedPath,
    piMimirSha: piHeadSha,
    piMimirCommitsFile: piCommitsPath,
    piMimirErrorFile: piErrorPath,
  });

  assert.equal(summary.mode, "pr");
  assert.equal(summary.cursorShaAdvanced, true);
  assert.match(summary.piMimirError ?? "", /piMimir\.lastCheckedSha/);
  assert.ok(report.includes("range check failed"));
  assert.ok(report.includes(`--cursor ${cursorHeadSha} --pi-mimir ${piHeadSha}`));

  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
  assert.equal(cfg.cursor.lastSyncedSha, cursorHeadSha);
  assert.equal(cfg.piMimir.lastCheckedSha, "2222222222222222222222222222222222222222");
});
