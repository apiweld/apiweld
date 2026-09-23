export interface ApiOperationMap {
  // Filled in by apiweld-env.d.ts after generate, so known APIs autocomplete.
}

export type ChangeClass = "breaking" | "risky" | "safe";

export interface GeneratorConfig {
  name?: string;
  client?: string;
  validators?: "zod" | false;
  options?: Record<string, unknown>;
}

export interface ApiPolicy {
  autoRegenerate?: "safe" | "never";
}

export interface ApiEntry<Ops extends string = string> {
  source: string;
  operations: Array<Ops>;
  policy?: ApiPolicy;
  patch?: unknown;
  levelOverrides?: Record<string, ChangeClass>;
  allowRemoteHosts?: string[];
}

export interface VerifyConfig {
  typecheck?: boolean;
  test?: string;
}

export interface ApiweldConfig {
  output?: string;
  generator?: GeneratorConfig;
  verify?: VerifyConfig;
  apis: Record<string, ApiEntry>;
}

type KnownOps<K extends string> = K extends keyof ApiOperationMap
  ? ApiOperationMap[K] | (string & {})
  : string;

type ConfigShape<T extends ApiweldConfig> = {
  [K in keyof T]: K extends "apis"
    ? {
        [Api in keyof T["apis"]]: ApiEntry<
          Api extends string ? KnownOps<Api> : string
        >;
      }
    : T[K];
};

export function defineConfig<const T extends ApiweldConfig>(
  config: T & ConfigShape<T>,
): T {
  return config;
}
