import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  addOperations,
  buildCatalog,
  checkApis,
  editApiEntry,
  generateLocked,
  healApi,
  initProject,
  loadProjectConfig,
  pickOpenApiHref,
  preSliceThreshold,
  readDriftLog,
  readLock,
  removeOperations,
  resolveSource,
  resolveWellKnown,
  runtimeFrom,
  searchApis,
  searchOperations,
  showApi,
  sliceDocument,
  syncCatalog,
  updateApis,
  verifyProject,
  writeDriftRuntime,
  runEngine,
} from "@apiweld/core";
import { execute } from "@apiweld/cli";
import { toolNames } from "@apiweld/mcp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stripeV1 = path.join(root, "fixtures/history/stripe/v1.json");
const stripeV2 = path.join(root, "fixtures/history/stripe/v2.json");
const stripeUnused = path.join(root, "fixtures/history/stripe/v2-unused.json");
const stripeSafe = path.join(root, "fixtures/history/stripe/v2-safe.json");
const stripeRisky = path.join(root, "fixtures/history/stripe/v2-risky.json");
const dirs: string[] = [];

function tempProject(): { cwd: string; cacheDir: string; rt: ReturnType<typeof runtimeFrom> } {
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, ".tmp", "proj-"));
  const cacheDir = fs.mkdtempSync(path.join(root, ".tmp", "cache-"));
  dirs.push(cwd, cacheDir);
  const rt = runtimeFrom(cwd, { cacheDir, offline: true });
  return { cwd, cacheDir, rt };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("engine", () => {
  it("normalizes swagger 2 and refuses remote refs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apiweld-engine-"));
    const out = path.join(dir, "out.json");
    const response = await runEngine({
      command: "normalize",
      spec: path.join(root, "fixtures/swagger2/pets.yaml"),
      out,
    });
    expect(response.ok).toBe(true);
    expect(String(response.openapi)).toMatch(/^3\./);
    const text = fs.readFileSync(out, "utf8");
    expect(text.indexOf('"info"')).toBeLessThan(text.indexOf('"paths"'));
    await expect(
      runEngine({ command: "operations", spec: path.join(root, "fixtures/external-ref/openapi.json") }),
    ).rejects.toThrow(/remote \$ref|external/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("catalog and search", () => {
  it("finds a Stripe refund and ignores pets", async () => {
    const { cacheDir, rt } = tempProject();
    const built = await buildCatalog(rt, { from: path.join(root, "fixtures/catalog/manifest.json") });
    expect(built.apis).toBe(2);
    expect(built.operations).toBeGreaterThan(2);
    const apis = searchApis(cacheDir, "refund a payment");
    expect(apis[0]?.id).toBe("stripe.com");
    expect(apis.some((api) => api.id === "pets.com")).toBe(false);
    const ops = searchOperations(cacheDir, "refund payment", "stripe.com");
    expect(ops.some((op) => op.method === "POST" && op.path === "/v1/refunds")).toBe(true);
    const checksum = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(path.join(cacheDir, "catalog.db"))).digest("hex");
    const other = fs.mkdtempSync(path.join(root, ".tmp", "cache-"));
    dirs.push(other);
    await syncCatalog(runtimeFrom(rt.cwd, { cacheDir: other }), {
      url: `file:${path.join(cacheDir, "catalog.db")}`,
      sha256: checksum,
    });
    expect(searchApis(other, "stripe")[0]?.id).toBe("stripe.com");
  });

  it("indexes a custom catalog from settings", async () => {
    const { cacheDir, rt } = tempProject();
    fs.writeFileSync(
      path.join(cacheDir, "settings.json"),
      JSON.stringify({ catalogs: [{ name: "internal", path: path.join(root, "fixtures/history/pets") }] }),
    );
    await buildCatalog(rt);
    const hits = searchApis(cacheDir, "adopt pets");
    expect(hits[0]?.source).toBe("custom:internal");
  });
});

describe("weld", () => {
  it("goes from a refund search to a two-endpoint client", async () => {
    const { cwd, cacheDir, rt } = tempProject();
    await buildCatalog(rt, { from: path.join(root, "fixtures/catalog/manifest.json") });
    expect(searchOperations(cacheDir, "refund a payment")[0]?.path).toBe("/v1/refunds");
    await initProject(rt, { agents: true });
    expect(fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8")).toContain("apiweld");
    expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain(".apiweld/");
    const added = await addOperations(rt, {
      api: "stripe.com",
      as: "stripe",
      source: `file:${stripeV1}`,
      operations: ["POST /v1/refunds", "GET /v1/refunds/{refund}"],
    });
    expect(added.operations).toEqual(["GET /v1/refunds/{refund}", "POST /v1/refunds"]);
    const config = fs.readFileSync(path.join(cwd, "apiweld.config.ts"), "utf8");
    expect(config).toContain("defineConfig");
    expect(config).toContain("POST /v1/refunds");
    const lock = readLock(cwd);
    expect(lock.apis.stripe?.operations).toEqual(["GET /v1/refunds/{refund}", "POST /v1/refunds"]);
    expect(lock.apis.stripe?.specHash).toMatch(/^sha256:/);
    expect(lock.apis.stripe?.sliceHash).toMatch(/^sha256:/);
    expect(lock.apis.stripe?.generator).toContain("@hey-api/openapi-ts@");
    const generated = fs.readdirSync(path.join(cwd, "src/apis/stripe")).join("\n");
    expect(generated).toMatch(/types/);
    const shown = await showApi(rt, "stripe", "POST /v1/refunds", 1);
    expect(shown.text).toContain("createRefund");
    expect(shown.text).toContain("charge?:");
    expect(shown.text).toContain("Promise<Refund>");
    expect(shown.text).toContain("bearer");
    const types = fs.readFileSync(path.join(cwd, "apiweld-env.d.ts"), "utf8");
    expect(types).toContain("POST /v1/refunds");
    await removeOperations(rt, { api: "stripe", operations: ["GET /v1/refunds/{refund}"] });
    expect(readLock(cwd).apis.stripe?.operations).toEqual(["POST /v1/refunds"]);
    const before = fs.readFileSync(path.join(cwd, "src/apis/stripe/index.ts"), "utf8");
    fs.writeFileSync(path.join(cwd, "src/apis/stripe/index.ts"), `${before}\n// hand edit\n`);
    await generateLocked(rt, "stripe");
    expect(fs.readFileSync(path.join(cwd, "src/apis/stripe/index.ts"), "utf8")).not.toContain("hand edit");
  });

  it("prints a snippet when the config is dynamic", async () => {
    const { cwd, rt } = tempProject();
    fs.writeFileSync(
      path.join(cwd, "apiweld.config.ts"),
      `import { defineConfig } from "apiweld";
const extra = { output: "src/apis" };
export default defineConfig({
  ...extra,
  apis: {},
});
`,
    );
    const result = await editApiEntry(cwd, "stripe", () => ({
      source: "file:./spec.json",
      operations: ["POST /v1/refunds"],
    }));
    expect(result.edited).toBe(false);
    expect(result.snippet).toContain("POST /v1/refunds");
    expect(fs.readFileSync(path.join(cwd, "apiweld.config.ts"), "utf8")).toContain("...extra");
  });
});

describe("watch", () => {
  it("reports only selected breaking changes and ignores unused ones", async () => {
    const { cwd, rt } = tempProject();
    await initProject(rt);
    const spec = path.join(cwd, "spec.json");
    fs.copyFileSync(stripeV1, spec);
    await addOperations(rt, {
      api: "stripe",
      source: `file:${spec}`,
      operations: ["POST /v1/refunds", "GET /v1/refunds/{refund}"],
    });
    const locked = readLock(cwd).apis.stripe;
    fs.copyFileSync(stripeUnused, spec);
    const config = await loadProjectConfig(cwd);
    const quiet = await checkApis(rt, { apis: config.apis, outputRoot: "src/apis" });
    expect(quiet.drift).toBe(false);
    expect(quiet.apis[0]?.unusedChange).toBe(true);
    expect(readLock(cwd).apis.stripe?.sliceHash).toBe(locked?.sliceHash);
    expect(readLock(cwd).apis.stripe?.specHash).not.toBe(locked?.specHash);

    fs.copyFileSync(stripeV2, spec);
    const loud = await checkApis(rt, { apis: config.apis, outputRoot: "src/apis", failOn: "breaking" });
    expect(loud.fail).toBe(true);
    const ids = loud.apis[0]?.findings.map((finding) => finding.id) ?? [];
    expect(ids).toContain("response-required-property-removed");
    expect(loud.apis[0]?.findings.some((finding) => finding.operation.includes("/v1/customers"))).toBe(false);
    expect(loud.apis[0]?.maxClass).toBe("breaking");
    expect(fs.existsSync(path.join(cwd, ".apiweld/reports"))).toBe(true);

    fs.copyFileSync(stripeV1, spec);
    await checkApis(rt, { apis: config.apis, outputRoot: "src/apis" });
    fs.copyFileSync(stripeRisky, spec);
    const risky = await checkApis(rt, { apis: config.apis, outputRoot: "src/apis", failOn: "risky" });
    expect(risky.apis[0]?.maxClass).toBe("risky");
    expect(risky.fail).toBe(true);
    expect(preSliceThreshold()).toBeGreaterThan(0);
  });

  it("regenerates safe changes and leaves risky clients in place", async () => {
    const { cwd, rt } = tempProject();
    await initProject(rt);
    const spec = path.join(cwd, "spec.json");
    fs.copyFileSync(stripeV1, spec);
    await addOperations(rt, {
      api: "stripe",
      source: `file:${spec}`,
      operations: ["POST /v1/refunds", "GET /v1/refunds/{refund}"],
    });
    const before = readLock(cwd).apis.stripe?.outputHash;
    fs.copyFileSync(stripeSafe, spec);
    const updated = await updateApis(rt, "stripe");
    expect(updated.regenerated).toEqual(["stripe"]);
    expect(readLock(cwd).apis.stripe?.outputHash).not.toBe(before);
    fs.copyFileSync(stripeV1, spec);
    await updateApis(rt);
    const stable = readLock(cwd).apis.stripe?.outputHash;
    fs.copyFileSync(stripeRisky, spec);
    const risky = await updateApis(rt, "stripe");
    expect(risky.regenerated).toEqual([]);
    expect(readLock(cwd).apis.stripe?.outputHash).toBe(stable);
  });
});

describe("heal and verify", () => {
  it("matches a compiler error to the removed refund field", async () => {
    const { cwd, rt } = tempProject();
    await initProject(rt);
    const spec = path.join(cwd, "spec.json");
    fs.copyFileSync(stripeV1, spec);
    await addOperations(rt, {
      api: "stripe",
      source: `file:${spec}`,
      operations: ["GET /v1/refunds/{refund}", "POST /v1/refunds"],
    });
    const typeFile = fs.readdirSync(path.join(cwd, "src/apis/stripe")).find((file) => file.includes("type"));
    expect(typeFile).toBeTruthy();
    const typeSource = fs.readFileSync(path.join(cwd, "src/apis/stripe", typeFile ?? ""), "utf8");
    expect(typeSource).toContain("failure_balance_transaction");
    fs.mkdirSync(path.join(cwd, "src/billing"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "src/billing/refunds.ts"),
      `import type { Refund } from "../apis/stripe/${typeFile?.replace(/\\.ts$/, "")}";\nexport function failureTransaction(refund: Refund): string {\n  return refund.failure_balance_transaction;\n}\n`,
    );
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ["src"],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module" }));
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "apiweld@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Apiweld"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "weld stripe"], { cwd });
    const before = fs.readFileSync(path.join(cwd, "src/apis/stripe", typeFile ?? ""), "utf8");
    fs.copyFileSync(stripeV2, spec);
    const plan = await healApi(rt, "stripe");
    expect(plan.applied).toBe(false);
    expect(fs.readFileSync(path.join(cwd, "src/apis/stripe", typeFile ?? ""), "utf8")).toBe(before);
    const site = plan.findings.flatMap((finding) => finding.callSites).find((call) => call.file.endsWith("refunds.ts"));
    expect(site?.tsError).toContain("failure_balance_transaction");
    expect(plan.findings.some((finding) => finding.hints.some((hint) => hint.includes("No replacement")))).toBe(true);
    const applied = await healApi(rt, "stripe", { apply: true });
    expect(applied.applied).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "src/apis/stripe", typeFile ?? ""), "utf8")).not.toContain("failure_balance_transaction");
    const verified = await verifyProject(rt);
    expect(verified.typecheck.ok).toBe(false);
    expect(verified.typecheck.errors.some((error) => error.message.includes("failure_balance_transaction"))).toBe(true);
  });
});

