import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  PROOF_COMMAND,
  PROOF_SCHEMA,
  canonicalPackageJsonHash,
  sha256File,
  validateProof,
} from "./install-proof.mjs";

const TEMP_DIRS = [];

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function makeFixture({ packageJson, files, packageFiles, proof = {} } = {}) {
  const root = makeTemp("omp-pstack-proof-test-");
  const pkg = {
    name: "omp-pstack",
    version: "1.2.3",
    files: ["skills/"],
    ...packageJson,
  };
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [relative, content] of Object.entries(files ?? { "skills/a/SKILL.md": "a\n" })) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const packed = packageFiles ?? ["package.json", ...Object.keys(files ?? { "skills/a/SKILL.md": "a\n" })];
  const inputs = packed
    .map((relative) => ({
      path: relative,
      sha256:
        relative === "package.json"
          ? canonicalPackageJsonHash(root)
          : sha256File(path.join(root, relative)),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const baseProof = {
    schema: PROOF_SCHEMA,
    ok: true,
    command: PROOF_COMMAND,
    package: { name: pkg.name, version: pkg.version },
    inputs,
    observations: {
      packageFileCount: packed.length,
      discoveredSkillNames: ["a"],
      discoveredAgentNames: ["agent"],
      extensionCount: 1,
      runtimeDependencyNames: [],
    },
    hostConstraints: {
      source: "package-lock.json",
      expectedMajorMinor: "19.2",
      informationalOnly: true,
    },
    channels: ["npm-tarball"],
    limitations: ["Not a live model eval."],
    ...proof,
  };
  return { root, pkg, packed, proof: baseProof };
}

test("accepts a bounded proof with matching inputs", () => {
  const fixture = makeFixture();
  const result = validateProof({ root: fixture.root, proof: fixture.proof, packageFiles: fixture.packed });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("rejects an unknown schema and a package version mismatch", () => {
  const fixture = makeFixture();
  const schema = validateProof({
    root: fixture.root,
    proof: { ...fixture.proof, schema: "omp-pstack.install-proof/9" },
    packageFiles: fixture.packed,
  });
  assert.equal(schema.ok, false);
  assert.ok(schema.errors.some((error) => error.includes("schema must be")));

  const version = validateProof({
    root: fixture.root,
    proof: { ...fixture.proof, package: { name: "omp-pstack", version: "9.9.9" } },
    packageFiles: fixture.packed,
  });
  assert.equal(version.ok, false);
  assert.ok(version.errors.some((error) => error.includes("package.version")));
});

test("rejects changed bytes and a missing input file", () => {
  const fixture = makeFixture();
  fs.writeFileSync(path.join(fixture.root, "skills/a/SKILL.md"), "changed\n");
  const changed = validateProof({ root: fixture.root, proof: fixture.proof, packageFiles: fixture.packed });
  assert.equal(changed.ok, false);
  assert.ok(changed.errors.some((error) => error.includes("hash mismatch for skills/a/SKILL.md")));

  fs.rmSync(path.join(fixture.root, "skills/a/SKILL.md"));
  const missing = validateProof({ root: fixture.root, proof: fixture.proof, packageFiles: fixture.packed });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("file does not exist")));
});

test("rejects a package file without a proof input and forged counts", () => {
  const fixture = makeFixture();
  const wrongList = validateProof({
    root: fixture.root,
    proof: fixture.proof,
    packageFiles: [...fixture.packed, "skills/b/SKILL.md"],
  });
  assert.equal(wrongList.ok, false);
  assert.ok(wrongList.errors.some((error) => error.includes("package file has no proof input")));

  const forged = validateProof({
    root: fixture.root,
    proof: {
      ...fixture.proof,
      observations: { ...fixture.proof.observations, packageFileCount: 99 },
    },
    packageFiles: fixture.packed,
  });
  assert.equal(forged.ok, false);
  assert.ok(forged.errors.some((error) => error.includes("packageFileCount")));
});

test("gitHead and devDependencies are outside the canonical hash", () => {
  const fixture = makeFixture();
  const before = canonicalPackageJsonHash(fixture.root);
  const pkg = JSON.parse(fs.readFileSync(path.join(fixture.root, "package.json"), "utf8"));
  pkg.gitHead = "a".repeat(40);
  pkg.devDependencies = { typescript: "9.9.9" };
  fs.writeFileSync(path.join(fixture.root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  assert.equal(canonicalPackageJsonHash(fixture.root), before);

  pkg.files = ["agents/"];
  fs.writeFileSync(path.join(fixture.root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  assert.notEqual(canonicalPackageJsonHash(fixture.root), before);
});

test("rejects observations that differ from the live discovery", () => {
  const fixture = makeFixture();
  const result = validateProof({
    root: fixture.root,
    proof: fixture.proof,
    packageFiles: fixture.packed,
    observations: {
      discoveredSkillNames: ["other"],
      discoveredAgentNames: ["agent"],
      extensionCount: 1,
      runtimeDependencyNames: [],
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("observations.discoveredSkillNames")));
});
