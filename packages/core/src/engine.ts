import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiweldError } from "./errors.js";

export interface EngineOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  auth?: string;
}

export interface EngineFinding {
  id: string;
  level: string;
  text: string;
  operation?: string;
  operationId?: string;
  path?: string;
  section?: string;
}

interface EngineResponse {
  ok: boolean;
  error?: string;
  engine?: string;
  specVersion?: string;
  openapi?: string;
  title?: string;
  bytes?: number;
  out?: string;
  operations?: EngineOperation[];
  findings?: EngineFinding[];
}

const require = createRequire(import.meta.url);

export function resolveEnginePath(): string {
  if (process.env.APIWELD_ENGINE_PATH && fs.existsSync(process.env.APIWELD_ENGINE_PATH)) {
    return process.env.APIWELD_ENGINE_PATH;
  }
  const name = platformPackage();
  if (name) {
    try {
      const pkgJson = require.resolve(`${name}/package.json`);
      const bin = path.join(
        path.dirname(pkgJson),
        "bin",
        process.platform === "win32" ? "apiweld-engine.exe" : "apiweld-engine",
      );
      if (fs.existsSync(bin)) return bin;
    } catch {
      // Optional platform package is absent until the release workflow publishes it.
    }
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "engine", "bin", binaryName());
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ApiweldError(
    "apiweld-engine binary not found. Run `bun run engine:build` or set APIWELD_ENGINE_PATH.",
  );
}

function binaryName(): string {
  return process.platform === "win32" ? "apiweld-engine.exe" : "apiweld-engine";
}

function platformPackage(): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  const map: Record<string, string> = {
    "darwin-arm64": "@apiweld/engine-darwin-arm64",
    "darwin-x64": "@apiweld/engine-darwin-x64",
    "linux-x64": "@apiweld/engine-linux-x64",
    "linux-arm64": "@apiweld/engine-linux-arm64",
    "win32-x64": "@apiweld/engine-win32-x64",
  };
  return map[key];
}

export async function runEngine(request: Record<string, unknown>): Promise<EngineResponse> {
  const bin = resolveEnginePath();
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  child.stdin.end(JSON.stringify(request));
  const code = await exited;
  const text = Buffer.concat(stdout).toString("utf8").trim();
  let parsed: EngineResponse | undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as EngineResponse;
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed?.ok || code !== 0) {
    const detail = parsed?.error || Buffer.concat(stderr).toString("utf8").trim() || text;
    throw new ApiweldError(detail || `apiweld-engine exited ${code}`);
  }
  return parsed;
}

let engineLabel: string | undefined;

export async function engineVersion(): Promise<string> {
  if (!engineLabel) {
    const response = await runEngine({ command: "version" });
    engineLabel = response.engine ?? "apiweld-engine";
  }
  return engineLabel;
}
