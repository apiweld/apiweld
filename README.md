# Apiweld

Apiweld is a local tool for coding agents. It searches a catalog of public APIs, welds a typed client for only the operations you call, and keeps that client in sync when the upstream spec changes. Nothing calls an LLM. The only network traffic is HTTP GETs for public specs and the catalog snapshot. Project state is `apiweld.config.ts` and `apiweld.lock.json`.

Apache-2.0. Requires Node.js 20+ and pnpm. The Go engine needs a Go 1.26 toolchain (the `go` command downloads it from `engine/go.mod` when it is missing).

## Build

```bash
pnpm install
pnpm engine:build
```

`pnpm engine:build` writes `engine/bin/apiweld-engine`. Set `APIWELD_ENGINE_PATH` if the binary lives somewhere else. Published installs resolve `@apiweld/engine-<platform>` instead.

## Run

From this repo:

```bash
pnpm exec apiweld init
pnpm exec apiweld catalog build --from fixtures/catalog/manifest.json
pnpm exec apiweld search "refund a payment" --ops --json
pnpm exec apiweld add stripe "POST /v1/refunds" "GET /v1/refunds/{refund}" --source file:fixtures/history/stripe/v1.json
```

`init` writes `apiweld.config.ts` and ignores `.apiweld/`. `add` edits the config, slices the spec, generates a Hey API client under `src/apis/`, and writes `apiweld.lock.json`.

Other commands: `catalog sync`, `show`, `remove`, `generate`, `update`, `check`, `heal`, `verify`, `mcp`. Every command accepts `--json` and `--offline`.

Start the MCP server for an agent:

```bash
pnpm exec apiweld mcp
```

## Tests

```bash
pnpm test
pnpm test:engine
pnpm typecheck
```

Tests use the specs in `fixtures/` and do not call the network.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core` | Catalog, resolvers, spec store, slicer, lockfile, check, heal |
| `packages/cli` | `apiweld` commands |
| `packages/mcp` | stdio MCP server |
| `packages/gen-heyapi` | `@hey-api/openapi-ts` adapter |
| `packages/gen-oapi` | Go `oapi-codegen` adapter |
| `packages/apiweld` | Published package: bin, `defineConfig`, drift helper |
| `engine/` | Go sidecar wrapping oasdiff and kin-openapi |
| `npm/engine-*` | Per-platform binary packages filled by the release workflow |
| `catalog/` | Curated upstream URLs and the weekly snapshot job |
| `action/` | GitHub Action that checks drift and opens a heal pull request |
