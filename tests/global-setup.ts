import { execSync } from "node:child_process";
import fs from "node:fs";

export default function setup(): void {
  if (!fs.existsSync("engine/bin/apiweld-engine")) {
    execSync("go build -C engine -o bin/apiweld-engine ./cmd/apiweld-engine", {
      stdio: "inherit",
    });
  }
}
