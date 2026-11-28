import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_NAME,
  PROOF_COMMAND,
  PROOF_SCHEMA,
  collectInputs,
  expectedAgentNames,
  hostConstraints,
  observationsFromDiscovery,
  packAndInstall,
  registerInstall,
  proofJson,
} from "./install-proof.mjs";
import { verifyInstall } from "./verify-install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "omp-pstack-proof-"));
let succeeded = false;

try {
  const packed = await packAndInstall(root, temporary);
  const home = path.join(temporary, "home");
  const agentDir = path.join(home, "agent");
  const projectDir = path.join(temporary, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await registerInstall({
    root,
    installedRoot: packed.installedRoot,
    home,
    agentDir,
    cwd: projectDir,
  });

  const discovery = await verifyInstall({
    sourceRoot: root,
    installedRoot: packed.installedRoot,
    home,
    agentDir,
    packageName: PACKAGE_NAME,
    projectDir,
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const proof = {
    schema: PROOF_SCHEMA,
    ok: true,
    command: PROOF_COMMAND,
    package: { name: pkg.name, version: pkg.version },
    inputs: collectInputs(root, packed.files),
    observations: observationsFromDiscovery(discovery, packed.files.length, expectedAgentNames(root)),
    hostConstraints: hostConstraints(root),
    channels: ["npm-tarball"],
    limitations: [
      "Not a live model eval.",
      "Other platforms recheck their source inputs, not the canonical Linux report.",
      "The package is not proven against every possible host release.",
    ],
  };
  await mkdir(path.join(root, "proofs"), { recursive: true });
  await writeFile(path.join(root, "proofs", "install.json"), proofJson(proof));
  succeeded = true;
  console.log(
    `Install proof written: ${pkg.name}@${pkg.version}, ${packed.files.length} package files, ${discovery.discoveredSkillNames.length} skills.`,
  );
} catch (error) {
  try {
    await writeFile(
      path.join(temporary, "attempt.json"),
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
  } catch {
    // The attempt file is diagnostic only.
  }
  console.error(`Install proof failed; attempt kept at ${temporary}`);
  throw error;
} finally {
  if (succeeded) await rm(temporary, { recursive: true, force: true });
}
