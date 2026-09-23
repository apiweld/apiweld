import fs from "node:fs";
import path from "node:path";
import { runEngine } from "./engine.js";
import { ensureDir } from "./paths.js";
import { sha256 } from "./json.js";

export function specPath(cacheDir: string, hash: string): string {
  const id = hash.replace(/^sha256:/, "");
  return path.join(cacheDir, "specs", `${id}.json`);
}

export async function normalizeToStore(
  cacheDir: string,
  inputPath: string,
): Promise<{ specPath: string; specHash: string; specVersion: string; title: string; openapi: string }> {
  const dir = path.join(cacheDir, "specs");
  ensureDir(dir);
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  try {
    const response = await runEngine({ command: "normalize", spec: inputPath, out: temp });
    const body = fs.readFileSync(temp);
    const specHash = sha256(body);
    const target = specPath(cacheDir, specHash);
    if (!fs.existsSync(target)) fs.renameSync(temp, target);
    else fs.rmSync(temp, { force: true });
    return {
      specPath: target,
      specHash,
      specVersion: response.specVersion ?? "",
      title: response.title ?? "",
      openapi: response.openapi ?? "",
    };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
