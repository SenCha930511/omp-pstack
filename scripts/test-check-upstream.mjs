import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkUpstream } from "./check-upstream.mjs";
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

function writeFiles(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (relative.endsWith(".sh")) fs.chmodSync(target, 0o755);
  }
}

function commitAll(dir) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "upstream"]);
  return {
    dir,
    sha: git(dir, ["rev-parse", "HEAD"]),
    tree: git(dir, ["rev-parse", "HEAD:pstack/skills"]),
  };
}

function createUpstream(files) {
  const dir = makeTemp("omp-pstack-check-upstream-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  writeFiles(dir, files);
  return commitAll(dir);
}

function advanceUpstream(upstream, files) {
  writeFiles(upstream.dir, files);
  return commitAll(upstream.dir);
}

function entryFor(source, blob, mode, extra = {}) {
  return {
    source,
    target: source.replace(/^pstack\/skills\//, "skills/"),
    blob,
    mode,
    ...extra,
  };
}

function createRoot({ upstream, localFiles, entries, pin, pending, localOnly }) {
  const root = makeTemp("omp-pstack-check-root-");
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
          lastSyncedSha: pin ?? upstream.sha,
          excludedSkills: [],
          adaptedSkills: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  for (const [relative, content] of Object.entries(localFiles ?? {})) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const manifest = {
    schema: "omp-pstack.upstream/1",
    source: {
      repository: "https://github.com/cursor/plugins",
      path: "pstack/skills",
      commit: pin ?? upstream.sha,
      tree: upstream.tree,
    },
    entries,
  };
  if (pending) manifest.pending = pending;
  if (localOnly) manifest.localOnly = localOnly;
  fs.writeFileSync(path.join(root, "upstream.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function verbatimEntry(upstream, relative) {
  const source = `pstack/skills/${relative}`;
  const bytes = fs.readFileSync(path.join(upstream.dir, source));
  return entryFor(source, gitBlobSha(bytes), "100644", { rule: "verbatim" });
}

function localEntry(upstream, relative) {
  const source = `pstack/skills/${relative}`;
  const bytes = fs.readFileSync(path.join(upstream.dir, source));
  return entryFor(source, gitBlobSha(bytes), "100644", {
    rule: "local",
    reason: "Fixture adaptation for omp.",
    tests: ["tests/skills.test.mjs"],
  });
}

test("accepts verbatim, local, excluded, nested, and localOnly entries", () => {
  const upstream = createUpstream({
    "pstack/skills/how/SKILL.md": "upstream how\n",
    "pstack/skills/how/references/deep.md": "upstream deep\n",
    "pstack/skills/excluded/SKILL.md": "excluded\n",
  });
  const root = createRoot({
    upstream,
    localFiles: {
      "skills/how/SKILL.md": "adapted how\n",
      "skills/how/references/deep.md": "upstream deep\n",
      "skills/local-only/SKILL.md": "local\n",
    },
    entries: [
      localEntry(upstream, "how/SKILL.md"),
      verbatimEntry(upstream, "how/references/deep.md"),
      entryFor("pstack/skills/excluded/SKILL.md", gitBlobSha(Buffer.from("excluded\n")), "100644", {
        rule: "excluded",
        reason: "Not ported.",
      }),
    ],
    localOnly: [{ target: "skills/local-only/SKILL.md", reason: "Kept locally." }],
  });
  const offline = checkUpstream({ root });
  assert.equal(offline.ok, true, offline.errors.join("\n"));
  const live = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(live.ok, true, live.errors.join("\n"));
  assert.deepEqual(live.counts, {
    entries: 3,
    verbatim: 1,
    local: 1,
    excluded: 1,
    pendingCopied: 0,
    pendingUnresolved: 0,
  });
});

test("rejects missing local files, missing metadata, and byte-identical local entries", () => {
  const upstream = createUpstream({
    "pstack/skills/a/SKILL.md": "a\n",
    "pstack/skills/b/SKILL.md": "b\n",
    "pstack/skills/c/SKILL.md": "c\n",
  });
  const root = createRoot({
    upstream,
    localFiles: {
      "skills/a/SKILL.md": "a\n",
      "skills/b/SKILL.md": "b local\n",
      "skills/c/SKILL.md": "c\n",
    },
    entries: [
      entryFor("pstack/skills/a/SKILL.md", gitBlobSha(Buffer.from("a\n")), "100644", { rule: "verbatim" }),
      entryFor("pstack/skills/b/SKILL.md", gitBlobSha(Buffer.from("b\n")), "100644", { rule: "local" }),
      localEntry(upstream, "c/SKILL.md"),
    ],
  });
  const result = checkUpstream({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("skills/b/SKILL.md: local entry needs a nonempty reason")));
  assert.ok(result.errors.some((error) => error.includes("skills/c/SKILL.md: local entry is byte-identical")));

  fs.rmSync(path.join(root, "skills/a/SKILL.md"));
  const missing = checkUpstream({ root });
  assert.ok(missing.errors.some((error) => error.includes("skills/a/SKILL.md: local file is missing")));
});

test("rejects excluded files that exist and local files without entries", () => {
  const upstream = createUpstream({
    "pstack/skills/excluded/SKILL.md": "excluded\n",
    "pstack/skills/kept/SKILL.md": "kept\n",
  });
  const root = createRoot({
    upstream,
    localFiles: {
      "skills/excluded/SKILL.md": "excluded\n",
      "skills/orphan/SKILL.md": "orphan\n",
    },
    entries: [
      entryFor("pstack/skills/excluded/SKILL.md", gitBlobSha(Buffer.from("excluded\n")), "100644", {
        rule: "excluded",
        reason: "Not ported.",
      }),
      verbatimEntry(upstream, "kept/SKILL.md"),
    ],
  });
  const result = checkUpstream({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("excluded entry must not have a local file")));
  assert.ok(result.errors.some((error) => error.includes("skills/orphan/SKILL.md: local file has no manifest entry")));
});

test("rejects duplicate sources and path escapes", () => {
  const upstream = createUpstream({ "pstack/skills/a/SKILL.md": "a\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/a/SKILL.md": "a\n" },
    entries: [
      verbatimEntry(upstream, "a/SKILL.md"),
      verbatimEntry(upstream, "a/SKILL.md"),
      { ...verbatimEntry(upstream, "a/SKILL.md"), source: "pstack/skills/../evil", target: "skills/evil" },
    ],
  });
  const result = checkUpstream({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("duplicate source")));
  assert.ok(result.errors.some((error) => error.includes("unsafe source")));
});

test("rejects Cursor-only references in a verbatim entry", () => {
  const upstream = createUpstream({
    "pstack/skills/blocked/SKILL.md": "Use subagent_type: generalPurpose\n",
  });
  const root = createRoot({
    upstream,
    localFiles: { "skills/blocked/SKILL.md": "Use subagent_type: generalPurpose\n" },
    entries: [verbatimEntry(upstream, "blocked/SKILL.md")],
  });
  const result = checkUpstream({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("Cursor-only references")));
});

test("rejects a symlinked skills root", { skip: process.platform === "win32" }, () => {
  const upstream = createUpstream({ "pstack/skills/a/SKILL.md": "a\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/a/SKILL.md": "a\n" },
    entries: [verbatimEntry(upstream, "a/SKILL.md")],
  });
  fs.rmSync(path.join(root, "skills"), { recursive: true, force: true });
  fs.symlinkSync(path.join(upstream.dir, "pstack", "skills"), path.join(root, "skills"), "dir");
  const result = checkUpstream({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("root must not be a symlink")));
});

test("accepts pending copies and rejects a tampered pending blob", () => {
  const base = createUpstream({ "pstack/skills/a/SKILL.md": "a\n" });
  const head = advanceUpstream(base, { "pstack/skills/b/SKILL.md": "new b\n" });
  const root = createRoot({
    upstream: base,
    localFiles: { "skills/a/SKILL.md": "a\n", "skills/b/SKILL.md": "new b\n" },
    entries: [verbatimEntry(base, "a/SKILL.md")],
    pending: {
      commit: head.sha,
      tree: head.tree,
      copiedVerbatim: [
        entryFor("pstack/skills/b/SKILL.md", gitBlobSha(Buffer.from("new b\n")), "100644"),
      ],
      unresolved: [{ kind: "adapted", skill: "a", files: ["pstack/skills/a/SKILL.md"] }],
    },
  });
  const ok = checkUpstream({ root, cursorDir: head.dir });
  assert.equal(ok.ok, true, ok.errors.join("\n"));

  fs.writeFileSync(path.join(root, "skills/b/SKILL.md"), "tampered\n");
  const tampered = checkUpstream({ root });
  assert.equal(tampered.ok, false);
  assert.ok(
    tampered.errors.some(
      (error) => error.includes("pending copied file") || error.includes("skills/b/SKILL.md: blob"),
    ),
  );
});

test("rejects a config pin or upstream tree mismatch", () => {
  const upstream = createUpstream({ "pstack/skills/a/SKILL.md": "a\n" });
  const root = createRoot({
    upstream,
    localFiles: { "skills/a/SKILL.md": "a\n" },
    entries: [verbatimEntry(upstream, "a/SKILL.md")],
    pin: "1".repeat(40),
  });
  const manifestPath = path.join(root, "upstream.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.source.commit = upstream.sha;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const pinResult = checkUpstream({ root });
  assert.equal(pinResult.ok, false);
  assert.ok(pinResult.errors.some((error) => error.includes("must equal cursor.lastSyncedSha")));

  manifest.source.tree = "2".repeat(40);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const configPath = path.join(root, ".github", "upstream-sync.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.cursor.lastSyncedSha = upstream.sha;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const treeResult = checkUpstream({ root, cursorDir: upstream.dir });
  assert.equal(treeResult.ok, false);
  assert.ok(treeResult.errors.some((error) => error.includes("does not match recorded")));
});
