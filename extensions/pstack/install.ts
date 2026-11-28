import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Anchor {
  skillFile: string;
  skillDir: string;
  usingFallback: boolean;
}

const PACKAGE_NAME = "omp-pstack";
const SKILL_NAME = "poteto-mode";
const SKILL_RELATIVE = path.join("skills", SKILL_NAME, "SKILL.md");
const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const VERSION_RE = /^[a-zA-Z0-9._+-]+$/;
const CACHE_SEGMENT_RE = /^(.+)___omp-pstack___([^/]+)$/;

function isNameSegment(value: string): boolean {
  return value.length > 0 && value.length <= 64 && NAME_RE.test(value);
}

function isVersion(value: string): boolean {
  return value.length > 0 && value.length <= 128 && VERSION_RE.test(value) && !value.includes("..");
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathIfExists(value: string): string | undefined {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return undefined;
  }
}

function hasPackageName(packageRoot: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return parsed?.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

function hasSkillName(skillFile: string): boolean {
  try {
    const text = fs.readFileSync(skillFile, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    return frontmatter !== undefined && new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, "m").test(frontmatter);
  } catch {
    return false;
  }
}

interface CacheIdentity {
  marketplace: string;
  version: string;
  pluginsRoot: string;
}

function parseCacheRoot(loadedRoot: string): CacheIdentity | undefined {
  const root = path.resolve(loadedRoot);
  const segment = path.basename(root);
  const match = CACHE_SEGMENT_RE.exec(segment);
  if (!match) return undefined;
  const [, marketplace, version] = match;
  if (!isNameSegment(marketplace) || !isVersion(version)) return undefined;
  const pluginsCacheDir = path.dirname(root);
  const cacheDir = path.dirname(pluginsCacheDir);
  const pluginsRoot = path.dirname(cacheDir);
  if (path.basename(pluginsCacheDir) !== "plugins" || path.basename(cacheDir) !== "cache") return undefined;
  return { marketplace, version, pluginsRoot };
}

function resolveMarketplaceCandidate(candidate: string, identity: CacheIdentity): string | undefined {
  const realCandidate = realpathIfExists(candidate);
  const realPluginsRoot = realpathIfExists(identity.pluginsRoot);
  if (!realCandidate || !realPluginsRoot) return undefined;
  if (!isWithin(realPluginsRoot, realCandidate)) return undefined;
  const segments = path.relative(realPluginsRoot, realCandidate).split(path.sep);
  if (segments.length !== 6) return undefined;
  if (segments[0] !== "cache" || segments[1] !== "plugins") return undefined;
  const target = segments[2];
  if (!target) return undefined;
  const targetMatch = CACHE_SEGMENT_RE.exec(target);
  if (!targetMatch) return undefined;
  const [, marketplace, version] = targetMatch;
  if (marketplace !== identity.marketplace || !isVersion(version)) return undefined;
  if (segments[3] !== "skills" || segments[4] !== SKILL_NAME || segments[5] !== "SKILL.md") return undefined;
  const packageRoot = path.join(realPluginsRoot, "cache", "plugins", target);
  return hasPackageName(packageRoot) && hasSkillName(realCandidate) ? realCandidate : undefined;
}

function discoveryCeilings(): Set<string> {
  const ceilings = new Set<string>();
  ceilings.add(normalizeForCompare(os.homedir()));
  ceilings.add(normalizeForCompare(os.tmpdir()));
  if (process.platform !== "win32") {
    ceilings.add(normalizeForCompare("/tmp"));
    ceilings.add(normalizeForCompare("/var/tmp"));
  }
  return ceilings;
}

function userConfigRoots(): Set<string> {
  const roots = new Set<string>();
  roots.add(normalizeForCompare(path.join(os.homedir(), ".omp")));
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) roots.add(normalizeForCompare(path.dirname(path.resolve(agentDir))));
  return roots;
}

function hasProjectInstallState(configDir: string): boolean {
  return (
    isFile(path.join(configDir, "plugins", "installed_plugins.json")) ||
    isFile(path.join(configDir, "skills.json"))
  );
}

