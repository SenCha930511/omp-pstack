import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const USAGE = "Usage: node scripts/sync-ack.mjs --cursor <sha> [--pi-mimir <sha>] [--root <dir>]";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const options = {
    root: path.resolve(path.dirname(SCRIPT_PATH), ".."),
    cursor: undefined,
    piMimir: undefined,
  };
  const seen = new Set();
  const valueFlags = new Set(["--root", "--cursor", "--pi-mimir"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!valueFlags.has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value`);
    index += 1;
    if (argument === "--root") options.root = path.resolve(value);
    else if (argument === "--cursor") options.cursor = value.trim();
    else options.piMimir = value.trim();
  }
  if (!options.cursor) throw new Error("--cursor is required");
  return options;
}

function assertSha(flag, sha) {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${flag} must be a full 40-character lowercase SHA: ${sha}`);
  }
}

export function ackUpstream({ root, cursor, piMimir }) {
  assertSha("--cursor", cursor);
  if (piMimir !== undefined) assertSha("--pi-mimir", piMimir);

  const configPath = path.join(root, ".github", "upstream-sync.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (piMimir !== undefined && !config.piMimir) {
    throw new Error("--pi-mimir requires piMimir in .github/upstream-sync.json");
  }

  config.cursor.lastSyncedSha = cursor;
  if (piMimir !== undefined) config.piMimir.lastCheckedSha = piMimir;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const { root, cursor, piMimir } = parseArgs(process.argv.slice(2));
    ackUpstream({ root, cursor, piMimir });
    console.log(`cursor.lastSyncedSha: ${cursor}`);
    if (piMimir !== undefined) console.log(`piMimir.lastCheckedSha: ${piMimir}`);
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    process.exitCode = 2;
  }
}
