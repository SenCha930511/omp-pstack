import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const UPSTREAM_SCHEMA = "omp-pstack.upstream/1";
export const UPSTREAM_SOURCE_PREFIX = "pstack/skills/";
export const UPSTREAM_TARGET_PREFIX = "skills/";
export const UPSTREAM_RULES = new Set(["verbatim", "local", "excluded"]);
export const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return crypto.createHash("sha1").update(header).update(bytes).digest("hex");
}

export function localFileMode(filePath) {
  if (process.platform === "win32") return undefined;
  return (fs.statSync(filePath).mode & 0o111) !== 0 ? "100755" : "100644";
}

export function collectFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, base));
    } else {
      results.push({
        relative: path.relative(base, fullPath).replaceAll("\\", "/"),
        fullPath,
      });
    }
  }
  return results.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

export function targetForSource(source) {
  if (!source.startsWith(UPSTREAM_SOURCE_PREFIX)) {
    throw new Error(`upstream source must start with ${UPSTREAM_SOURCE_PREFIX}: ${source}`);
  }
  return `${UPSTREAM_TARGET_PREFIX}${source.slice(UPSTREAM_SOURCE_PREFIX.length)}`;
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readManifest(root) {
  return readJson(path.join(root, "upstream.json"));
}

export function writeManifest(root, manifest) {
  fs.writeFileSync(path.join(root, "upstream.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function readSyncConfig(root) {
  return readJson(path.join(root, ".github", "upstream-sync.json"));
}

export function writeSyncConfig(root, config) {
  fs.writeFileSync(
    path.join(root, ".github", "upstream-sync.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

export function entryForTarget(entries, target) {
  return entries.find((entry) => entry.target === target);
}

export function entryForSource(entries, source) {
  return entries.find((entry) => entry.source === source);
}
