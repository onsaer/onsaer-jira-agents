import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildRepoContext } from "./context.js";
import { loadConfig } from "./config.js";
import { Tracer } from "./observability.js";
import { checkWrite, DEFAULT_DENY_WRITE, globToRegExp, isTestFile, type Policy } from "./policy.js";
import type { TechnicalSpec } from "./schemas.js";
import { createRepoTools, type ToolContext } from "./tools.js";
import { blockingFailures, runQualityGates } from "./verify.js";

const basePolicy = (over: Partial<Policy> = {}): Policy => ({
  denyWrite: DEFAULT_DENY_WRITE,
  maxFiles: 3,
  maxFileBytes: 1000,
  strictScope: false,
  plannedFiles: new Set(),
  ...over,
});

describe("policy (guardrails)", () => {
  it("convertit les globs", () => {
    assert.ok(globToRegExp("**/.env").test(".env"));
    assert.ok(globToRegExp("**/.env").test("a/b/.env"));
    assert.ok(globToRegExp(".git/**").test(".git/config"));
    assert.ok(!globToRegExp("*.ts").test("a/b.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  });

  it("reconnaît les fichiers de test (Angular et Java)", () => {
    assert.ok(isTestFile("src/app/foo.component.spec.ts"));
    assert.ok(isTestFile("src/test/java/com/x/FooTest.java"));
    assert.ok(isTestFile("src/main/java/FooIT.java"));
    assert.ok(!isTestFile("src/app/foo.component.ts"));
  });

  it("refuse secrets, lockfiles, taille et quota, avec un conseil", () => {
    const w = new Map<string, number>();
    const denied = checkWrite(basePolicy(), "config/.env", "x", w);
    assert.equal(denied.ok, false);
    assert.match((denied as { hint: string }).hint, /rapport/);
    assert.equal(checkWrite(basePolicy(), "package-lock.json", "x", w).ok, false);
    assert.equal(checkWrite(basePolicy(), "a.ts", "x".repeat(2000), w).ok, false);
    const full = new Map([["a", 1], ["b", 1], ["c", 1]]);
    assert.equal(checkWrite(basePolicy(), "d.ts", "x", full).ok, false);
    assert.equal(checkWrite(basePolicy(), "a", "x", full).ok, true); // réécrire un fichier connu reste possible
  });

  it("strictScope : seuls spec + tests", () => {
    const p = basePolicy({ strictScope: true, plannedFiles: new Set(["src/a.ts"]) });
    const w = new Map<string, number>();
    assert.equal(checkWrite(p, "src/a.ts", "x", w).ok, true);
    assert.equal(checkWrite(p, "src/a.spec.ts", "x", w).ok, true);
    assert.equal(checkWrite(p, "src/b.ts", "x", w).ok, false);
  });
});

describe("tools (hooks déterministes)", () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-"));
    await fs.writeFile(path.join(dir, "hello.txt"), "bonjour\nmonde\n");
  });
  after(async () => fs.rm(dir, { recursive: true, force: true }));

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    root: dir,
    policy: basePolicy(),
    tracer: new Tracer(path.join(os.tmpdir(), `trace-${Math.random()}.jsonl`)),
    agent: "test",
    written: new Map(),
    commandTimeoutMs: 5000,
    maxToolCalls: 50,
    ...over,
  });
  const call = (tools: ReturnType<typeof createRepoTools>, name: string, args: object) =>
    tools.find((t) => t.name === name)!.invoke(args) as Promise<string>;

  it("le mode read-only n'expose aucun outil d'écriture ni de commande", () => {
    const names = createRepoTools(ctx({ testCommand: "echo ok" }), "read-only").map((t) => t.name);
    assert.deepEqual(names.sort(), ["list_dir", "read_file", "search_files"]);
  });

  it("refuse hors dépôt avec un message actionnable (sans lever d'exception)", async () => {
    const tools = createRepoTools(ctx(), "read-write");
    const out = await call(tools, "read_file", { filePath: "../../etc/passwd" });
    assert.match(out, /^ERREUR/);
    assert.match(out, /Que faire/);
  });

  it("écrit, trace, et refuse un fichier interdit", async () => {
    const c = ctx();
    const tools = createRepoTools(c, "read-write");
    assert.match(await call(tools, "write_file", { filePath: "src/a.ts", content: "x" }), /^Écrit/);
    assert.ok(c.written.has("src/a.ts"));
    assert.match(await call(tools, "write_file", { filePath: ".env", content: "S=1" }), /^REFUSÉ/);
    assert.equal(c.tracer.metrics.policyDenials, 1);
  });

  it("détecte une boucle (3e appel identique) et la réinitialise après une écriture", async () => {
    const c = ctx();
    const tools = createRepoTools(c, "read-write");
    await call(tools, "read_file", { filePath: "hello.txt" });
    await call(tools, "read_file", { filePath: "hello.txt" });
    assert.match(await call(tools, "read_file", { filePath: "hello.txt" }), /^BOUCLE DÉTECTÉE/);
    assert.equal(c.tracer.metrics.loopTrips, 1);
    await call(tools, "write_file", { filePath: "b.txt", content: "y" });
    assert.doesNotMatch(await call(tools, "read_file", { filePath: "hello.txt" }), /^BOUCLE/);
  });

  it("applique le budget d'appels", async () => {
    const tools = createRepoTools(ctx({ maxToolCalls: 2 }), "read-write");
    await call(tools, "list_dir", { dir: "." });
    await call(tools, "list_dir", { dir: "." });
    assert.match(await call(tools, "list_dir", { dir: "." }), /^BUDGET ÉPUISÉ/);
  });

  it("search_files trouve et signale une regex invalide", async () => {
    const tools = createRepoTools(ctx(), "read-only");
    assert.match(await call(tools, "search_files", { pattern: "MONDE" }), /hello\.txt:2/);
    assert.match(await call(tools, "search_files", { pattern: "(" }), /^ERREUR/);
  });

  it("run_tests renvoie ÉCHEC + conseil quand la commande échoue", async () => {
    const tools = createRepoTools(ctx({ testCommand: "echo boom 1>&2; exit 3" }), "read-write");
    const out = await call(tools, "run_tests", {});
    assert.match(out, /^ÉCHEC \(code 3/);
    assert.match(out, /boom/);
    assert.match(out, /Que faire/);
  });
});

