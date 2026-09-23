import fs from "node:fs";
import path from "node:path";

export interface Workspace {
  root: string;
  patterns: string[];
  packages: string[];
}

export function findWorkspace(start: string): Workspace | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const found = readWorkspace(dir);
    if (found) return found;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readWorkspace(dir: string): Workspace | undefined {
  const fromPackage = packageWorkspaces(dir);
  if (fromPackage) return workspace(dir, fromPackage);
  const fromPnpm = pnpmWorkspaces(dir);
  if (fromPnpm) return workspace(dir, fromPnpm);
  return undefined;
}

function workspace(root: string, patterns: string[]): Workspace {
  return { root, patterns, packages: expandPackages(root, patterns) };
}

function packageWorkspaces(dir: string): string[] | undefined {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const workspaces = (parsed as { workspaces?: unknown }).workspaces;
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object" && Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages
      : undefined;
  if (!patterns) return undefined;
  const names = patterns.filter((pattern): pattern is string => typeof pattern === "string" && !pattern.startsWith("!"));
  return names.length > 0 ? names : undefined;
}

function pnpmWorkspaces(dir: string): string[] | undefined {
  const file = path.join(dir, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) return undefined;
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (!match?.[1]) continue;
    const pattern = match[1].trim();
    if (pattern && !pattern.startsWith("!")) patterns.push(pattern);
  }
  return patterns.length > 0 ? patterns : undefined;
}

function expandPackages(root: string, patterns: string[]): string[] {
  const matched: string[] = [];
  const withPackageJson: string[] = [];
  for (const pattern of patterns) {
    for (const dir of matchPattern(root, pattern.split("/").filter(Boolean))) {
      const rel = path.relative(root, dir).split(path.sep).join("/");
      matched.push(rel);
      if (fs.existsSync(path.join(dir, "package.json"))) withPackageJson.push(rel);
    }
  }
  return [...new Set(withPackageJson.length > 0 ? withPackageJson : matched)].sort();
}

function matchPattern(root: string, segments: string[]): string[] {
  let current = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of current) {
      if (segment === "**") {
        next.push(...descendants(dir, 4));
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || skipDir(entry.name)) continue;
        if (segment === "*" || entry.name === segment) next.push(path.join(dir, entry.name));
      }
    }
    current = next;
  }
  return current;
}

function descendants(dir: string, depth: number): string[] {
  if (depth < 0) return [];
  const found = [dir];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || skipDir(entry.name)) continue;
    found.push(...descendants(path.join(dir, entry.name), depth - 1));
  }
  return found;
}

function skipDir(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}
