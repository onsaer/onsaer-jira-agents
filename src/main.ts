import { promises as fs } from "node:fs";
import path from "node:path";
import { runDevAgent, runReviewAgent, runSpecAgent } from "./agents.js";
import { loadConfig, type Flags } from "./config.js";
import { buildRepoContext } from "./context.js";
import { exists } from "./fsutil.js";
import { askApproval } from "./hitl.js";
import { fetchJiraTicket } from "./jira.js";
import { Tracer } from "./observability.js";
import { normalizeRel } from "./policy.js";
import { TechnicalSpecSchema, specToMarkdown, type Review, type TechnicalSpec } from "./schemas.js";
import { loadState, newState, saveState, type RoundRecord } from "./state.js";
import type { ToolContext } from "./tools.js";
import { blockingFailures, formatFeedback, runQualityGates, type GateResult } from "./verify.js";

/**
 * Usage :
 *   npm start -- PROJ-123                 # pipeline complet
 *   npm start -- PROJ-123 --spec-only     # s'arrête après la spécification
 *   npm start -- PROJ-123 --resume        # reprend un run interrompu
 *   npm start -- PROJ-123 --yes           # approuve automatiquement (CI)
 *
 * Code de sortie : 0 = validé · 2 = non validé après MAX_ROUNDS (escalade humaine) · 1 = erreur.
 */
async function main() {
  const args = process.argv.slice(2);
  const ticketKey = args.find((a) => !a.startsWith("--"));
  if (!ticketKey) {
    console.error("Usage : npm start -- <CLÉ-TICKET> [--spec-only] [--resume] [--yes]");
    process.exit(1);
  }
  const flags: Flags = {
    specOnly: args.includes("--spec-only"),
    resume: args.includes("--resume"),
    yes: args.includes("--yes"),
  };

  const cfg = loadConfig(ticketKey, flags);
  if (!(await exists(cfg.repoRoot))) {
    throw new Error(`TARGET_REPO introuvable : ${cfg.repoRoot}`);
  }
  await fs.mkdir(cfg.outDir, { recursive: true });

  // --- État & observabilité ---------------------------------------------------
  const traceFile = path.join(cfg.outDir, "trace.jsonl");
  const previous = flags.resume ? await loadState(cfg.outDir) : undefined;
  if (!previous) await fs.rm(traceFile, { force: true });
  const state = previous ?? newState(ticketKey);
  state.status = "running";
  const tracer = new Tracer(traceFile);
  tracer.event("run_start", { ticketKey, flags, models: cfg.models });
  await saveState(cfg.outDir, state);

  // --- 1) Spécification (agent 1) ----------------------------------------------
  let spec: TechnicalSpec;
  const specFile = path.join(cfg.outDir, "spec.json");
  if (flags.resume && state.stages.spec === "done" && (await exists(specFile))) {
    spec = TechnicalSpecSchema.parse(JSON.parse(await fs.readFile(specFile, "utf8")));
    console.log("[1/3] Spécification reprise depuis le run précédent.");
  } else {
    console.log(`[1/3] Lecture du ticket ${ticketKey} puis agent 1 (spécification)…`);
    const ticket = await fetchJiraTicket(ticketKey);
    spec = await runSpecAgent(cfg, ticket, tracer);
    await fs.writeFile(specFile, JSON.stringify(spec, null, 2));
    await fs.writeFile(path.join(cfg.outDir, "spec.md"), specToMarkdown(spec));
    state.stages.spec = "done";
    state.stages.approval = "pending";
    await saveState(cfg.outDir, state);
  }
  console.log(`      Spécification : ${path.join(cfg.outDir, "spec.md")}`);
  if (spec.openQuestions.length) {
    console.log(`      ⚠ ${spec.openQuestions.length} question(s) ouverte(s) à trancher avec l'analyste.`);
  }
  if (flags.specOnly) {
    state.status = "passed";
    await saveState(cfg.outDir, state);
    return;
  }

  // --- 2) Point de contrôle humain ---------------------------------------------
  if (state.stages.approval !== "done") {
    console.log(
      `\n« ${spec.title} » — ${spec.filesToChange.length} fichier(s), ${spec.testPlan.length} test(s) prévu(s).`,
    );
    const ok = await askApproval("Lancer l'implémentation (agent 2) ?", flags.yes);
    tracer.event("human_checkpoint", { name: "spec-approval", approved: ok });
    if (!ok) {
      state.status = "aborted";
      await saveState(cfg.outDir, state);
      console.log("Arrêt : spécification non approuvée. Corrigez spec.json puis relancez avec --resume.");
      return;
    }
    state.stages.approval = "done";
    await saveState(cfg.outDir, state);
  }

  // --- 3) Boucle développeur → vérifications → relecteur -----------------------
  console.log(`[2/3] Préparation du contexte du dépôt (${cfg.repoRoot})…`);
  const repoContext = await buildRepoContext(cfg.repoRoot);
  const policy = { ...cfg.policy, plannedFiles: new Set(spec.filesToChange.map((f) => normalizeRel(f.path))) };
  const written = new Map<string, number>(); // mémoire du run : fichiers écrits, partagée entre les tours

  let feedback: string | undefined;
  let passed = false;
  let lastGates: GateResult[] = [];
  let lastReview: Review | undefined;
  let lastDevReport = "";

  for (let round = 1; round <= cfg.maxRounds; round++) {
    console.log(`[3/3] Tour ${round}/${cfg.maxRounds} — agent 2 (développeur)…`);
    const mkCtx = (agent: string): ToolContext => ({
      root: cfg.repoRoot,
      policy,
      tracer,
      agent,
      written,
      testCommand: cfg.testCommand,
      lintCommand: cfg.lintCommand,
      commandTimeoutMs: cfg.commandTimeoutMs,
      maxToolCalls: cfg.maxToolCallsPerRound,
    });

    lastDevReport = await runDevAgent({ cfg, spec, toolCtx: mkCtx("dev"), repoContext, feedback, tracer });
    await fs.writeFile(path.join(cfg.outDir, `dev-tour-${round}.md`), lastDevReport);

    console.log("      Vérifications automatiques (quality gates)…");
    lastGates = await runQualityGates({ cfg, spec, written, tracer });
    const failures = blockingFailures(lastGates);

    // Le relecteur n'est sollicité que si les vérifications déterministes passent
    // (inutile de dépenser un appel modèle sur du code qui ne compile pas).
    lastReview = undefined;
    if (failures.length === 0) {
      console.log("      Relecture indépendante (agent 3)…");
      lastReview = await runReviewAgent({ cfg, spec, toolCtx: mkCtx("review"), repoContext, gates: lastGates, tracer });
    }

    const roundPassed = failures.length === 0 && lastReview?.verdict === "approve";
    const record: RoundRecord = {
      round,
      gates: lastGates,
      reviewVerdict: lastReview?.verdict,
      passed: roundPassed,
    };
    state.rounds.push(record);
    await saveState(cfg.outDir, state);
    tracer.event("round_end", { round, passed: roundPassed, blockingFailures: failures.map((f) => f.name) });

    if (roundPassed) {
      passed = true;
      break;
    }

    const blockingFindings = (lastReview?.verdict === "changes_requested" ? lastReview.findings : []).filter(
      (f) => f.severity !== "minor",
    );
    feedback = formatFeedback(lastGates, blockingFindings);
    console.log(`      Tour ${round} non validé → retours renvoyés à l'agent 2.`);
  }

  // --- Rapport final ------------------------------------------------------------
  state.status = passed ? "passed" : "failed";
  await saveState(cfg.outDir, state);
  tracer.event("run_end", { passed, metrics: tracer.metrics });
  await fs.writeFile(path.join(cfg.outDir, "metrics.json"), JSON.stringify(tracer.metrics, null, 2));
  await fs.writeFile(
    path.join(cfg.outDir, "rapport.md"),
    buildReport({ ticketKey, spec, passed, state, lastGates, lastReview, lastDevReport, written, tracer }),
  );

  console.log(
    passed
      ? `\n✔ Validé après ${state.rounds.length} tour(s). Relisez le diff (git diff) avant de commiter.`
      : `\n✖ Non validé après ${cfg.maxRounds} tour(s) : escalade humaine nécessaire (voir rapport.md).`,
  );
  console.log(`  Rapport : ${path.join(cfg.outDir, "rapport.md")} · Trace : ${traceFile}`);
  process.exitCode = passed ? 0 : 2;
}

