import {
  addCatalogApi,
  addOperations,
  ApiweldError,
  buildCatalog,
  checkApis,
  findWorkspace,
  generateLocked,
  healApi,
  initProject,
  loadProjectConfig,
  projectPaths,
  removeOperations,
  runtimeFrom,
  searchApis,
  searchOperations,
  showApi,
  syncCatalog,
  updateApis,
  verifyProject,
  type ChangeClass,
} from "@apiweld/core";
import { startMcp } from "@apiweld/mcp";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { defineCommand, renderUsage, runCommand, type CommandDef, type Resolvable } from "citty";
import { registerGenerators } from "./register.js";

registerGenerators();

const shared = {
  json: { type: "boolean" as const, description: "Print JSON" },
  offline: { type: "boolean" as const, description: "Use the local cache only" },
};

function runtime(cwd: string, offline?: boolean) {
  return runtimeFrom(cwd, { offline });
}

function extraPositionals(argv: string[], ...taken: Array<string | undefined>): string[] {
  const rest = [...argv];
  for (const value of taken) {
    if (!value) continue;
    const index = rest.indexOf(value);
    if (index >= 0) rest.splice(index, 1);
  }
  return rest;
}

function print(json: boolean, data: unknown, text: string): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else if (text) console.log(text);
}

const init = defineCommand({
  meta: { name: "init", description: "Create apiweld.config.ts and ignore .apiweld/" },
  args: {
    ...shared,
    agents: { type: "boolean", description: "Write agent instructions and an MCP snippet" },
    output: { type: "string", description: "Directory for generated clients, relative to this project" },
  },
  async run({ args }) {
    const rt = runtime(process.cwd(), args.offline);
    const creating = !fs.existsSync(projectPaths(rt.cwd).config);
    const output = args.output ?? (creating && !args.json ? await promptForOutput(rt.cwd) : undefined);
    const result = await initProject(rt, { agents: args.agents, output });
    print(args.json, result, `Created:\n${result.created.join("\n") || "(already initialized)"}`);
    return { exitCode: 0 };
  },
});

async function promptForOutput(cwd: string): Promise<string | undefined> {
  const workspace = findWorkspace(cwd);
  if (!workspace) return undefined;
  const packages = workspace.packages.slice(0, 20);
  const more = workspace.packages.length - packages.length;
  console.log(`Workspace ${workspace.root}`);
  if (packages.length > 0) {
    console.log("Packages:");
    for (const name of packages) console.log(`  ${name}`);
    if (more > 0) console.log(`  … ${more} more`);
  }
  console.log(`Generated clients are written under the output directory, relative to ${cwd}.`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("No terminal prompt. Using src/apis. Pass --output to choose a directory.");
    return "src/apis";
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Output directory [src/apis]: ");
    return answer.trim() || "src/apis";
  } finally {
    rl.close();
  }
}

const catalogBuild = defineCommand({
  meta: { name: "build", description: "Build the local catalog from a manifest, directory, or APIs.guru" },
  args: { ...shared, from: { type: "string", description: "Manifest or directory of specs" } },
  async run({ args }) {
    const result = await buildCatalog(runtime(process.cwd(), args.offline), { from: args.from });
    print(args.json, result, `Indexed ${result.apis} APIs and ${result.operations} operations.`);
    return { exitCode: 0 };
  },
});

const catalogAdd = defineCommand({
  meta: { name: "add", description: "Index one provider spec into the local catalog" },
  args: {
    ...shared,
    id: { type: "positional", required: true, description: "Provider id, such as stripe" },
    url: { type: "positional", required: true, description: "OpenAPI spec URL" },
  },
  async run({ args }) {
    const result = await addCatalogApi(runtime(process.cwd(), args.offline), { id: args.id, url: args.url });
    print(
      args.json,
      result,
      `Indexed ${result.id} (${result.title}): ${result.operations} operations.`,
    );
    return { exitCode: 0 };
  },
});

const catalogSync = defineCommand({
  meta: { name: "sync", description: "Download a catalog snapshot and verify its checksum" },
  args: {
    ...shared,
    url: { type: "string", description: "Snapshot URL or file: path" },
    sha256: { type: "string", description: "Expected SHA-256" },
  },
  async run({ args }) {
    const result = await syncCatalog(runtime(process.cwd(), args.offline), { url: args.url, sha256: args.sha256 });
    print(args.json, result, `Catalog saved to ${result.path}`);
    return { exitCode: 0 };
  },
});

