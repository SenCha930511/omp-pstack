import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_NAME,
  expectedAgentNames,
  packAndInstall,
  readPackageFiles,
  readProof,
  registerInstall,
  validateProof,
} from "./install-proof.mjs";
import { verifyInstall } from "./verify-install.mjs";

const USAGE = "Usage: node scripts/verify-install-proof.mjs [--discovery] [--root <dir>]";

function parseArgs(argv) {
  const options = { discovery: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--discovery") {
      if (options.discovery) throw new Error("--discovery may be supplied only once");
      options.discovery = true;
      continue;
    }
    if (argument !== "--root") throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--root requires a nonempty value");
    index += 1;
    options.root = path.resolve(value);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageFiles = await readPackageFiles(options.root);
  const proof = readProof(options.root);

  let observations;
  let temporary;
  if (options.discovery) {
    temporary = await mkdtemp(path.join(tmpdir(), "omp-pstack-proof-check-"));
    try {
      const packed = await packAndInstall(options.root, temporary);
      const home = path.join(temporary, "home");
      const agentDir = path.join(home, "agent");
      const projectDir = path.join(temporary, "project");
      await mkdir(agentDir, { recursive: true });
      await mkdir(projectDir, { recursive: true });
      await registerInstall({
        root: options.root,
        installedRoot: packed.installedRoot,
        home,
        agentDir,
        cwd: projectDir,
      });
      observations = await verifyInstall({
        sourceRoot: options.root,
        installedRoot: packed.installedRoot,
        home,
        agentDir,
        packageName: PACKAGE_NAME,
        projectDir,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  const result = validateProof({
    root: options.root,
    proof,
    packageFiles,
    observations,
    agentNames: expectedAgentNames(options.root),
  });
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Install proof ${proof.package.name}@${proof.package.version}: ${proof.inputs.length} inputs, ${packageFiles.length} package files${options.discovery ? ", live discovery" : ""}: PASS`,
  );
}

try {
  await main();
} catch (error) {
  console.error(USAGE);
  console.error(error.message);
  process.exitCode = 2;
}
