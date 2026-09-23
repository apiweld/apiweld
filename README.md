# Apiweld

Apiweld is a local tool for coding agents. It searches a catalog of public APIs, welds a typed client for only the operations you call, and keeps that client in sync when the upstream spec changes. Nothing calls an LLM. The only network traffic is HTTP GETs for public specs and the catalog snapshot. Project state is `apiweld.config.ts` and `apiweld.lock.json`.

Apache-2.0. Requires Node.js 20+ and Bun. The Go engine needs a Go 1.26 toolchain (the `go` command downloads it from `engine/go.mod` when it is missing).

## Build

```bash
bun install
bun run engine:build
```

`bun run engine:build` writes `engine/bin/apiweld-engine`. Set `APIWELD_ENGINE_PATH` if the binary lives somewhere else. Published installs resolve `@apiweld/engine-<platform>` instead.

## Run

From this repo:

```bash
bun run apiweld init
bun run apiweld catalog add stripe https://github.com/stripe/openapi/blob/master/latest/openapi.spec3.json
bun run apiweld search "refund a payment" --ops --json
bun run apiweld add stripe PostRefunds "GET /v1/refunds/{refund}"
```

`init` writes `apiweld.config.ts` and ignores `.apiweld/`. In a workspace it asks for the output directory. `catalog add` indexes one provider spec. `add` accepts an operation id or `METHOD /path`, stores `METHOD /path`, slices the spec, generates a Hey API client under the configured `output` (default `src/apis/`), and writes `apiweld.lock.json`. Spec URLs are stored without a `url:` prefix. Local specs use `file:`.

Other commands: `catalog sync`, `catalog build`, `show`, `remove`, `generate`, `update`, `check`, `heal`, `verify`, `mcp`. Every command accepts `--json` and `--offline`. `catalog build` indexes APIs.guru and is the slow path.

Start the MCP server for an agent:

```bash
bun run apiweld mcp
```

## Tests

```bash
bun run test
bun run test:engine
bun run typecheck
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
| `site/` | Documentation site |
| `examples/` | Generated clients from the sample config |
| `action/` | GitHub Action that checks drift and opens a heal pull request |