const catalog = defineCommand({
  meta: { name: "catalog", description: "Index provider specs locally" },
  subCommands: { add: catalogAdd, build: catalogBuild, sync: catalogSync },
});

const search = defineCommand({
  meta: { name: "search", description: "Search APIs or operations" },
  args: {
    ...shared,
    query: { type: "positional", required: true, description: "Search text" },
    ops: { type: "boolean", description: "Search operations" },
    api: { type: "string", description: "Limit operation search to one API" },
  },
  run({ args }) {
    const rt = runtime(process.cwd(), args.offline);
    if (args.ops) {
      const hits = searchOperations(rt.cacheDir, args.query, args.api);
      const text = hits
        .map((hit) => `${hit.api_id}  ${hit.method} ${hit.path}  ${hit.summary}`)
        .join("\n");
      print(args.json, hits, text || "No operations matched.");
      return { exitCode: 0 };
    }
    const hits = searchApis(rt.cacheDir, args.query);
    const text = hits
      .map((hit) => `${hit.id}  ${hit.title}  ${hit.spec_version}  auth via operations; updated ${hit.updated_at}`)
      .join("\n");
    print(args.json, hits, text || "No APIs matched.");
    return { exitCode: 0 };
  },
});

const show = defineCommand({
  meta: { name: "show", description: "Describe an API or one operation" },
  args: {
    ...shared,
    api: { type: "positional", required: true },
    operation: { type: "positional", description: "METHOD /path" },
    depth: { type: "string", description: "How far to expand nested types" },
  },
  async run({ args }) {
    const operation = args.operation;
    const result = await showApi(runtime(process.cwd(), args.offline), args.api, operation, Number(args.depth ?? 1));
    print(args.json, result, result.text);
    return { exitCode: 0 };
  },
});

const add = defineCommand({
  meta: { name: "add", description: "Add operations by operationId or METHOD /path and generate the client" },
  args: {
    ...shared,
    api: { type: "positional", required: true },
    source: { type: "string", description: "Spec URL, or file:, apisguru:, or wellknown: source" },
    as: { type: "string", description: "Config key to write" },
  },
  async run({ args }) {
    const operations = extraPositionals(args._, args.api);
    if (operations.length === 0) throw new ApiweldError("Pass at least one \"METHOD /path\" operation");
    const result = await addOperations(runtime(process.cwd(), args.offline), {
      api: args.api,
      as: args.as,
      source: args.source,
      operations,
    });
    print(
      args.json,
      result,
      `Welded ${result.api}: ${result.operations.join(", ")}\nImport from ${result.importPath}`,
    );
    return { exitCode: 0 };
  },
});

const remove = defineCommand({
  meta: { name: "remove", description: "Remove operations and regenerate" },
  args: { ...shared, api: { type: "positional", required: true } },
  async run({ args }) {
    const result = await removeOperations(runtime(process.cwd(), args.offline), {
      api: args.api,
      operations: extraPositionals(args._, args.api),
    });
    print(args.json, result, `Updated ${result.api}: ${result.operations.join(", ") || "(no operations)"}`);
    return { exitCode: 0 };
  },
});

const generate = defineCommand({
  meta: { name: "generate", description: "Regenerate from the lockfile without fetching" },
  args: { ...shared, api: { type: "positional" } },
  async run({ args }) {
    const result = await generateLocked(runtime(process.cwd(), true), args.api);
    print(args.json, result, `Regenerated ${result.apis.join(", ")}`);
    return { exitCode: 0 };
  },
});

const check = defineCommand({
  meta: { name: "check", description: "Detect drift for selected operations" },
  args: {
    ...shared,
    api: { type: "positional" },
    "fail-on": { type: "string", description: "breaking or risky" },
  },
  async run({ args }) {
    const rt = runtime(process.cwd(), args.offline);
    const config = await loadProjectConfig(rt.cwd);
    const failOn = (args["fail-on"] as ChangeClass | undefined) ?? "breaking";
    const result = await checkApis(rt, {
      apis: config.apis,
      only: args.api,
      failOn,
      outputRoot: config.output ?? "src/apis",
    });
    const text = result.apis
      .map((api) => {
        if (!api.drift && !api.unusedChange && !api.outputEdited) return `${api.api}: no drift`;
        const findings = api.findings.map((finding) => `  ${finding.level}  ${finding.operation}  ${finding.id}\n    ${finding.detail}`).join("\n");
        const quiet = api.unusedChange && !api.drift ? `${api.api}: spec moved, selected operations unchanged` : "";
        return [quiet, findings].filter(Boolean).join("\n");
      })
      .join("\n");
    print(args.json, result, text);
    return { exitCode: result.fail ? 1 : 0 };
  },
});

