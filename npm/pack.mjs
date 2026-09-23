import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = path.join(root, "engine");

const targets = [
  ["darwin", "arm64", "engine-darwin-arm64", "apiweld-engine"],
  ["darwin", "amd64", "engine-darwin-x64", "apiweld-engine"],
  ["linux", "amd64", "engine-linux-x64", "apiweld-engine"],
  ["linux", "arm64", "engine-linux-arm64", "apiweld-engine"],
  ["windows", "amd64", "engine-win32-x64", "apiweld-engine.exe"],
];

for (const [goos, goarch, pkg, binary] of targets) {
  const destDir = path.join(root, "npm", pkg, "bin");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, binary);
  const result = spawnSync("go", ["build", "-o", dest, "./cmd/apiweld-engine"], {
    cwd: engineDir,
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`packed ${pkg}`);
}
