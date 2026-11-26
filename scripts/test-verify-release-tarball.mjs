import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./verify-release-tarball.mjs", import.meta.url));
const TEMP_DIRS = [];

function createTarballFixture(pkgJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-tarball-verify-"));
  TEMP_DIRS.push(dir);
  const stage = path.join(dir, "stage", "package");
  const out = path.join(dir, "dist");
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(pkgJson, null, 2)}\n`);
  const tgzName = `${pkgJson.name}-${pkgJson.version}.tgz`;
  execFileSync("tar", ["-czf", `../dist/${tgzName}`, "package"], {
    cwd: path.join(dir, "stage"),
  });
  return { dir, out, tgzPath: path.join(out, tgzName) };
}

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifies matching tarball metadata and writes github env", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const { dir, out, tgzPath } = createTarballFixture({
    name: "omp-pstack",
    version: "0.1.0",
    gitHead: head,
  });
  const envFile = path.join(dir, "github.env");
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--directory", out, "--tag", "v0.1.0", "--head", head, "--github-env", envFile],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `TARBALL=${tgzPath}\nNAME=omp-pstack\nVERSION=0.1.0\n`,
  );
});

test("rejects mismatched name, tag, gitHead, and unexpected tarball counts", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const { out, tgzPath } = createTarballFixture({
    name: "omp-pstack",
    version: "0.1.0",
    gitHead: head,
  });

  assert.equal(
    spawnSync(process.execPath, [SCRIPT, "--directory", out, "--tag", "v0.1.0", "--head", head, "--name", "wrong"], { encoding: "utf8" }).status,
    1,
  );
  assert.equal(
    spawnSync(process.execPath, [SCRIPT, "--directory", out, "--tag", "v0.1.1", "--head", head], { encoding: "utf8" }).status,
    1,
  );
  assert.equal(
    spawnSync(process.execPath, [SCRIPT, "--directory", out, "--tag", "v0.1.0", "--head", "deadbeef"], { encoding: "utf8" }).status,
    1,
  );

  fs.copyFileSync(tgzPath, path.join(out, "extra.tgz"));
  assert.equal(
    spawnSync(process.execPath, [SCRIPT, "--directory", out, "--tag", "v0.1.0", "--head", head], { encoding: "utf8" }).status,
    1,
  );

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-empty-dist-"));
  TEMP_DIRS.push(emptyDir);
  assert.equal(
    spawnSync(process.execPath, [SCRIPT, "--directory", emptyDir, "--tag", "v0.1.0", "--head", head], { encoding: "utf8" }).status,
    1,
  );
});
