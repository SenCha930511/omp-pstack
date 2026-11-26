import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const root = path.resolve(import.meta.dir, "..");
const seen = new Set<string>();
const offenders: Array<{ file: string; spec: string }> = [];

function resolveRelative(fromDir: string, spec: string): string {
  const base = path.resolve(fromDir, spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  const stem = base.replace(/\.(?:js|mjs|cjs)$/u, "");
  for (const ext of [".ts", ".mts", ".mjs", ".js"]) {
    if (fs.existsSync(`${stem}${ext}`) && fs.statSync(`${stem}${ext}`).isFile()) {
      return `${stem}${ext}`;
    }
  }
  return base;
}

function walk(file: string): void {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  const code = fs.readFileSync(resolved, "utf8");
  for (const item of transpiler.scanImports(code)) {
    const spec = item.path;
    if (spec.startsWith("node:")) continue;
    if (!spec.startsWith(".") && !path.isAbsolute(spec)) {
      offenders.push({ file: path.relative(root, resolved).replaceAll("\\", "/"), spec });
      continue;
    }
    const next = resolveRelative(path.dirname(resolved), spec);
    if (next.endsWith(".ts") || next.endsWith(".mts") || next.endsWith(".mjs")) walk(next);
  }
}

walk(path.join(root, "extensions", "pstack", "index.ts"));

const files = [...seen].map((file) => path.relative(root, file).replaceAll("\\", "/")).sort();
assert.deepEqual(files, [
  "extensions/pstack/index.ts",
  "extensions/pstack/interaction.ts",
]);
assert.deepEqual(
  offenders,
  [],
  `Runtime bare package imports are forbidden (omp-pstack has zero runtime dependencies): ${JSON.stringify(offenders)}`,
);

const entryUrl = pathToFileURL(path.join(root, "extensions", "pstack", "index.ts")).href;
const mod = await import(entryUrl);
assert.equal(typeof mod.default, "function", "extensions/pstack/index.ts must default-export the extension function");

console.log(`Load-time graph (${files.join(", ")}) has zero runtime package imports and imports cleanly: PASS`);
