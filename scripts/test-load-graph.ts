import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const transpiler = new Bun.Transpiler({ loader: "ts" });

function resolveRelative(fromDir: string, spec: string): string {
  const base = path.resolve(fromDir, spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  const stem = base.replace(/\.(?:js|mjs|cjs)$/u, "");
  for (const ext of [".ts", ".mts", ".mjs", ".js", ".cjs"]) {
    if (fs.existsSync(`${stem}${ext}`) && fs.statSync(`${stem}${ext}`).isFile()) {
      return `${stem}${ext}`;
    }
  }
  return base;
}

function scanGraph(entryFile: string, rootDir: string): { files: string[]; offenders: Array<{ file: string; spec: string }> } {
  const seen = new Set<string>();
  const offenders: Array<{ file: string; spec: string }> = [];

  function walk(file: string): void {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const code = fs.readFileSync(resolved, "utf8");
    for (const item of transpiler.scanImports(code)) {
      const spec = item.path;
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".") && !path.isAbsolute(spec)) {
        offenders.push({ file: path.relative(rootDir, resolved).replaceAll("\\", "/"), spec });
        continue;
      }
      const next = resolveRelative(path.dirname(resolved), spec);
      if (
        next.endsWith(".ts") ||
        next.endsWith(".mts") ||
        next.endsWith(".mjs") ||
        next.endsWith(".js") ||
        next.endsWith(".cjs")
      ) {
        walk(next);
      }
    }
  }

  walk(entryFile);
  return {
    files: [...seen].map((file) => path.relative(rootDir, file).replaceAll("\\", "/")).sort(),
    offenders,
  };
}

const root = path.resolve(import.meta.dir, "..");
const graph = scanGraph(path.join(root, "extensions", "pstack", "index.ts"), root);
assert.deepEqual(graph.files, [
  "extensions/pstack/index.ts",
  "extensions/pstack/install.ts",
  "extensions/pstack/interaction.ts",
]);
assert.deepEqual(
  graph.offenders,
  [],
  `Runtime bare package imports are forbidden (omp-pstack has zero runtime dependencies): ${JSON.stringify(graph.offenders)}`,
);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pstack-graph-"));
try {
  fs.mkdirSync(path.join(fixture, "nested"));
  fs.writeFileSync(path.join(fixture, "index.ts"), 'import "./nested/deep.js";\n');
  fs.writeFileSync(path.join(fixture, "nested", "deep.js"), 'import "left-pad";\n');
  const nested = scanGraph(path.join(fixture, "index.ts"), fixture);
  assert.deepEqual(nested.files, ["index.ts", "nested/deep.js"]);
  assert.deepEqual(nested.offenders, [{ file: "nested/deep.js", spec: "left-pad" }]);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

const entryUrl = pathToFileURL(path.join(root, "extensions", "pstack", "index.ts")).href;
const mod = await import(entryUrl);
assert.equal(typeof mod.default, "function", "extensions/pstack/index.ts must default-export the extension function");

console.log(`Load-time graph (${graph.files.join(", ")}) has zero runtime package imports and imports cleanly: PASS`);
