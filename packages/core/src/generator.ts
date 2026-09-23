export interface GeneratorAdapter {
  name: string;
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

const registry = new Map<string, GeneratorAdapter>();

export function registerGenerator(adapter: GeneratorAdapter): void {
  registry.set(adapter.name, adapter);
}

export function getGenerator(name: string): GeneratorAdapter {
  const adapter = registry.get(name);
  if (!adapter) {
    const known = [...registry.keys()].sort().join(", ") || "(none registered)";
    throw new Error(`Unknown generator "${name}". Registered: ${known}`);
  }
  return adapter;
}
