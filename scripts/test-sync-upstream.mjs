import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkUpstream } from "./check-upstream.mjs";
import { ackUpstream } from "./sync-ack.mjs";
import { syncUpstream } from "./sync-upstream.mjs";
import { gitBlobSha } from "./upstream-manifest.mjs";

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

function writeTree(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (relative.endsWith(".sh")) fs.chmodSync(target, 0o755);
  }
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return {
    sha: git(dir, ["rev-parse", "HEAD"]),
    tree: git(dir, ["rev-parse", "HEAD:pstack/skills"]),
  };
}

function makeUpstream(files) {
  const dir = makeTemp("omp-pstack-sync-upstream-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  writeTree(dir, files);
  const head = commitAll(dir, "upstream base");
  return { dir, ...head };
}

function advance(upstream, { write = {}, remove = [] } = {}) {
  writeTree(upstream.dir, write);
  for (const relative of remove) fs.rmSync(path.join(upstream.dir, relative), { force: true });
  return commitAll(upstream.dir, "upstream head");
}

function readTree(upstream, sha) {
  const output = git(upstream.dir, ["ls-tree", "-r", sha, "--", "pstack/skills"]);
  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (match) entries.push({ mode: match[1], blob: match[2], source: match[3] });
  }
  return entries;
}

function createRoot({
  upstream,
  baseSha = upstream.sha,
  baseTree = upstream.tree,
  localFiles = {},
  adaptedSkills = [],
  excludedSkills = [],
  configPin = baseSha,
}) {
  const root = makeTemp("omp-pstack-sync-root-");
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
          lastSyncedSha: configPin,
          excludedSkills,
          adaptedSkills,
        },
      },
      null,
      2,
    )}\n`,
  );

  const entries = [];
  const baseSources = new Set();
  for (const upstreamEntry of readTree(upstream, baseSha)) {
    baseSources.add(upstreamEntry.source);
    const target = upstreamEntry.source.replace(/^pstack\/skills\//, "skills/");
    const local = localFiles[target];
    if (local === undefined) {
      entries.push({
        source: upstreamEntry.source,
        target,
        blob: upstreamEntry.blob,
        mode: upstreamEntry.mode,
        rule: "excluded",
        reason: "Not ported in this fixture.",
      });
    } else if (gitBlobSha(Buffer.from(local)) === upstreamEntry.blob) {
      entries.push({
        source: upstreamEntry.source,
        target,
        blob: upstreamEntry.blob,
        mode: upstreamEntry.mode,
        rule: "verbatim",
      });
    } else {
      entries.push({
        source: upstreamEntry.source,
        target,
        blob: upstreamEntry.blob,
        mode: upstreamEntry.mode,
        rule: "local",
        reason: "Fixture adaptation.",
        tests: ["tests/skills.test.mjs"],
      });
    }
  }

  writeTree(root, localFiles);
  const localOnly = Object.keys(localFiles)
    .filter((target) => !baseSources.has(target.replace(/^skills\//, "pstack/skills/")))
    .map((target) => ({ target, reason: "Local-only fixture file." }));

  const manifest = {
    schema: "omp-pstack.upstream/1",
    source: {
      repository: "https://github.com/cursor/plugins",
      path: "pstack/skills",
      commit: baseSha,
      tree: baseTree,
    },
    entries,
  };
  if (localOnly.length > 0) manifest.localOnly = localOnly;
  fs.writeFileSync(path.join(root, "upstream.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function writeChanged(root, upstream, baseSha, headSha) {
  const changed = git(upstream.dir, ["diff", "--name-status", baseSha, headSha, "--", "pstack"]);
  const file = path.join(root, "changed.txt");
  fs.writeFileSync(file, `${changed}\n`);
  return file;
}

function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "upstream.json"), "utf8"));
}

function entryBySource(manifest, source) {
  return manifest.entries.find((entry) => entry.source === source);
}

test("clean sync advances the config and manifest pins in one PR", () => {
  const upstream = makeUpstream({ "pstack/skills/tdd/SKILL.md": "old tdd\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/tdd/SKILL.md": "old tdd\n" },
  });
  const head = advance(upstream, {
    write: {
      "pstack/skills/tdd/SKILL.md": "new tdd\n",
      "pstack/skills/reframe/SKILL.md": "reframe\n",
      "pstack/skills/reframe/references/notes.md": "nested\n",
    },
  });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
  });

  assert.equal(summary.mode, "pr");
  assert.equal(summary.pending, false);
  assert.deepEqual(summary.addedSkills, ["reframe"]);
  assert.deepEqual(summary.updatedSkills, ["tdd"]);
  assert.equal(readConfig(root).cursor.lastSyncedSha, head.sha);
  const manifest = readManifest(root);
  assert.equal(manifest.source.commit, head.sha);
  assert.equal(manifest.source.tree, head.tree);
  assert.equal(entryBySource(manifest, "pstack/skills/reframe/references/notes.md").rule, "verbatim");
  assert.equal(fs.readFileSync(path.join(root, "skills/reframe/references/notes.md"), "utf8"), "nested\n");
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});

test("clean sync drops manifest entries for files deleted upstream and locally", () => {
  const upstream = makeUpstream({
    "pstack/skills/old/SKILL.md": "old\n",
    "pstack/skills/keep/SKILL.md": "keep old\n",
  });
  const root = createRoot({
    upstream,
    localFiles: { "skills/old/SKILL.md": "old\n", "skills/keep/SKILL.md": "keep old\n" },
  });
  const head = advance(upstream, {
    write: { "pstack/skills/keep/SKILL.md": "keep new\n" },
    remove: ["pstack/skills/old/SKILL.md"],
  });
  fs.rmSync(path.join(root, "skills/old"), { recursive: true, force: true });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
  });

  assert.equal(summary.mode, "pr");
  assert.equal(summary.pending, false);
  assert.equal(entryBySource(readManifest(root), "pstack/skills/old/SKILL.md"), undefined);
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});

test("adapted-only updates hold the baseline until ack", () => {
  const upstream = makeUpstream({ "pstack/skills/how/SKILL.md": "upstream how\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/how/SKILL.md": "adapted how\n" },
    adaptedSkills: ["how"],
  });
  const head = advance(upstream, { write: { "pstack/skills/how/SKILL.md": "upstream how v2\n" } });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
  });

  assert.equal(summary.mode, "issue");
  assert.equal(summary.pending, false);
  assert.deepEqual(summary.manualAdaptedSkills, [
    { name: "how", files: ["pstack/skills/how/SKILL.md"] },
  ]);
  assert.equal(readConfig(root).cursor.lastSyncedSha, upstream.sha);

  ackUpstream({ root, cursorDir: upstream.dir, cursor: head.sha, adapt: ["how"], reason: "Ported for omp." });
  assert.equal(readConfig(root).cursor.lastSyncedSha, head.sha);
  const manifest = readManifest(root);
  assert.equal(manifest.source.commit, head.sha);
  const entry = entryBySource(manifest, "pstack/skills/how/SKILL.md");
  assert.equal(entry.rule, "local");
  assert.equal(entry.reason, "Ported for omp.");
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});

test("mixed sync stages pending copies and ack resolves them", () => {
  const upstream = makeUpstream({
    "pstack/skills/tdd/SKILL.md": "old tdd\n",
    "pstack/skills/how/SKILL.md": "upstream how\n",
  });
  const root = createRoot({
    upstream,
    localFiles: {
      "skills/tdd/SKILL.md": "old tdd\n",
      "skills/how/SKILL.md": "adapted how\n",
    },
    adaptedSkills: ["how"],
  });
  const head = advance(upstream, {
    write: {
      "pstack/skills/tdd/SKILL.md": "new tdd\n",
      "pstack/skills/how/SKILL.md": "upstream how v2\n",
      "pstack/skills/reframe/SKILL.md": "reframe\n",
    },
  });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
  });

  assert.equal(summary.mode, "pr");
  assert.equal(summary.pending, true);
  assert.equal(readConfig(root).cursor.lastSyncedSha, upstream.sha);
  const pendingManifest = readManifest(root);
  assert.equal(pendingManifest.pending.commit, head.sha);
  assert.equal(pendingManifest.pending.copiedVerbatim.length, 2);
  assert.deepEqual(pendingManifest.pending.unresolved, [
    { kind: "adapted", skill: "how", files: ["pstack/skills/how/SKILL.md"] },
  ]);
  const pendingCheck = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(pendingCheck.ok, true, pendingCheck.errors.join("\n"));

  assert.throws(
    () => ackUpstream({ root, cursorDir: upstream.dir, adapt: ["how"], adaptOnly: true }),
    /--adapt-only cannot run while upstream.json has pending copies/,
  );

  ackUpstream({ root, cursorDir: upstream.dir, cursor: head.sha, adapt: ["how"], reason: "Ported for omp." });
  const manifest = readManifest(root);
  assert.equal(manifest.pending, undefined);
  assert.equal(manifest.source.commit, head.sha);
  assert.equal(readConfig(root).cursor.lastSyncedSha, head.sha);
  assert.equal(entryBySource(manifest, "pstack/skills/tdd/SKILL.md").rule, "verbatim");
  assert.equal(entryBySource(manifest, "pstack/skills/reframe/SKILL.md").rule, "verbatim");
  assert.equal(entryBySource(manifest, "pstack/skills/how/SKILL.md").rule, "local");
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});

test("blocked new skills cannot be acked without an explicit port", () => {
  const upstream = makeUpstream({ "pstack/skills/tdd/SKILL.md": "tdd\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/tdd/SKILL.md": "tdd\n" },
  });
  const head = advance(upstream, {
    write: { "pstack/skills/blocked/SKILL.md": "Use subagent_type: generalPurpose\n" },
  });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
  });

  assert.equal(summary.mode, "issue");
  assert.equal(summary.blockedCursorSkills.length, 1);
  assert.equal(fs.existsSync(path.join(root, "skills/blocked/SKILL.md")), false);

  assert.throws(
    () => ackUpstream({ root, cursorDir: upstream.dir, cursor: head.sha, reason: "reviewed" }),
    /ack would leave an invalid manifest/,
  );
  assert.equal(readConfig(root).cursor.lastSyncedSha, upstream.sha);

  writeTree(root, { "skills/blocked/SKILL.md": "Ported for omp.\n" });
  ackUpstream({
    root,
    cursorDir: upstream.dir,
    cursor: head.sha,
    adapt: ["blocked"],
    reason: "Ported the blocked skill for omp.",
  });
  const manifest = readManifest(root);
  assert.equal(entryBySource(manifest, "pstack/skills/blocked/SKILL.md").rule, "local");
  assert.ok(readConfig(root).cursor.adaptedSkills.includes("blocked"));
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});

test("removed upstream skills are kept as localOnly on ack", () => {
  const upstream = makeUpstream({
    "pstack/skills/old/SKILL.md": "old\n",
    "pstack/skills/keep/SKILL.md": "keep\n",
  });
  const root = createRoot({
    upstream,
    localFiles: { "skills/old/SKILL.md": "old\n", "skills/keep/SKILL.md": "keep\n" },
  });
  const head = advance(upstream, { remove: ["pstack/skills/old/SKILL.md"] });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
  });
  assert.equal(summary.mode, "issue");
  assert.deepEqual(summary.removedUpstreamSkills, ["old"]);

  ackUpstream({
    root,
    cursorDir: upstream.dir,
    cursor: head.sha,
    reason: "Keep the local skill after upstream removal.",
  });
  const manifest = readManifest(root);
  assert.equal(manifest.entries.length, 1);
  assert.equal(entryBySource(manifest, "pstack/skills/keep/SKILL.md").rule, "verbatim");
  assert.deepEqual(manifest.localOnly, [
    { target: "skills/old/SKILL.md", reason: "Keep the local skill after upstream removal." },
  ]);
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});

test("dry-run reports copied files without touching the worktree", () => {
  const upstream = makeUpstream({ "pstack/skills/tdd/SKILL.md": "tdd\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/tdd/SKILL.md": "tdd\n" },
  });
  const head = advance(upstream, { write: { "pstack/skills/reframe/SKILL.md": "reframe\n" } });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const before = fs.readFileSync(path.join(root, "upstream.json"), "utf8");
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
    dryRun: true,
  });

  assert.equal(summary.mode, "pr");
  assert.equal(summary.copiedFiles.length, 1);
  assert.equal(fs.existsSync(path.join(root, "skills/reframe/SKILL.md")), false);
  assert.equal(fs.readFileSync(path.join(root, "upstream.json"), "utf8"), before);
});

test("executable bits survive a verbatim copy", { skip: process.platform === "win32" }, () => {
  const upstream = makeUpstream({ "pstack/skills/tdd/SKILL.md": "tdd\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/tdd/SKILL.md": "tdd\n" },
  });
  const head = advance(upstream, {
    write: { "pstack/skills/tool/scripts/run.sh": "#!/bin/sh\necho ok\n" },
  });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  syncUpstream({ root, cursorDir: upstream.dir, cursorSha: head.sha, cursorChangedFile: changed });
  const copied = path.join(root, "skills/tool/scripts/run.sh");
  assert.notEqual(fs.statSync(copied).mode & 0o111, 0);
  assert.equal(entryBySource(readManifest(root), "pstack/skills/tool/scripts/run.sh").mode, "100755");
});

test("no upstream change is a no-op", () => {
  const upstream = makeUpstream({ "pstack/skills/tdd/SKILL.md": "tdd\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/tdd/SKILL.md": "tdd\n" },
  });
  const before = fs.readFileSync(path.join(root, "upstream.json"), "utf8");
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: upstream.sha,
  });
  assert.equal(summary.mode, "none");
  assert.equal(fs.readFileSync(path.join(root, "upstream.json"), "utf8"), before);
});

test("rejects a baseline mismatch and a cursor HEAD mismatch", () => {
  const upstream = makeUpstream({ "pstack/skills/tdd/SKILL.md": "tdd\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/tdd/SKILL.md": "tdd\n" },
    configPin: "1".repeat(40),
  });
  assert.throws(
    () => syncUpstream({ root, cursorDir: upstream.dir, cursorSha: upstream.sha }),
    /baseline mismatch/,
  );

  const goodRoot = createRoot({
    upstream,
    localFiles: { "skills/tdd/SKILL.md": "tdd\n" },
  });
  assert.throws(
    () =>
      syncUpstream({
        root: goodRoot,
        cursorDir: upstream.dir,
        cursorSha: "f".repeat(40),
      }),
    /does not match --cursor-sha/,
  );
});

test("a tampered pending copy rolls ack back", () => {
  const upstream = makeUpstream({
    "pstack/skills/tdd/SKILL.md": "old tdd\n",
    "pstack/skills/how/SKILL.md": "upstream how\n",
  });
  const root = createRoot({
    upstream,
    localFiles: {
      "skills/tdd/SKILL.md": "old tdd\n",
      "skills/how/SKILL.md": "adapted how\n",
    },
    adaptedSkills: ["how"],
  });
  const head = advance(upstream, {
    write: {
      "pstack/skills/tdd/SKILL.md": "new tdd\n",
      "pstack/skills/how/SKILL.md": "upstream how v2\n",
    },
  });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  syncUpstream({ root, cursorDir: upstream.dir, cursorSha: head.sha, cursorChangedFile: changed });
  const manifestBefore = fs.readFileSync(path.join(root, "upstream.json"), "utf8");
  const configBefore = fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8");

  fs.writeFileSync(path.join(root, "skills/tdd/SKILL.md"), "tampered\n");
  assert.throws(
    () =>
      ackUpstream({
        root,
        cursorDir: upstream.dir,
        cursor: head.sha,
        adapt: ["how"],
        reason: "Ported for omp.",
      }),
    /pending copied file/,
  );
  assert.equal(fs.readFileSync(path.join(root, "upstream.json"), "utf8"), manifestBefore);
  assert.equal(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"), configBefore);
});

test("adapt-only records the skill without advancing the baseline", () => {
  const upstream = makeUpstream({ "pstack/skills/blocked/SKILL.md": "upstream\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/blocked/SKILL.md": "ported for omp\n" },
  });
  const head = advance(upstream, { write: { "pstack/skills/blocked/SKILL.md": "upstream v2\n" } });
  const manifestBefore = fs.readFileSync(path.join(root, "upstream.json"), "utf8");

  ackUpstream({ root, cursorDir: upstream.dir, adapt: ["blocked"], adaptOnly: true });
  assert.equal(readConfig(root).cursor.lastSyncedSha, upstream.sha);
  assert.equal(fs.readFileSync(path.join(root, "upstream.json"), "utf8"), manifestBefore);
  assert.ok(readConfig(root).cursor.adaptedSkills.includes("blocked"));
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});

test("excluded skill changes wait for an explicit ack", () => {
  const upstream = makeUpstream({
    "pstack/skills/make-bot-ui/SKILL.md": "bot ui\n",
    "pstack/skills/keep/SKILL.md": "keep\n",
  });
  const root = createRoot({
    upstream,
    localFiles: { "skills/keep/SKILL.md": "keep\n" },
    excludedSkills: ["make-bot-ui"],
  });
  const head = advance(upstream, {
    write: { "pstack/skills/make-bot-ui/notes.md": "new\n" },
  });
  const changed = writeChanged(root, upstream, upstream.sha, head.sha);
  const { summary } = syncUpstream({
    root,
    cursorDir: upstream.dir,
    cursorSha: head.sha,
    cursorChangedFile: changed,
  });

  assert.equal(summary.mode, "issue");
  assert.equal(summary.excludedChanges.length, 1);
  assert.equal(readConfig(root).cursor.lastSyncedSha, upstream.sha);

  ackUpstream({
    root,
    cursorDir: upstream.dir,
    cursor: head.sha,
    exclude: ["make-bot-ui"],
    reason: "Keep the bot UI workflow out of this fork.",
  });
  const manifest = readManifest(root);
  assert.equal(entryBySource(manifest, "pstack/skills/make-bot-ui/notes.md").rule, "excluded");
  assert.ok(readConfig(root).cursor.excludedSkills.includes("make-bot-ui"));
  const check = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(check.ok, true, check.errors.join("\n"));
});
