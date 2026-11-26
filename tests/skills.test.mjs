import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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

test("docs do not use skill URI syntax", () => {
  for (const file of docFiles) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /skill:\/\//, `${file}: skill URI syntax`);
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

test("the relative-path index covers every skill except poteto-mode", () => {
  const index = readFileSync(join(skillsDir, "poteto-mode", "SKILL-INDEX.md"), "utf8");
  for (const name of skillNames) {
    if (name === "poteto-mode") continue;
    assert.ok(index.includes(`../${name}/SKILL.md`), `${name}: missing from SKILL-INDEX.md`);
    assert.ok(statSync(join(skillsDir, name, "SKILL.md")).isFile(), `${name}: missing SKILL.md`);
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
  ];
  for (const file of skillMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${file}: Cursor-specific reference ${pattern}`);
    }
  }
});

test("skills do not advertise the removed /poteto-mode command", () => {
  for (const file of skillMarkdown) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /(?<!skill:)(?<![\w.\/])\/poteto-mode(?=[\s`.,;:]|$)/, `${file}: stale /poteto-mode command`);
  }
});

test("poteto-mode carries the omp header and relative path rule", () => {
  const text = readFileSync(join(skillsDir, "poteto-mode", "SKILL.md"), "utf8");
  assert.match(text, /Poteto Mode is active for this session/);
  assert.match(text, /SKILL-INDEX\.md/);
  assert.match(text, /\.\.\/<name>\/SKILL\.md/);
  assert.doesNotMatch(text, /skill:\/\//);
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

  const sicko = readFileSync(join(agentsDir, "comment-sicko.md"), "utf8");
  assert.doesNotMatch(sicko, /\r?\nspawns:/);
  const toolsLine = sicko.match(/\r?\ntools:\s*(.+)\r?\n/);
  assert.ok(toolsLine, "comment-sicko: missing tools");
  assert.doesNotMatch(toolsLine[1], /\bls\b/);
  assert.match(toolsLine[1], /\bglob\b/);
});

test("skills do not keep stale porting paths", () => {
  const stale = ["agent-transcripts/", "packages/pi-pstack", "inherit-parent", "explore (read-only"];
  for (const file of skillMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const marker of stale) {
      assert.ok(!text.includes(marker), `${file}: stale porting text ${marker}`);
    }
  }
});
