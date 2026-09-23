import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Runtime {
  cwd: string;
  cacheDir: string;
  offline: boolean;
}

export function runtimeFrom(
  cwd: string,
  opts?: { offline?: boolean; cacheDir?: string },
): Runtime {
  const cacheDir =
    opts?.cacheDir ??
    process.env.APIWELD_CACHE_DIR ??
    path.join(os.homedir(), ".apiweld");
  const offline = opts?.offline ?? process.env.APIWELD_OFFLINE === "1";
  return { cwd: path.resolve(cwd), cacheDir, offline };
}

export function projectPaths(cwd: string) {
  return {
    config: path.join(cwd, "apiweld.config.ts"),
    lock: path.join(cwd, "apiweld.lock.json"),
    gitignore: path.join(cwd, ".gitignore"),
    agents: path.join(cwd, "AGENTS.md"),
    claude: path.join(cwd, "CLAUDE.md"),
    operationsTypes: path.join(cwd, "apiweld-env.d.ts"),
    dot: path.join(cwd, ".apiweld"),
    reports: path.join(cwd, ".apiweld", "reports"),
    driftLog: path.join(cwd, ".apiweld", "drift.log.jsonl"),
  };
}

export interface Settings {
  offline?: boolean;
  proxy?: string;
  catalogSnapshotUrl?: string;
  catalogSnapshotSha256?: string;
  catalogs?: Array<{ name: string; path?: string; urls?: string[] }>;
}

export function readSettings(cacheDir: string): Settings {
  const file = path.join(cacheDir, "settings.json");
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  return parsed ?? {};
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
