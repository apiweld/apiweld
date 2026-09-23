import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@hey-api/openapi-ts";

const require = createRequire(import.meta.url);

export interface HeyGenerator {
  name: "hey-api";
  version(): Promise<string>;
  generate(input: {
    specPath: string;
    operations: string[];
    outDir: string;
    options: Record<string, unknown>;
    patch?: unknown;
    apiName: string;
  }): Promise<{ files: string[] }>;
}

const clients: Record<string, string> = {
  fetch: "@hey-api/client-fetch",
  axios: "@hey-api/client-axios",
  next: "@hey-api/client-next",
  nuxt: "@hey-api/client-nuxt",
};

export const heyApiGenerator: HeyGenerator = {
  name: "hey-api",
  async version() {
    const pkg = require("@hey-api/openapi-ts/package.json") as { version: string };
    return `@hey-api/openapi-ts@${pkg.version}`;
  },
  async generate(input) {
    const clientName = String(input.options.client ?? "fetch");
    const clientPlugin = clients[clientName] ?? `@hey-api/client-${clientName}`;
    const validators = input.options.validators === "zod";
    const plugins: unknown[] = [
      clientPlugin,
      "@hey-api/typescript",
      { name: "@hey-api/sdk", client: clientPlugin },
    ];
    if (validators) plugins.push({ name: "zod", compatibilityVersion: 4 });
    await createClient({
      input: input.specPath,
      output: input.outDir,
      interactive: false,
      parser: {
        filters: {
          operations: { include: input.operations },
          orphans: false,
        },
        ...(input.patch ? { patch: input.patch as never } : {}),
      },
      plugins: plugins as never,
    });
    return { files: listFiles(input.outDir) };
  },
};

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".heyapi-logs") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}