const update = defineCommand({
  meta: { name: "update", description: "Fetch specs and regenerate when policy allows" },
  args: { ...shared, api: { type: "positional" } },
  async run({ args }) {
    const result = await updateApis(runtime(process.cwd(), args.offline), args.api);
    print(args.json, result, result.regenerated.length ? `Regenerated ${result.regenerated.join(", ")}` : "No safe updates.");
    return { exitCode: 0 };
  },
});

const heal = defineCommand({
  meta: { name: "heal", description: "Write a heal plan and optionally apply the new client" },
  args: {
    ...shared,
    api: { type: "positional", required: true },
    apply: { type: "boolean", description: "Write the regenerated client into the working tree" },
  },
  async run({ args }) {
    const plan = await healApi(runtime(process.cwd(), args.offline), args.api, { apply: args.apply });
    const text = plan.findings
      .map((finding) => `${finding.level} ${finding.operation} ${finding.id}\n  ${finding.detail}\n  ${finding.callSites.map((site) => `${site.file}:${site.line}`).join(", ") || "no call sites"}`)
      .join("\n");
    print(args.json, plan, text || "No findings.");
    return { exitCode: 0 };
  },
});

const verify = defineCommand({
  meta: { name: "verify", description: "Type-check the project and run the optional test command" },
  args: { ...shared },
  async run({ args }) {
    const result = await verifyProject(runtime(process.cwd(), args.offline));
    const text = result.typecheck.ok
      ? "typecheck passed"
      : result.typecheck.errors.map((error) => `${error.file}:${error.line} ${error.message}`).join("\n");
    print(args.json, result, text);
    return { exitCode: result.typecheck.ok && result.test?.ok !== false ? 0 : 1 };
  },
});

const mcp = defineCommand({
  meta: { name: "mcp", description: "Start the MCP server on stdio" },
  args: { ...shared },
  async run({ args }) {
    await startMcp(runtime(process.cwd(), args.offline));
    return { exitCode: 0 };
  },
});

export const main = defineCommand({
  meta: {
    name: "apiweld",
    version: "0.4.0",
    description: "Discover APIs, weld a typed client for the endpoints you call, and keep it in sync.",
  },
  subCommands: { init, catalog, search, show, add, remove, generate, update, check, heal, verify, mcp },
});

async function resolveValue<T>(input: Resolvable<T> | undefined): Promise<T | undefined> {
  if (typeof input === "function") return (input as () => T | Promise<T>)();
  return input as T | undefined;
}

function positionals(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "help" && arg !== "--help" && arg !== "-h" && !arg.startsWith("-"));
}

function isHelpRequest(argv: string[]): boolean {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return true;
  const command = argv.find((arg) => !arg.startsWith("-"));
  return command === "help";
}

async function usageTarget(argv: string[]): Promise<{ cmd: CommandDef; parent?: CommandDef }> {
  const names = positionals(argv);
  let cmd: CommandDef = main;
  let parent: CommandDef | undefined;
  for (const name of names) {
    const subs = await resolveValue(cmd.subCommands);
    const next = subs?.[name];
    if (!next) break;
    parent = cmd;
    cmd = (await resolveValue(next)) ?? cmd;
  }
  return { cmd, parent };
}

export async function execute(argv: string[]): Promise<number> {
  try {
    if (isHelpRequest(argv)) {
      const target = await usageTarget(argv);
      console.log(await renderUsage(target.cmd, target.parent));
      return 0;
    }
    const { result } = await runCommand(main, { rawArgs: argv });
    if (result && typeof result === "object" && "exitCode" in result) {
      return Number(result.exitCode) || 0;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const json = argv.includes("--json");
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else {
      if (error instanceof Error && error.name === "CLIError") {
        const target = await usageTarget(argv);
        console.error(await renderUsage(target.cmd, target.parent));
      }
      console.error(message);
    }
    return error instanceof ApiweldError ? error.exitCode : 1;
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const code = await execute(argv);
  process.exit(code);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) void runCli();
