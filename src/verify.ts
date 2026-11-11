import path from "node:path";
import type { HarnessConfig } from "./config.js";
import { runCommand } from "./exec.js";
import { exists } from "./fsutil.js";
import { isTestFile, normalizeRel } from "./policy.js";
import type { Tracer } from "./observability.js";
import type { GateRecord } from "./state.js";
import type { TechnicalSpec } from "./schemas.js";

/**
 * PILIERS « QUALITY GATES » (enforcement) et « FEEDBACK LOOPS » (correctif).
 *
 * Après chaque tour de l'agent développeur, le harnais lance des vérifications
 * DÉTERMINISTES, indépendantes de ce que l'agent affirme dans son rapport :
 *
 *  - tests-written  : au moins un fichier de test a été écrit ;
 *  - spec-coverage  : tous les fichiers « create » de la spec existent ;
 *  - scope          : pas de fichier hors spec (avertissement ; bloquant via STRICT_SCOPE) ;
 *  - lint           : LINT_COMMAND (si configurée) ;
 *  - tests          : TEST_COMMAND (si configurée).
 *
 * Un gate « bloquant » en échec empêche la validation ; son détail est renvoyé à
 * l'agent au tour suivant (boucle de feedback).
 */
export type GateResult = GateRecord;

export async function runQualityGates(input: {
  cfg: HarnessConfig;
  spec: TechnicalSpec;
  written: Map<string, number>;
  tracer: Tracer;
}): Promise<GateResult[]> {
  const { cfg, spec, written, tracer } = input;
  const results: GateResult[] = [];
  const writtenFiles = [...written.keys()];
  const planned = new Set(spec.filesToChange.map((f) => normalizeRel(f.path)));

  // 1) Des tests ont-ils été écrits ?
  const testsWritten = writtenFiles.filter(isTestFile);
  results.push({
    name: "tests-written",
    blocking: true,
    status: testsWritten.length > 0 ? "passed" : "failed",
    details: testsWritten.length
      ? `${testsWritten.length} fichier(s) de test : ${testsWritten.join(", ")}`
      : "Aucun fichier de test écrit. Écrivez les tests du plan de tests de la spécification.",
  });

  // 2) Les fichiers à créer existent-ils ?
  const missing: string[] = [];
  for (const f of spec.filesToChange.filter((f) => f.action === "create")) {
    if (!(await exists(path.join(cfg.repoRoot, normalizeRel(f.path))))) missing.push(f.path);
  }
  results.push({
    name: "spec-coverage",
    blocking: true,
    status: missing.length ? "failed" : "passed",
    details: missing.length
      ? `Fichiers à créer selon la spécification mais absents : ${missing.join(", ")}`
      : "Tous les fichiers à créer existent.",
  });

  // 3) Dérive de périmètre
  const unplanned = writtenFiles.filter((f) => !planned.has(f) && !isTestFile(f));
  results.push({
    name: "scope",
    blocking: cfg.policy.strictScope,
    status: unplanned.length ? "failed" : "passed",
    details: unplanned.length
      ? `Fichiers écrits hors spécification : ${unplanned.join(", ")}. Justifiez-les dans le rapport ou ramenez le changement dans le périmètre.`
      : "Aucune dérive de périmètre.",
  });

  // 4) Lint / types
  results.push(await commandGate("lint", cfg.lintCommand, cfg));
  // 5) Tests
  results.push(await commandGate("tests", cfg.testCommand, cfg));

  for (const g of results) tracer.event("gate", { name: g.name, status: g.status, blocking: g.blocking });
  return results;
}

async function commandGate(name: string, command: string | undefined, cfg: HarnessConfig): Promise<GateResult> {
  if (!command) {
    return {
      name,
      blocking: false,
      status: "skipped",
      details: `${name === "tests" ? "TEST_COMMAND" : "LINT_COMMAND"} non configurée : vérification non exécutée.`,
    };
  }
  const r = await runCommand(command, cfg.repoRoot, cfg.commandTimeoutMs);
  return {
    name,
    blocking: true,
    status: r.ok ? "passed" : "failed",
    details: r.ok ? `OK (${r.durationMs} ms)` : `Code ${r.exitCode} :\n${r.output}`,
  };
}

export const blockingFailures = (gates: GateResult[]) =>
  gates.filter((g) => g.blocking && g.status === "failed");

/** Texte de retour envoyé à l'agent développeur au tour suivant. */
export function formatFeedback(
  gates: GateResult[],
  findings: { severity: string; file?: string; issue: string; suggestion: string }[],
): string {
  const lines: string[] = [];
  const failing = gates.filter((g) => g.status === "failed");
  if (failing.length) {
    lines.push("### Vérifications automatiques en échec");
    for (const g of failing) lines.push(`- **${g.name}**${g.blocking ? " (bloquant)" : " (avertissement)"} : ${g.details}`);
  }
  if (findings.length) {
    lines.push("### Retours du relecteur indépendant");
    for (const f of findings) {
      lines.push(`- [${f.severity}]${f.file ? ` ${f.file} :` : ""} ${f.issue} → ${f.suggestion}`);
    }
  }
  return lines.join("\n");
}
