import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const USAGE =
  "Usage: node scripts/sync-ack.mjs (--cursor <sha> [--pi-mimir <sha>] [--adapt <skill> ...] | --adapt-only --adapt <skill> ...) [--root <dir>]";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const options = {
    root: path.resolve(path.dirname(SCRIPT_PATH), ".."),
    cursor: undefined,
    piMimir: undefined,
    adapt: [],
    adaptOnly: false,
  };
  const seen = new Set();
  const singleFlags = new Set(["--root", "--cursor", "--pi-mimir"]);
  const multiFlags = new Set(["--adapt"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--adapt-only") {
      if (seen.has(argument)) throw new Error("--adapt-only may be supplied only once");
      seen.add(argument);
      options.adaptOnly = true;
      continue;
    }
    if (!singleFlags.has(argument) && !multiFlags.has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (singleFlags.has(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`);
      seen.add(argument);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value`);
    index += 1;
    if (argument === "--root") options.root = path.resolve(value);
    else if (argument === "--cursor") options.cursor = value.trim();
    else if (argument === "--pi-mimir") options.piMimir = value.trim();
    else options.adapt.push(value.trim());
  }
  if (options.adaptOnly) {
    if (options.cursor !== undefined || options.piMimir !== undefined) {
      throw new Error("--adapt-only cannot be combined with --cursor or --pi-mimir");
    }
    if (options.adapt.length === 0) {
      throw new Error("--adapt-only requires at least one --adapt <skill>");
    }
  } else if (!options.cursor) {
    throw new Error("--cursor is required unless --adapt-only is set");
  }
  return options;
}

function assertSha(flag, sha) {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${flag} must be a full 40-character lowercase SHA: ${sha}`);
  }
}

function validateAdaptedSkill(root, rawSkill) {
  const skill = rawSkill.trim();
  if (!skill) throw new Error("--adapt requires a nonempty skill name");
  if (path.basename(skill) !== skill || skill === "." || skill === ".." || /[\\/<>:*?"|]/.test(skill)) {
    throw new Error(`invalid skill name for --adapt: ${skill}`);
  }
  const skillFile = path.join(root, "skills", skill, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`adapted skill does not exist locally: skills/${skill}/SKILL.md`);
  }
  return skill;
}

export function ackUpstream({ root, cursor, piMimir, adapt = [], adaptOnly = false }) {
  if (adaptOnly) {
    if (cursor !== undefined || piMimir !== undefined) {
      throw new Error("--adapt-only cannot be combined with --cursor or --pi-mimir");
    }
    if (adapt.length === 0) {
      throw new Error("--adapt-only requires at least one --adapt <skill>");
    }
  } else {
    if (!cursor) throw new Error("--cursor is required unless --adapt-only is set");
    assertSha("--cursor", cursor);
    if (piMimir !== undefined) assertSha("--pi-mimir", piMimir);
  }

  const configPath = path.join(root, ".github", "upstream-sync.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (piMimir !== undefined && !config.piMimir) {
    throw new Error("--pi-mimir requires piMimir in .github/upstream-sync.json");
  }

  if (!adaptOnly) {
    config.cursor.lastSyncedSha = cursor;
    if (piMimir !== undefined) config.piMimir.lastCheckedSha = piMimir;
  }
  if (adapt.length > 0) {
    const merged = new Set(config.cursor.adaptedSkills ?? []);
    for (const rawSkill of adapt) {
      merged.add(validateAdaptedSkill(root, rawSkill));
    }
    config.cursor.adaptedSkills = [...merged].sort();
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const { root, cursor, piMimir, adapt, adaptOnly } = parseArgs(process.argv.slice(2));
    ackUpstream({ root, cursor, piMimir, adapt, adaptOnly });
    if (!adaptOnly) console.log(`cursor.lastSyncedSha: ${cursor}`);
    if (!adaptOnly && piMimir !== undefined) console.log(`piMimir.lastCheckedSha: ${piMimir}`);
    if (adapt.length > 0) console.log(`cursor.adaptedSkills added: ${adapt.join(", ")}`);
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    process.exitCode = 2;
  }
}
