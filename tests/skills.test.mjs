import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(root, "skills");
const skillNames = readdirSync(skillsDir).filter((name) => statSync(join(skillsDir, name)).isDirectory());

function walkMarkdown(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(full));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

const skillMarkdown = walkMarkdown(skillsDir);
const agentsDir = join(root, "agents");
const agentFiles = readdirSync(agentsDir).filter((name) => name.endsWith(".md"));
const docFiles = [
  join(root, "README.md"),
  ...skillMarkdown,
  ...agentFiles.map((name) => join(agentsDir, name)),
];

test("local Markdown links resolve to real files", () => {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(linkPattern)) {
      const raw = match[1].trim();
      if (raw === "" || /^(https?:|mailto:|#)/.test(raw)) continue;
      const target = raw.replace(/[?#].*$/, "");
      if (target === "") continue;
      assert.ok(existsSync(join(dirname(file), target)), `${file}: broken local link ${raw}`);
    }
  }
});

test("every skill has name and description frontmatter", () => {
  for (const name of skillNames) {
    const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    assert.match(text, /^---\r?\n/, `${name}: missing frontmatter`);
    assert.match(text, new RegExp(`\\r?\\nname:\\s*${name}\\r?\\n`), `${name}: wrong frontmatter name`);
    assert.match(text, /\r?\ndescription:\s*\S/, `${name}: missing description`);
  }
});

function frontmatterOf(text) {
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

test("bundled skills are hidden from the model catalog", () => {
  for (const name of skillNames) {
    const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    const hidden = /^disable-model-invocation:\s*true$/m.test(frontmatterOf(text));
    if (name === "setup-pstack") {
      assert.equal(hidden, false, "setup-pstack must stay visible");
    } else {
      assert.equal(hidden, true, `${name}: missing disable-model-invocation`);
    }
  }
});

test("skills do not reference pi-herdr tooling", () => {
  const forbidden = [
    /`subagent`/,
    /subagents_write_task_models/,
    /subagents_list/,
    /herdr-agents/,
    /`set_tasks`/,
  ];
  for (const file of skillMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file}: stale reference ${pattern}`);
    }
  }
});

test("skills do not reference Cursor-specific tooling", () => {
  const forbidden = [
    /~\/\.cursor\//,
    /\bsubagent_type\b/,
    /\bcloud_base_branch\b/,
    /pstack-models\.mdc/,
    /environment:\s*"cloud"/,
    /\bAskQuestion\b/,
    /cursor-team-kit/,
    /\bgeneralPurpose\b/,
    /\/visualize\b/,
    /plugins\/cache\//,
    /\bis_background\b/,
  ];
  for (const file of skillMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file}: Cursor-specific reference ${pattern}`);
    }
  }
});

