#!/usr/bin/env node
// Generates docs/skills.md from skills/*/SKILL.md frontmatter.
// Offline: reads only this checkout, never the network or an upstream source.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const SKILLS_DIR = join(ROOT, "skills");
export const PLAYBOOKS_DIR = join(SKILLS_DIR, "poteto-mode", "playbooks");
export const INDEX_PATH = join(ROOT, "docs", "skills.md");

/**
 * Split a SKILL.md into frontmatter source and body. The closing delimiter is
 * the first `---` line after the opening one, so a later `---` in the body
 * (a horizontal rule, for example) stays in the body and is never parsed as
 * frontmatter.
 */
export function splitFrontmatter(text) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/**
 * Minimal YAML subset for SKILL.md frontmatter. Supports plain scalars,
 * double-quoted scalars, single-quoted scalars, literal (`|`) and folded (`>`)
 * block scalars, and the `-`/`+` chomping indicators. Nested maps, anchors,
 * tags, and flow collections are out of scope; skill frontmatter does not use
 * them for the fields this index reads.
 */
export function parseYamlSubset(source) {
  const lines = source.split(/\r?\n/);
  const result = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (/^[ \t]*(?:#.*)?$/.test(line)) {
      index += 1;
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/.exec(line);
    if (!keyMatch) {
      index += 1;
      continue;
    }

    const key = keyMatch[1];
    const rest = (keyMatch[2] ?? "").trim();

    if (/^[|>](?:[+-]?\d*|\d*[+-]?)$/.test(rest)) {
      const style = rest[0];
      const chomp = rest.includes("-") ? "strip" : rest.includes("+") ? "keep" : "clip";
      const block = [];
      index += 1;
      while (index < lines.length) {
        const blockLine = lines[index];
        if (blockLine.trim() === "") {
          block.push("");
          index += 1;
          continue;
        }
        if (!/^[ \t]/.test(blockLine)) break;
        block.push(blockLine);
        index += 1;
      }
      result[key] = renderBlockScalar(block, style, chomp);
      continue;
    }

    if (rest.startsWith('"')) {
      result[key] = parseDoubleQuoted(rest);
      index += 1;
      continue;
    }

    if (rest.startsWith("'")) {
      result[key] = parseSingleQuoted(rest);
      index += 1;
      continue;
    }

    result[key] = rest;
    index += 1;
  }

  return result;
}

function renderBlockScalar(blockLines, style, chomp) {
  const nonBlank = blockLines.filter((line) => line.trim() !== "");
  const indent = nonBlank.length > 0 ? Math.min(...nonBlank.map((line) => line.match(/^[ \t]*/)[0].length)) : 0;
  const dedented = blockLines.map((line) => (line.trim() === "" ? "" : line.slice(indent)));

  let value;
  if (style === "|") {
    value = dedented.join("\n");
  } else {
    value = "";
    for (const line of dedented) {
      if (line === "") {
        value += "\n";
        continue;
      }
      if (value !== "" && !value.endsWith("\n")) value += " ";
      value += line;
    }
  }

  if (chomp === "strip") return value.replace(/\n+$/, "");
  if (chomp === "keep") return value;
  const trimmed = value.replace(/\n+$/, "");
  return trimmed === "" ? "" : `${trimmed}\n`;
}

function parseDoubleQuoted(value) {
  const end = findClosingQuote(value, '"');
  const body = value.slice(1, end);
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return body.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }
}

function parseSingleQuoted(value) {
  const end = findClosingQuote(value, "'");
  return value.slice(1, end).replace(/''/g, "'");
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (quote === '"' && value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      return index;
    }
  }
  return value.length;
}

