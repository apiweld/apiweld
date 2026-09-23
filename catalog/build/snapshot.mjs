import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cache = fs.mkdtempSync(path.join(os.tmpdir(), "apiweld-catalog-"));
const engine = path.join(root, "engine", "bin", "apiweld-engine");
const cli = path.join(root, "packages", "apiweld", "bin", "apiweld.js");
const args = [cli, "catalog", "build"];
if (process.env.APIWELD_CATALOG_FROM) {
  args.push("--from", process.env.APIWELD_CATALOG_FROM);
}

const result = spawnSync(process.execPath, args, {
  cwd: root,
  env: {
    ...process.env,
    APIWELD_CACHE_DIR: cache,
    APIWELD_ENGINE_PATH: engine,
  },
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const db = path.join(cache, "catalog.db");
const outDir = path.join(root, "catalog");
const dest = path.join(outDir, "snapshot.db");
fs.copyFileSync(db, dest);
const hash = createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
fs.writeFileSync(path.join(outDir, "snapshot.sha256"), `${hash}  snapshot.db\n`);
console.log(`Wrote catalog/snapshot.db (${hash})`);
