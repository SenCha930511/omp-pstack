import { existsSync } from "node:fs";
import path from "node:path";

export function resolveOmpCommand(root) {
  if (process.env.OMP_PSTACK_OMP_COMMAND) return process.env.OMP_PSTACK_OMP_COMMAND;
  const localOmp = path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "omp.cmd" : "omp",
  );
  if (existsSync(localOmp)) return localOmp;
  return process.platform === "win32" ? "omp.cmd" : "omp";
}
