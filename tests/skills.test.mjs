import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const skillsDir = join(root, "skills");
const skillNames = readdirSync(skillsDir).filter((name) => statSync(join(skillsDir, name)).isDirectory());

test("every skill has name and description frontmatter", () => {
  for (const name of skillNames) {
    const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    assert.match(text, /^---\n/, `${name}: missing frontmatter`);
    assert.match(text, new RegExp(`\\nname:\\s*${name}\\n`), `${name}: wrong frontmatter name`);
    assert.match(text, /\ndescription:\s*\S/, `${name}: missing description`);
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
  for (const name of skillNames) {
    const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${name}: stale reference ${pattern}`);
    }
  }
});

test("poteto-mode carries the omp header and path rule", () => {
  const text = readFileSync(join(skillsDir, "poteto-mode", "SKILL.md"), "utf8");
  assert.match(text, /Poteto Mode is active for this session/);
  assert.match(text, /SKILL-INDEX\.md/);
  assert.match(text, /do not use `skill:\/\//i);
});
