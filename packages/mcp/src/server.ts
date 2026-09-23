import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  addOperations,
  checkApis,
  healApi,
  loadProjectConfig,
  removeOperations,
  searchApis,
  searchOperations,
  showApi,
  verifyProject,
  type Runtime,
} from "@apiweld/core";
import { z } from "zod";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createMcpServer(rt: Runtime): McpServer {
  const server = new McpServer({ name: "apiweld", version: "0.4.0" });
  server.registerTool(
    "search_apis",
    {
      description: "Search the local API catalog",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => text(searchApis(rt.cacheDir, query)),
  );
  server.registerTool(
    "search_operations",
    {
      description: "Search operations in the local catalog",
      inputSchema: { query: z.string(), api: z.string().optional() },
    },
    async ({ query, api }) => text(searchOperations(rt.cacheDir, query, api)),
  );
  server.registerTool(
    "describe_operation",
    {
      description: "Show a compact TypeScript signature for one operation",
      inputSchema: { api: z.string(), operation: z.string(), depth: z.number().optional() },
    },
    async ({ api, operation, depth }) => text(await showApi(rt, api, operation, depth ?? 1)),
  );
  server.registerTool(
    "add_operations",
    {
      description: "Add operations, update apiweld.config.ts, and generate the client",
      inputSchema: {
        api: z.string(),
        operations: z.array(z.string()),
        source: z.string().optional(),
        as: z.string().optional(),
      },
    },
    async (args) => text(await addOperations(rt, args)),
  );
  server.registerTool(
    "remove_operations",
    {
      description: "Remove operations and regenerate the client",
      inputSchema: { api: z.string(), operations: z.array(z.string()) },
    },
    async (args) => text(await removeOperations(rt, args)),
  );
  server.registerTool(
    "check_drift",
    {
      description: "Classify spec drift for the selected operations",
      inputSchema: { api: z.string().optional(), failOn: z.enum(["breaking", "risky", "safe"]).optional() },
    },
    async ({ api, failOn }) => {
      const config = await loadProjectConfig(rt.cwd);
      return text(await checkApis(rt, { apis: config.apis, only: api, failOn, outputRoot: config.output ?? "src/apis" }));
    },
  );
  server.registerTool(
    "get_heal_plan",
    {
      description: "Build a heal plan for one API",
      inputSchema: { api: z.string(), apply: z.boolean().optional() },
    },
    async ({ api, apply }) => text(await healApi(rt, api, { apply })),
  );
  server.registerTool(
    "verify",
    {
      description: "Type-check the project and run the optional test command",
      inputSchema: {},
    },
    async () => text(await verifyProject(rt)),
  );
  return server;
}

export const v01Tools = [
  "search_apis",
  "search_operations",
  "describe_operation",
  "add_operations",
  "remove_operations",
] as const;

export async function startMcp(rt: Runtime): Promise<void> {
  const server = createMcpServer(rt);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function toolNames(): string[] {
  return [
    ...v01Tools,
    "check_drift",
    "get_heal_plan",
    "verify",
  ];
}
