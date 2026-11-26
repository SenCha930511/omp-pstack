import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ackUpstream } from "./sync-ack.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./sync-ack.mjs", import.meta.url));
const OLD_CURSOR_SHA = "1".repeat(40);
const OLD_PI_MIMIR_SHA = "2".repeat(40);
const NEW_CURSOR_SHA = "a".repeat(40);
const NEW_PI_MIMIR_SHA = "b".repeat(40);

const TEMP_DIRS = [];

function createRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-ack-test-"));
  TEMP_DIRS.push(dir);
  fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github", "upstream-sync.json"),
    `${JSON.stringify(
      {
        cursor: {
          repo: "cursor/plugins",
          lastSyncedSha: OLD_CURSOR_SHA,
        },
        piMimir: {
          repo: "casualjim/pi-mimir",
          lastCheckedSha: OLD_PI_MIMIR_SHA,
        },
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8"));
}

after(() => {
  for (const dir of TEMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updates both SHAs, preserves unrelated fields, and ends with a newline", () => {
  const root = createRoot();
  ackUpstream({ root, cursor: NEW_CURSOR_SHA, piMimir: NEW_PI_MIMIR_SHA });

  const raw = fs.readFileSync(path.join(root, ".github", "upstream-sync.json"), "utf8");
  assert.ok(raw.endsWith("\n"));
  const config = JSON.parse(raw);
  assert.equal(config.cursor.lastSyncedSha, NEW_CURSOR_SHA);
  assert.equal(config.piMimir.lastCheckedSha, NEW_PI_MIMIR_SHA);
  assert.equal(config.cursor.repo, "cursor/plugins");
});

test("updates only cursor when pi-mimir is omitted", () => {
  const root = createRoot();
  ackUpstream({ root, cursor: NEW_CURSOR_SHA });

  const config = readConfig(root);
  assert.equal(config.cursor.lastSyncedSha, NEW_CURSOR_SHA);
  assert.equal(config.piMimir.lastCheckedSha, OLD_PI_MIMIR_SHA);
});

test("rejects a short SHA and a non-hex SHA", () => {
  const root = createRoot();
  assert.throws(() => ackUpstream({ root, cursor: "1".repeat(39) }), /full 40-character lowercase SHA/);
  assert.throws(() => ackUpstream({ root, cursor: "g".repeat(40) }), /full 40-character lowercase SHA/);
});

test("CLI writes the config and exits 0", () => {
  const root = createRoot();
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--root", root, "--cursor", NEW_CURSOR_SHA, "--pi-mimir", NEW_PI_MIMIR_SHA],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(NEW_CURSOR_SHA));
  assert.ok(result.stdout.includes(NEW_PI_MIMIR_SHA));
  const config = readConfig(root);
  assert.equal(config.cursor.lastSyncedSha, NEW_CURSOR_SHA);
  assert.equal(config.piMimir.lastCheckedSha, NEW_PI_MIMIR_SHA);
});
