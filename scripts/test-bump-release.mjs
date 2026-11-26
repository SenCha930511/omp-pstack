import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { planEdits, run } from "./bump-release.mjs";

const TEMP_DIRS = [];

function createFixture(version = "0.1.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-bump-"));
  TEMP_DIRS.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "omp-pstack", version, private: false }, null, 2)}\r\n`,
  );
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "omp-pstack",
        version,
        lockfileVersion: 3,
        packages: {
          "": { name: "omp-pstack", version },
        },
      },
      null,
      2,
    )}\r\n`,
  );
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0 - 2026-11-26\n\n- Initial.\n");
  return dir;
}

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bumps package.json and package-lock.json while preserving CRLF line endings", () => {
  const dir = createFixture("0.1.0");
  const code = run(["0.2.0", "--root", dir]);
  assert.equal(code, 0);

  const pkgText = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  const lockText = fs.readFileSync(path.join(dir, "package-lock.json"), "utf8");
  assert.ok(pkgText.includes("\r\n"), "expected CRLF preserved in package.json");
  assert.ok(lockText.includes("\r\n"), "expected CRLF preserved in package-lock.json");
  assert.equal(JSON.parse(pkgText).version, "0.2.0");
  assert.equal(JSON.parse(lockText).version, "0.2.0");
  assert.equal(JSON.parse(lockText).packages[""].version, "0.2.0");
});

test("rejects invalid and unchanged target versions", () => {
  const dir = createFixture("0.1.0");
  assert.equal(run(["0.1.0-rc.1", "--root", dir]), 2);
  assert.equal(run(["0.1.0", "--root", dir]), 1);
  assert.throws(() => planEdits(dir, "bad"), /invalid target version/);
});

test("rolls back modified files if a write or postcheck fails", () => {
  const dir = createFixture("0.1.0");
  const originalPkg = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  const originalLock = fs.readFileSync(path.join(dir, "package-lock.json"), "utf8");

  let writes = 0;
  const writeFail = run(["0.2.0", "--root", dir], {
    writeFile(file, bytes, options) {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
      fs.writeFileSync(file, bytes, options);
    },
  });
  assert.equal(writeFail, 1);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), originalPkg);
  assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), originalLock);

  let spawns = 0;
  const postcheckFail = run(["0.2.0", "--root", dir], {
    spawn() {
      spawns += 1;
      return { status: spawns === 1 ? 0 : 1, stdout: "", stderr: "postcheck failed\n" };
    },
  });
  assert.equal(postcheckFail, 1);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), originalPkg);
  assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), originalLock);
});