function legacyProjectConfigDir(root: string): string | undefined {
  const name = process.env.PI_CONFIG_DIR;
  if (!name) return undefined;
  const dir = path.resolve(root, name);
  if (!isWithin(root, dir)) return undefined;
  if (userConfigRoots().has(normalizeForCompare(dir))) return undefined;
  return hasProjectInstallState(dir) ? dir : undefined;
}

interface ProjectLocation {
  root: string;
  configDir: string;
}

function findProjectLocation(cwd: string): ProjectLocation | undefined {
  const ceilings = discoveryCeilings();
  const userRoots = userConfigRoots();
  const start = path.resolve(cwd);

  let gitRoot: string | undefined;
  for (let dir = start; !ceilings.has(normalizeForCompare(dir)); dir = path.dirname(dir)) {
    if (isDirectory(path.join(dir, ".git"))) {
      gitRoot = dir;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }

  for (let dir = start; !ceilings.has(normalizeForCompare(dir)); dir = path.dirname(dir)) {
    if (userRoots.has(normalizeForCompare(path.join(dir, ".omp")))) break;
    const canonical = path.join(dir, ".omp");
    if (isDirectory(canonical)) {
      return hasProjectInstallState(canonical) ? { root: dir, configDir: canonical } : undefined;
    }
    const legacy = legacyProjectConfigDir(dir);
    if (legacy) return { root: dir, configDir: legacy };
    if (gitRoot !== undefined && normalizeForCompare(dir) === normalizeForCompare(gitRoot)) break;
    if (path.dirname(dir) === dir) break;
  }

  if (gitRoot !== undefined) {
    const canonical = path.join(gitRoot, ".omp");
    if (hasProjectInstallState(canonical)) return { root: gitRoot, configDir: canonical };
    const legacy = legacyProjectConfigDir(gitRoot);
    if (legacy) return { root: gitRoot, configDir: legacy };
  }
  return undefined;
}

function projectSkillCandidate(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const location = findProjectLocation(cwd);
  if (!location) return undefined;
  return path.join(location.configDir, "plugins", "node_modules", PACKAGE_NAME, SKILL_RELATIVE);
}

function userSkillCandidates(): string[] {
  const roots: string[] = [];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) roots.push(path.join(path.dirname(path.resolve(agentDir)), "plugins"));
  if (process.env.XDG_DATA_HOME) roots.push(path.join(process.env.XDG_DATA_HOME, "omp", "plugins"));
  roots.push(path.join(os.homedir(), ".omp", "plugins"));
  const unique = new Set<string>();
  for (const root of roots) {
    unique.add(path.join(root, "node_modules", PACKAGE_NAME, SKILL_RELATIVE));
  }
  return [...unique];
}

function anchorFor(skillFile: string, usingFallback: boolean): Anchor {
  return { skillFile, skillDir: path.dirname(skillFile), usingFallback };
}

/**
 * Resolve the Poteto Mode skill file for the current install.
 *
 * The loaded package wins while its file exists. Only a cache-installed package
 * whose own copy disappeared falls back, first to the project-scoped plugin link,
 * then to the user-scoped one. Every fallback must resolve back into the same
 * marketplace's cache entry and carry the expected package and skill names.
 */
export function resolvePotetoSkill(options: { loadedRoot: string; cwd?: string }): Anchor {
  const loadedRoot = path.resolve(options.loadedRoot);
  const primary = path.join(loadedRoot, SKILL_RELATIVE);
  if (isFile(primary)) return anchorFor(primary, false);

  const identity = parseCacheRoot(loadedRoot);
  if (!identity) return anchorFor(primary, false);

  const candidates = [projectSkillCandidate(options.cwd), ...userSkillCandidates()];
  for (const candidate of candidates) {
    if (!candidate || !isFile(candidate)) continue;
    const resolved = resolveMarketplaceCandidate(candidate, identity);
    if (resolved) return anchorFor(resolved, true);
  }
  return anchorFor(primary, false);
}
