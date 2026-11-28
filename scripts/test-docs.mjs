// Documentation fidelity checks for docs/**. Run with:
//   node --test scripts/test-docs.mjs
//
// The checks are offline and read only this checkout.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  INDEX_PATH,
  PLAYBOOKS_DIR,
  SKILLS_DIR,
  collectPlaybooks,
  collectSkills,
  parseYamlSubset,
  renderIndex,
  splitFrontmatter,
} from "./docs-index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_DIR = join(ROOT, "docs");

function walkMarkdown(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(full));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

const docsMarkdown = walkMarkdown(DOCS_DIR);
const skills = collectSkills();
const skillNames = new Set(skills.map((skill) => skill.name));
const playbooks = collectPlaybooks();
const playbookNames = new Set(playbooks.map((playbook) => playbook.file));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect the text inside fenced code blocks and inline code spans. Only these
 * regions are checked for bare commands; prose, links, and file paths are not.
 */
function codeRegions(markdown) {
  const regions = [];
  const lines = markdown.split("\n");
  let fence = null;
  let buffer = [];

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) {
        regions.push(buffer.join("\n"));
        buffer = [];
        fence = null;
      } else {
        buffer.push(line);
      }
      continue;
    }

    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    for (const span of line.matchAll(/(`+)((?:(?!\1)[\s\S])*?)\1/g)) {
      regions.push(span[2]);
    }
  }

  if (fence !== null) regions.push(buffer.join("\n"));
  return regions;
}

/**
 * Find bundled skill names used as bare slash commands inside code. A bare
 * command is `/name` where `name` is a real skill, except `/poteto-mode`, which
 * the extension registers as a legal command. `/skill:name`, file paths, and
 * Markdown link targets are not bare commands.
 */
export function findBareCommands(markdown, names) {
  const candidates = [...names]
    .filter((name) => name !== "poteto-mode")
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  if (candidates.length === 0) return [];

  const pattern = new RegExp(`(?<![A-Za-z0-9_./:-])/(${candidates.join("|")})(?![A-Za-z0-9_/-])`, "g");
  const findings = [];

  for (const region of codeRegions(markdown)) {
    const text = region.replace(/\]\([^)]*\)/g, "]()");
    for (const match of text.matchAll(pattern)) {
      findings.push({ name: match[1], context: text.trim().split("\n")[0].slice(0, 120) });
    }
  }

  return findings;
}

test("frontmatter parser reads double-quoted, single-quoted, literal, folded, and chomped scalars", () => {
  assert.equal(parseYamlSubset('description: "Say \\"hi\\" now."').description, 'Say "hi" now.');
  assert.equal(parseYamlSubset("description: 'It''s fine.'").description, "It's fine.");
  assert.equal(
    parseYamlSubset(["description: |", "  first line", "  second line"].join("\n")).description,
    "first line\nsecond line\n",
  );
  assert.equal(
    parseYamlSubset(["description: >", "  first line", "  second line"].join("\n")).description,
    "first line second line\n",
  );
  assert.equal(
    parseYamlSubset(["description: >-", "  first line", "  second line"].join("\n")).description,
    "first line second line",
  );
  assert.equal(
    parseYamlSubset(["description: |-", "  first line", "  second line"].join("\n")).description,
    "first line\nsecond line",
  );
});

test("frontmatter ends at the first closing delimiter, so a later --- stays in the body", () => {
  const text = ["---", "name: demo", "description: >-", "  one", "  two", "---", "", "# Demo", "", "---", "", "Body."].join(
    "\n",
  );
  const { frontmatter, body } = splitFrontmatter(text);
  const data = parseYamlSubset(frontmatter);

  assert.equal(data.name, "demo");
  assert.equal(data.description, "one two");
  assert.ok(!body.includes("name: demo"), "frontmatter must not leak into the body");
  assert.ok(body.includes("---"), "the later --- must remain in the body");
});

test("every bundled skill has parseable name and description frontmatter", () => {
  assert.ok(skills.length > 0, "no skills found");
  for (const skill of skills) {
    assert.ok(existsSync(join(SKILLS_DIR, skill.name, "SKILL.md")), `${skill.name}: missing SKILL.md`);
    assert.ok(skill.description.length > 0, `${skill.name}: empty description`);
  }
});

test("local Markdown links in docs resolve", () => {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of docsMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(linkPattern)) {
      const raw = match[1].trim();
      if (raw === "" || /^(https?:|mailto:|data:|#)/.test(raw)) continue;
      const target = raw.replace(/[?#].*$/, "");
      if (target === "") continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${relative(ROOT, file)}: broken local link ${raw}`);
    }
  }
});