test("poteto-mode autonomy matches Cursor", () => {
  const text = readFileSync(join(skillsDir, "poteto-mode", "SKILL.md"), "utf8");
  const autonomy = text.match(/## Autonomy\r?\n([\s\S]*?)\r?\n## /)?.[1] ?? "";
  assert.match(autonomy, /Reversible work and external actions/);
  assert.match(autonomy, /Always pause\*\* for irreversible writes/);
  assert.doesNotMatch(autonomy, /PR creation or updates/);
  assert.doesNotMatch(autonomy, /CI triggers/);
  assert.doesNotMatch(autonomy, /\bmerges\b/);
});

test("poteto-help documents the sticky commands, recipes, install, and reframe", () => {
  const text = readFileSync(join(skillsDir, "poteto-help", "SKILL.md"), "utf8");
  assert.match(text, /\[`reframe`\]\(\.\.\/reframe\/SKILL\.md\)/);
  assert.match(text, /\/poteto-mode sticky \[task\]/);
  assert.match(text, /\/poteto-mode off/);
  assert.match(text, /\/poteto-mode status/);
  assert.match(text, /omp plugin install omp-pstack@sencha930511/);

  const recipes = readFileSync(join(skillsDir, "poteto-help", "references", "recipes.md"), "utf8");
  assert.doesNotMatch(recipes, /\/skill:poteto-mode/);
  assert.match(recipes, /\/poteto-mode sticky <task>/);

  const reflect = readFileSync(join(skillsDir, "reflect", "SKILL.md"), "utf8");
  assert.match(reflect, /\.omp\/skills\/<skill>\//);
  assert.match(reflect, /~\/\.omp\/agent\/skills\/<skill>\//);
});

test("how and arena use scout, interrogate uses task", () => {
  const how = readFileSync(join(skillsDir, "how", "SKILL.md"), "utf8");
  assert.match(how, /Spawn one `scout` subagent/);

  const arena = readFileSync(join(skillsDir, "arena", "SKILL.md"), "utf8");
  const phaseC = arena.match(/## Phase C: Cross-judge\r?\n([\s\S]*?)\r?\n## /)?.[1] ?? "";
  assert.match(phaseC, /`scout`/);

  const interrogate = readFileSync(join(skillsDir, "interrogate", "SKILL.md"), "utf8");
  const fanOut = interrogate.match(/## Fan out\r?\n([\s\S]*?)\r?\n## /)?.[1] ?? "";
  assert.match(fanOut, /agent: "task"/);
  assert.doesNotMatch(fanOut, /poteto-agent/);
});

test("worktree-cleanup and autopilot-full use omp session state", () => {
  const worktree = readFileSync(join(skillsDir, "poteto-mode", "playbooks", "worktree-cleanup.md"), "utf8");
  assert.doesNotMatch(worktree, /sidebar/);
  assert.match(worktree, /session-pins\.json/);
  assert.match(worktree, /archive\.grep/);

  const autopilot = readFileSync(join(skillsDir, "poteto-mode", "playbooks", "autopilot-full.md"), "utf8");
  assert.doesNotMatch(autopilot, /VM dies/);
  assert.doesNotMatch(autopilot, /root agent's store/);
  assert.match(autopilot, /decision log/);
});

test("poteto-mode carries the omp header and hide-mode rule", () => {
  const text = readFileSync(join(skillsDir, "poteto-mode", "SKILL.md"), "utf8");
  assert.match(text, /Poteto Mode is active for this session/);
  assert.match(text, /\/skill:<name>/);
  assert.match(text, /skill:\/\/<name>/);
  assert.doesNotMatch(text, /SKILL-INDEX/);
});

test("every bundled agent has matching name and description frontmatter", () => {
  assert.ok(agentFiles.includes("poteto-agent.md"), "missing poteto-agent.md");
  assert.ok(agentFiles.includes("comment-sicko.md"), "missing comment-sicko.md");
  for (const file of agentFiles) {
    const name = file.slice(0, -3);
    const text = readFileSync(join(agentsDir, file), "utf8");
    assert.match(text, /^---\r?\n/, `${file}: missing frontmatter`);
    assert.match(text, new RegExp(`\\r?\\nname:\\s*${name}\\r?\\n`), `${file}: wrong frontmatter name`);
    assert.match(text, /\r?\ndescription:\s*\S/, `${file}: missing description`);
  }
});

test("package.json omp manifest paths exist", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.omp?.extensions) && pkg.omp.extensions.length > 0, "missing omp.extensions");
  assert.ok(Array.isArray(pkg.omp?.skills) && pkg.omp.skills.length > 0, "missing omp.skills");
  for (const rel of [...pkg.omp.extensions, ...pkg.omp.skills]) {
    const target = join(root, rel);
    assert.ok(existsSync(target), `missing omp manifest target: ${rel}`);
  }
});

test("agents use only supported omp frontmatter fields", () => {
  for (const file of agentFiles) {
    const text = readFileSync(join(agentsDir, file), "utf8");
    for (const field of ["system-prompt:", "spawning:", "auto-exit:"]) {
      assert.doesNotMatch(text, new RegExp(`\\r?\\n${field}`), `${file}: unsupported frontmatter field ${field}`);
    }
  }

  const poteto = readFileSync(join(agentsDir, "poteto-agent.md"), "utf8");
  assert.match(poteto, /\r?\nspawns:\s*"\*"/);
  assert.match(frontmatterOf(poteto), /\r?\nautoloadSkills:\s*\r?\n\s*-\s*poteto-mode\b/);

  const sicko = readFileSync(join(agentsDir, "comment-sicko.md"), "utf8");
  assert.doesNotMatch(sicko, /\r?\nspawns:/);
  const toolsLine = sicko.match(/\r?\ntools:\s*(.+)\r?\n/);
  assert.ok(toolsLine, "comment-sicko: missing tools");
  const tools = toolsLine[1].split(",").map((tool) => tool.trim());
  assert.deepEqual(tools, ["read", "grep", "glob", "edit", "bash"]);
  assert.doesNotMatch(toolsLine[1], /\b(task|write)\b/);
});

test("skills do not keep stale porting paths", () => {
  const stale = [
    "agent-transcripts/",
    "packages/pi-pstack",
    "inherit-parent",
    "explore (read-only",
    ".pi/skills",
    "~/.pi/agent/skills",
    "pi-goal-x",
    "a user question tool",
    "only if it is registered",
    "when registered; otherwise read this SKILL.md by path",
  ];
  for (const file of skillMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const marker of stale) {
      assert.ok(!text.includes(marker), `${file}: stale porting text ${marker}`);
    }
    assert.doesNotMatch(text, /\bin pi\b/, `${file}: stale pi-specific phrasing`);
  }
});

test("worktree-audit.sh scans sibling workspace sessions and works without rg", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pstack-wt-audit-"));
  const cleanBins = [];
  try {
    const repo = join(dir, "repo");
    const wt = join(dir, "wt-feature");
    const sessionsDir = join(dir, "sessions");
    mkdirSync(repo, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "README.md"), "init\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "init"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(["worktree", "add", "-b", "feat/x", wt]);

    const realWt = git(["rev-parse", "--show-toplevel"], wt);
    const activeSession = join(sessionsDir, "active.jsonl");
    const siblingSession = join(sessionsDir, "sibling.jsonl");
    writeFileSync(activeSession, '{"type":"session"}\n');
    writeFileSync(siblingSession, `{"cwd":"${realWt}/src"}\n`);

    const stubBin = join(dir, "stub-bin");
    mkdirSync(stubBin, { recursive: true });
    const fakeGh = join(stubBin, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\necho '[]'\n");
    chmodSync(fakeGh, 0o755);

    const pathParts = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const filteredParts = [stubBin];
    for (const part of pathParts) {
      if (!existsSync(part)) continue;
      if (existsSync(join(part, "rg"))) {
        const cleanDir = mkdtempSync(join(dir, "no-rg-"));
        cleanBins.push(cleanDir);
        for (const entry of readdirSync(part)) {
          if (entry === "rg") continue;
          symlinkSync(join(part, entry), join(cleanDir, entry));
        }
        filteredParts.push(cleanDir);
      } else {
        filteredParts.push(part);
      }
    }

    const script = join(root, "skills", "poteto-mode", "scripts", "worktree-audit.sh");
    const output = execFileSync("bash", [script, "-b", "origin/main", repo], {
      env: {
        ...process.env,
        PATH: filteredParts.join(delimiter),
        PI_SESSION_FILE: activeSession,
      },
      encoding: "utf8",
    });

    const row = output.split(/\r?\n/).find((line) => line.endsWith(`\t${realWt}`));
    assert.ok(row, `expected row for ${realWt} in:\n${output}`);
    const cols = row.split("\t");
    assert.match(cols[6] ?? "", /^\d{4}-\d{2}-\d{2}$/, `expected LAST_CHAT date in row: ${row}`);
    assert.equal(cols[7], "verify-recent-chat", `expected verify-recent-chat bucket in row: ${row}`);
  } finally {
    for (const d of cleanBins) rmSync(d, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