function buildReport(r: {
  ticketKey: string;
  spec: TechnicalSpec;
  passed: boolean;
  state: { rounds: RoundRecord[] };
  lastGates: GateResult[];
  lastReview?: Review;
  lastDevReport: string;
  written: Map<string, number>;
  tracer: Tracer;
}): string {
  const m = r.tracer.metrics;
  const gateRows = r.lastGates
    .map((g) => `| ${g.name} | ${g.status} | ${g.blocking ? "oui" : "non"} |`)
    .join("\n");
  const rounds = r.state.rounds
    .map((x) => `- Tour ${x.round} : ${x.passed ? "validé" : "non validé"}${x.reviewVerdict ? ` (relecteur : ${x.reviewVerdict})` : " (relecteur non sollicité : vérifications en échec)"}`)
    .join("\n");

  return `# Rapport — ${r.ticketKey} : ${r.spec.title}

**Résultat : ${r.passed ? "✔ validé" : "✖ NON validé — escalade humaine nécessaire"}**

## Tours
${rounds}

## Vérifications automatiques (dernier tour)
| Gate | Statut | Bloquant |
| --- | --- | --- |
${gateRows}

${r.lastGates.filter((g) => g.status === "failed").map((g) => `### ${g.name}\n\`\`\`\n${g.details}\n\`\`\``).join("\n\n")}

## Relecture indépendante
${r.lastReview
    ? `**Verdict : ${r.lastReview.verdict}**\n\n${r.lastReview.summary}\n\n${r.lastReview.criteriaCoverage.map((c) => `- [${c.covered ? "x" : " "}] ${c.criterion} — ${c.evidence}`).join("\n")}\n\n${r.lastReview.findings.map((f) => `- [${f.severity}]${f.file ? ` ${f.file} :` : ""} ${f.issue} → ${f.suggestion}`).join("\n")}`
    : "_Non effectuée au dernier tour (vérifications bloquantes en échec)._"}

## Fichiers écrits
${[...r.written.entries()].map(([f, n]) => `- ${f} (${n} écriture(s))`).join("\n") || "_Aucun_"}

## Rapport de l'agent développeur (dernier tour)
${r.lastDevReport}

## Métriques
- Appels modèle : ${m.llmCalls} · tokens entrée/sortie : ${m.inputTokens} / ${m.outputTokens}
- Appels d'outils : ${JSON.stringify(m.toolCalls)}
- Erreurs d'outils : ${m.toolErrors} · refus de politique : ${m.policyDenials} · boucles détectées : ${m.loopTrips}
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