describe("quality gates", () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-gates-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/a.ts"), "export {}");
  });
  after(async () => fs.rm(dir, { recursive: true, force: true }));

  const spec = {
    filesToChange: [
      { path: "src/a.ts", action: "create", purpose: "" },
      { path: "src/missing.ts", action: "create", purpose: "" },
    ],
  } as unknown as TechnicalSpec;
  const tracer = () => new Tracer(path.join(os.tmpdir(), `trace-${Math.random()}.jsonl`));

  it("bloque : pas de test écrit + fichier à créer manquant ; avertit sur la dérive", async () => {
    const cfg = loadConfig("T-1", { specOnly: false, resume: false, yes: true });
    cfg.repoRoot = dir;
    const gates = await runQualityGates({ cfg, spec, written: new Map([["src/a.ts", 1], ["src/extra.ts", 1]]), tracer: tracer() });
    const by = Object.fromEntries(gates.map((g) => [g.name, g]));
    assert.equal(by["tests-written"].status, "failed");
    assert.equal(by["spec-coverage"].status, "failed");
    assert.match(by["spec-coverage"].details, /missing\.ts/);
    assert.equal(by["scope"].status, "failed");
    assert.equal(by["scope"].blocking, false);
    assert.equal(by["tests"].status, "skipped");
    assert.deepEqual(blockingFailures(gates).map((g) => g.name).sort(), ["spec-coverage", "tests-written"]);
  });

  it("passe quand tout est conforme et exécute TEST_COMMAND / LINT_COMMAND", async () => {
    await fs.writeFile(path.join(dir, "src/missing.ts"), "export {}");
    const cfg = loadConfig("T-1", { specOnly: false, resume: false, yes: true });
    cfg.repoRoot = dir;
    cfg.testCommand = "echo ok";
    cfg.lintCommand = "exit 1";
    const written = new Map([["src/a.ts", 1], ["src/missing.ts", 1], ["src/a.spec.ts", 1]]);
    const gates = await runQualityGates({ cfg, spec, written, tracer: tracer() });
    assert.equal(gates.find((g) => g.name === "tests")!.status, "passed");
    assert.equal(gates.find((g) => g.name === "lint")!.status, "failed");
    assert.deepEqual(blockingFailures(gates).map((g) => g.name), ["lint"]);
  });
});

describe("context engineering", () => {
  it("détecte la stack et injecte les instructions du dépôt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-ctx-"));
    try {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { "@angular/core": "^20.0.0" }, devDependencies: { jest: "^29" }, scripts: { test: "jest" } }),
      );
      await fs.writeFile(path.join(dir, "AGENTS.md"), "Toujours utiliser les signals.");
      await fs.mkdir(path.join(dir, "src/app"), { recursive: true });
      const ctx = await buildRepoContext(dir);
      assert.match(ctx, /Angular \^20/);
      assert.match(ctx, /Test : jest/);
      assert.match(ctx, /Toujours utiliser les signals/);
      assert.match(ctx, /src\//);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
