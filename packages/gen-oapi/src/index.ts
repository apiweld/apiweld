import fs from "node:fs";
import path from "node:path";
import { engineVersion, runEngine } from "@apiweld/core";

export const oapiGenerator = {
  name: "oapi-codegen",
  async version() {
    return engineVersion();
  },
  async generate(input: {
    specPath: string;
    operations: string[];
    outDir: string;
    options: Record<string, unknown>;
    patch?: unknown;
    apiName: string;
  }): Promise<{ files: string[] }> {
    fs.mkdirSync(input.outDir, { recursive: true });
    const target = path.join(input.outDir, "client.gen.go");
    await runEngine({
      command: "codegen",
      spec: input.specPath,
      out: target,
      package: input.apiName,
    });
    const note = path.join(input.outDir, "operations.txt");
    fs.writeFileSync(note, `${[...input.operations].sort().join("\n")}\n`);
    return { files: [target, note] };
  },
};