test("every /skill: name mentioned in docs exists in skills/", () => {
  for (const file of docsMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\/skill:([a-z0-9-]+)/g)) {
      assert.ok(skillNames.has(match[1]), `${relative(ROOT, file)}: unknown skill /skill:${match[1]}`);
    }
  }
});

test("every linked playbook exists", () => {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let linked = 0;
  for (const file of docsMarkdown) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(linkPattern)) {
      const raw = match[1].trim();
      if (!raw.includes("skills/poteto-mode/playbooks/")) continue;
      if (!raw.endsWith(".md")) continue;
      const target = resolve(dirname(file), raw.replace(/[?#].*$/, ""));
      assert.ok(existsSync(target), `${relative(ROOT, file)}: missing playbook ${raw}`);
      assert.ok(playbookNames.has(basename(target)), `${relative(ROOT, file)}: unknown playbook ${raw}`);
      linked += 1;
    }
  }
  assert.ok(linked > 0, "docs link no playbooks");
});

test("docs use /skill: instead of bare skill commands inside code", () => {
  for (const file of docsMarkdown) {
    const findings = findBareCommands(readFileSync(file, "utf8"), skillNames);
    assert.deepEqual(
      findings.map((finding) => finding.name),
      [],
      `${relative(ROOT, file)}: bare command in code, use /skill:<name> (${JSON.stringify(findings[0]?.context ?? "")})`,
    );
  }
});

test("bare-command scan finds a real bad code block", () => {
  const markdown = ["```text", "/tdd implement", "```", ""].join("\n");
  assert.deepEqual(
    findBareCommands(markdown, skillNames).map((finding) => finding.name),
    ["tdd"],
  );
});

test("bare-command scan finds an inline code span", () => {
  assert.deepEqual(
    findBareCommands("Run `/how` before editing.", skillNames).map((finding) => finding.name),
    ["how"],
  );
});

test("bare-command scan ignores skill paths, links, /skill:, /poteto-mode, and host commands", () => {
  const markdown = [
    "`skills/tdd/SKILL.md`",
    "`/Users/timmy/.omp/skills/tdd/SKILL.md`",
    "```md",
    "[the how skill](/how)",
    "```",
    "`/skill:how`",
    "`/poteto-mode sticky`",
    "`/loop 10 --until 'bun test'`",
    "`/goal set ship it`",
  ].join("\n");

  assert.deepEqual(findBareCommands(markdown, skillNames), []);
});

test("docs/skills.md is current", () => {
  assert.ok(existsSync(INDEX_PATH), "docs/skills.md is missing; run node scripts/docs-index.mjs");
  assert.equal(readFileSync(INDEX_PATH, "utf8"), renderIndex(), "docs/skills.md is stale; run node scripts/docs-index.mjs");
});

test("the generated index covers every skill and playbook", () => {
  const index = readFileSync(INDEX_PATH, "utf8");
  for (const skill of skills) {
    assert.ok(index.includes(`../skills/${skill.name}/SKILL.md`), `docs/skills.md: missing ${skill.name}`);
  }
  for (const playbook of playbooks) {
    assert.ok(index.includes(`../skills/poteto-mode/playbooks/${playbook.file}`), `docs/skills.md: missing ${playbook.file}`);
  }
  assert.ok(playbooks.length > 0);
  assert.ok(statSync(PLAYBOOKS_DIR).isDirectory());
});