/** Read every skills/<name>/SKILL.md and return its frontmatter fields. */
export function collectSkills() {
  const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
    .map((entry) => {
      const file = join(SKILLS_DIR, entry.name, "SKILL.md");
      const { frontmatter } = splitFrontmatter(readFileSync(file, "utf8"));
      const data = parseYamlSubset(frontmatter);
      const name = typeof data.name === "string" ? data.name.trim() : "";
      const description = typeof data.description === "string" ? data.description : "";
      if (name !== entry.name) {
        throw new Error(`${file}: frontmatter name ${JSON.stringify(name)} does not match directory ${entry.name}`);
      }
      if (description.trim() === "") {
        throw new Error(`${file}: frontmatter has no description`);
      }
      return {
        name,
        description: description.replace(/\s+/g, " ").trim(),
        category: name.startsWith("principle-") ? "principle" : "workflow",
      };
    });

  return skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Read every playbook and return its filename and heading. */
export function collectPlaybooks() {
  if (!existsSync(PLAYBOOKS_DIR)) return [];
  return readdirSync(PLAYBOOKS_DIR)
    .filter((name) => name.endsWith(".md") && statSync(join(PLAYBOOKS_DIR, name)).isFile())
    .sort()
    .map((name) => {
      const text = readFileSync(join(PLAYBOOKS_DIR, name), "utf8");
      const heading = /^#{2,4}[ \t]+(.+?)[ \t]*$/m.exec(text)?.[1]?.trim();
      return { file: name, title: heading ?? name.replace(/\.md$/, "") };
    });
}

/** Render docs/skills.md. Deterministic for a given checkout. */
export function renderIndex() {
  const skills = collectSkills();
  const playbooks = collectPlaybooks();
  const workflows = skills.filter((skill) => skill.category === "workflow");
  const principles = skills.filter((skill) => skill.category === "principle");

  const lines = [
    "# Skill index",
    "",
    "Generated by `scripts/docs-index.mjs` from `skills/*/SKILL.md`. Do not edit this file by hand. Run `node scripts/docs-index.mjs` after adding or renaming a skill, and commit the result.",
    "",
    `This index covers ${skills.length} skills: ${workflows.length} workflow skills and ${principles.length} principles. It also lists ${playbooks.length} playbooks under [\`skills/poteto-mode/playbooks/\`](../skills/poteto-mode/playbooks/).`,
    "",
    "Every bundled skill is registered. All but `setup-pstack` are hidden from the model catalog, so invoke one with `/skill:<name>` or read `skill://<name>`. Each entry sits under its category, workflow or principle, and links to the skill's `SKILL.md`. The description is the skill's own frontmatter description; a slash name inside it is a trigger phrase, not a command.",
    "",
    `## Workflow skills (${workflows.length})`,
    "",
    ...workflows.map((skill) => `- [\`${skill.name}\`](../skills/${skill.name}/SKILL.md) - ${skill.description}`),
    "",
    `## Principles (${principles.length})`,
    "",
    ...principles.map((skill) => `- [\`${skill.name}\`](../skills/${skill.name}/SKILL.md) - ${skill.description}`),
    "",
    `## Playbooks (${playbooks.length})`,
    "",
    "A playbook is the step list `/poteto-mode` copies into the todo list. The routing table lives in [`poteto-mode`](../skills/poteto-mode/SKILL.md).",
    "",
    ...playbooks.map(
      (playbook) => `- [\`${playbook.file.replace(/\.md$/, "")}\`](../skills/poteto-mode/playbooks/${playbook.file}) - ${playbook.title}`,
    ),
    "",
  ];

  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown[0]}\nUsage: node scripts/docs-index.mjs [--check]`);
    return 2;
  }

  const expected = renderIndex();

  if (check) {
    if (!existsSync(INDEX_PATH)) {
      console.error(`docs/skills.md is missing. Run: node scripts/docs-index.mjs`);
      return 1;
    }
    const actual = readFileSync(INDEX_PATH, "utf8");
    if (actual !== expected) {
      const actualLines = actual.split("\n");
      const expectedLines = expected.split("\n");
      const limit = Math.max(actualLines.length, expectedLines.length);
      for (let index = 0; index < limit; index += 1) {
        if (actualLines[index] !== expectedLines[index]) {
          console.error(`docs/skills.md is stale at line ${index + 1}.`);
          console.error(`  committed: ${JSON.stringify(actualLines[index] ?? "")}`);
          console.error(`  generated: ${JSON.stringify(expectedLines[index] ?? "")}`);
          break;
        }
      }
      console.error("Run: node scripts/docs-index.mjs");
      return 1;
    }
    console.log("docs/skills.md is current.");
    return 0;
  }

  writeFileSync(INDEX_PATH, expected);
  console.log("Wrote docs/skills.md.");
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main(process.argv);
}
