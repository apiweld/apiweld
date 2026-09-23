import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const exec = promisify(execFile);

export interface TypeDiagnostic {
  file: string;
  line: number;
  code: string;
  message: string;
  symbol?: string;
}

export function typecheckProject(cwd: string): TypeDiagnostic[] {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return [];
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return [];
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file)
    .map((diagnostic) => {
      const file = diagnostic.file as ts.SourceFile;
      const position = diagnostic.start ?? 0;
      const location = file.getLineAndCharacterOfPosition(position);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      const symbol = message.match(/'([A-Za-z_][A-Za-z0-9_]*)'/)?.[1];
      return {
        file: path.relative(cwd, file.fileName),
        line: location.line + 1,
        code: `TS${diagnostic.code}`,
        message,
        symbol,
      };
    });
}

export function freshDiagnostics(baseline: TypeDiagnostic[], next: TypeDiagnostic[]): TypeDiagnostic[] {
  const seen = new Set(baseline.map(diagnosticKey));
  return next.filter((diagnostic) => !seen.has(diagnosticKey(diagnostic)));
}

function diagnosticKey(diagnostic: TypeDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.code}:${diagnostic.message}`;
}

export function identifiers(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`|'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
    const value = match[1] ?? match[2];
    if (value) found.add(value);
  }
  return found;
}

export async function withIsolatedTree<T>(
  cwd: string,
  run: (dir: string) => Promise<T>,
): Promise<{ mode: "worktree" | "copy"; value: T }> {
  const id = `${process.pid}-${Date.now()}`;
  const worktreeDir = path.join(cwd, ".apiweld", "worktrees", id);
  let dir = worktreeDir;
  let mode: "worktree" | "copy" = "worktree";
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (path.resolve(stdout.trim()) !== path.resolve(cwd)) {
      throw new Error("nested checkout");
    }
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    await exec("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], { cwd });
  } catch {
    mode = "copy";
    // A copy has to live outside the project. Node refuses to copy a directory into its own subtree.
    dir = path.join(os.tmpdir(), "apiweld-isolate", id);
    fs.rmSync(dir, { recursive: true, force: true });
    copyProject(cwd, dir);
  }
  try {
    const value = await run(dir);
    return { mode, value };
  } finally {
    if (mode === "worktree") {
      await exec("git", ["worktree", "remove", "--force", dir], { cwd }).catch(() => undefined);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyProject(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(from, source);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return top !== "node_modules" && top !== ".git" && top !== ".apiweld";
    },
  });
}