describe("widen", () => {
  it("logs response shape mismatches without payload values", async () => {
    const { cwd } = tempProject();
    const doc = JSON.parse(fs.readFileSync(stripeV1, "utf8")) as Record<string, unknown>;
    const slice = sliceDocument(doc, ["POST /v1/refunds"]);
    expect(slice.missing).toEqual([]);
    expect(slice.schemas).toContain("Refund");
    const file = writeDriftRuntime(path.join(cwd, "src/apis/stripe"), doc, ["POST /v1/refunds"]);
    process.env.APIWELD_DRIFT_LOG = path.join(cwd, ".apiweld/drift.log.jsonl");
    const mod = await import(`${file}?drift=${Date.now()}`);
    mod.reportResponse("POST /v1/refunds", { id: "re_123", amount: "secret-token", status: "succeeded" });
    const log = fs.readFileSync(process.env.APIWELD_DRIFT_LOG, "utf8");
    expect(log).not.toContain("secret-token");
    expect(log).toContain("amount");
    expect(readDriftLog(cwd).length).toBeGreaterThan(0);
    const entries = JSON.parse(log.trim().split("\n")[0] ?? "{}") as { issues: Array<{ received: string }> };
    expect(entries.issues.some((issue) => issue.received === "string")).toBe(true);
    delete process.env.APIWELD_DRIFT_LOG;
  });

  it("resolves a well-known API catalog and curated upstreams", async () => {
    const body = JSON.parse(fs.readFileSync(path.join(root, "fixtures/wellknown/api-catalog.json"), "utf8"));
    expect(pickOpenApiHref(body)).toBe("https://example.com/openapi.json");
    const { rt } = tempProject();
    const resolved = await resolveWellKnown("example.com", { ...rt, offline: false }, async () =>
      new Response(JSON.stringify(body), { status: 200 }),
    );
    expect(resolved.url).toBe("https://example.com/openapi.json");
    const upstream = await resolveSource("apisguru:stripe.com", { ...rt, offline: true });
    expect(upstream.url).toContain("stripe/openapi");
  });

  it("generates a Go client with oapi-codegen", async () => {
    const { cwd, rt } = tempProject();
    await initProject(rt);
    const config = `import { defineConfig } from "apiweld";
export default defineConfig({
  output: "src/apis",
  generator: { name: "oapi-codegen", client: "go" },
  apis: {},
});
`;
    fs.writeFileSync(path.join(cwd, "apiweld.config.ts"), config);
    await addOperations(rt, {
      api: "stripe",
      source: `file:${stripeV1}`,
      operations: ["POST /v1/refunds"],
    });
    const go = fs.readFileSync(path.join(cwd, "src/apis/stripe/client.gen.go"), "utf8");
    expect(go).toContain("package stripe");
    expect(go).toMatch(/CreateRefund|createRefund/);
  });
});

describe("cli and mcp", () => {
  it("lists the agent tools and searches through the CLI", async () => {
    expect(toolNames()).toEqual([
      "search_apis",
      "search_operations",
      "describe_operation",
      "add_operations",
      "remove_operations",
      "check_drift",
      "get_heal_plan",
      "verify",
    ]);
    const { cwd, cacheDir } = tempProject();
    await buildCatalog(runtimeFrom(cwd, { cacheDir }), { from: path.join(root, "fixtures/catalog/manifest.json") });
    const previous = process.env.APIWELD_CACHE_DIR;
    process.env.APIWELD_CACHE_DIR = cacheDir;
    const code = await execute(["search", "refund a payment", "--ops", "--json"]);
    expect(code).toBe(0);
    process.env.APIWELD_CACHE_DIR = previous;
  });
});
