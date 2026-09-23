import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "c12";
import { loadFile, writeFile } from "magicast";
import type { ApiEntry, ApiweldConfig } from "./define-config.js";
import { ApiweldError } from "./errors.js";
import { projectPaths, type Runtime } from "./paths.js";

export async function loadProjectConfig(cwd: string): Promise<ApiweldConfig> {
  const file = projectPaths(cwd).config;
  if (!fs.existsSync(file)) {
    throw new ApiweldError("No apiweld.config.ts. Run `apiweld init` first.");
  }
  const alias = apiweldAlias();
  const loaded = await loadConfig<ApiweldConfig>({
    name: "apiweld",
    cwd,
    configFile: "apiweld.config",
    globalRc: false,
    dotenv: false,
    packageJson: false,
    jitiOptions: alias ? { alias } : undefined,
  });
  const config = loaded.config;
  if (!config?.apis || typeof config.apis !== "object") {
    throw new ApiweldError("apiweld.config.ts must default-export an object with apis");
  }
  return config;
}

function apiweldAlias(): Record<string, string> | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "packages", "apiweld", "src", "index.ts");
    if (fs.existsSync(candidate)) return { apiweld: candidate };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function editApiEntry(
  cwd: string,
  api: string,
  update: (current: ApiEntry | undefined) => ApiEntry | undefined,
): Promise<{ edited: boolean; snippet?: string }> {
  const file = projectPaths(cwd).config;
  const raw = fs.readFileSync(file, "utf8");
  const snippet = renderSnippet(api, update(undefined));
  if (hasSpread(raw)) return { edited: false, snippet };
  try {
    const mod = await loadFile(file);
    let target = mod.exports.default as { $type?: string; $args?: unknown[] } & Record<string, unknown>;
    if (target?.$type === "function-call") {
      target = (target.$args?.[0] ?? {}) as typeof target;
    }
    if (!target || typeof target !== "object") return { edited: false, snippet };
    const apis = (target.apis ?? {}) as Record<string, ApiEntry>;
    target.apis = apis;
    const current = plainEntry(apis[api]);
    const next = update(current);
    if (!next) delete apis[api];
    else apis[api] = definedEntry(next);
    await writeFile(mod, file);
    return { edited: true };
  } catch {
    return { edited: false, snippet };
  }
}

function definedEntry(entry: ApiEntry): ApiEntry {
  const next: ApiEntry = { source: entry.source, operations: entry.operations };
  if (entry.policy !== undefined) next.policy = entry.policy;
  if (entry.patch !== undefined) next.patch = entry.patch;
  if (entry.levelOverrides !== undefined) next.levelOverrides = entry.levelOverrides;
  if (entry.allowRemoteHosts !== undefined) next.allowRemoteHosts = entry.allowRemoteHosts;
  return next;
}

function plainEntry(entry: ApiEntry | undefined): ApiEntry | undefined {
  if (!entry) return undefined;
  const operations = Array.isArray(entry.operations) ? [...entry.operations] : [];
  return {
    source: String(entry.source ?? ""),
    operations,
    policy: entry.policy,
    patch: entry.patch,
    levelOverrides: entry.levelOverrides,
    allowRemoteHosts: entry.allowRemoteHosts,
  };
}

function hasSpread(source: string): boolean {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return withoutComments.includes("...");
}

function renderSnippet(api: string, entry: ApiEntry | undefined): string {
  if (!entry) return `delete apis[${JSON.stringify(api)}]`;
  return `${JSON.stringify(api)}: ${JSON.stringify(
    { source: entry.source, operations: [...entry.operations].sort(), policy: entry.policy ?? { autoRegenerate: "safe" } },
    null,
    2,
  )},`;
}

export function writeOperationTypes(cwd: string, apis: Record<string, string[]>): void {
  const lines = [
    "import \"apiweld\";",
    "",
    "declare module \"apiweld\" {",
    "  interface ApiOperationMap {",
  ];
  for (const api of Object.keys(apis).sort()) {
    const ops = [...(apis[api] ?? [])].sort();
    const type = ops.length > 0 ? ops.map((op) => JSON.stringify(op)).join(" | ") : "never";
    lines.push(`    ${JSON.stringify(api)}: ${type};`);
  }
  lines.push("  }", "}", "");
  fs.writeFileSync(projectPaths(cwd).operationsTypes, lines.join("\n"));
}

export function outputDir(rt: Runtime, config: ApiweldConfig, api: string): string {
  return path.join(rt.cwd, config.output ?? "src/apis", api);
}
