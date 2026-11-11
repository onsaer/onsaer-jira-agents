import path from "node:path";
import { DEFAULT_DENY_WRITE, type Policy } from "./policy.js";

export interface Flags {
  /** S'arrêter après la spécification. */
  specOnly: boolean;
  /** Reprendre un run interrompu (réutilise spec + approbation déjà faites). */
  resume: boolean;
  /** Approuver automatiquement les points de contrôle humains (CI, scripts). */
  yes: boolean;
}

export interface HarnessConfig {
  ticketKey: string;
  /** Un modèle par rôle : on peut mettre un modèle plus costaud pour la relecture. */
  models: { spec: string; dev: string; review: string };
  repoRoot: string;
  outDir: string;
  testCommand?: string;
  lintCommand?: string;
  /** Nombre maximal de tours développeur → vérification → relecture. */
  maxRounds: number;
  /** Budget d'appels d'outils par tour de l'agent développeur. */
  maxToolCallsPerRound: number;
  /** Budget d'appels au modèle par agent et par tour. */
  maxModelCalls: number;
  recursionLimit: number;
  commandTimeoutMs: number;
  /** Seuil de tokens au-delà duquel l'historique de l'agent est résumé (compaction). */
  compactionTokens: number;
  policy: Policy;
  flags: Flags;
}

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const csv = (name: string) =>
  (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(ticketKey: string, flags: Flags): HarnessConfig {
  const base = process.env.MODEL ?? "anthropic:claude-sonnet-5-5";
  return {
    ticketKey,
    models: {
      spec: process.env.SPEC_MODEL ?? base,
      dev: process.env.DEV_MODEL ?? base,
      review: process.env.REVIEW_MODEL ?? base,
    },
    repoRoot: path.resolve(process.env.TARGET_REPO ?? "../mon-projet"),
    outDir: path.resolve(process.env.OUT_DIR ?? "out", ticketKey),
    testCommand: process.env.TEST_COMMAND || undefined,
    lintCommand: process.env.LINT_COMMAND || undefined,
    maxRounds: num("MAX_ROUNDS", 3),
    maxToolCallsPerRound: num("MAX_TOOL_CALLS", 80),
    maxModelCalls: num("MAX_MODEL_CALLS", 60),
    recursionLimit: num("RECURSION_LIMIT", 150),
    commandTimeoutMs: num("COMMAND_TIMEOUT_MS", 5 * 60_000),
    compactionTokens: num("COMPACTION_TOKENS", 60_000),
    policy: {
      denyWrite: [...DEFAULT_DENY_WRITE, ...csv("WRITE_DENY")],
      maxFiles: num("MAX_FILES", 25),
      maxFileBytes: num("MAX_FILE_BYTES", 200_000),
      strictScope: process.env.STRICT_SCOPE === "true",
      plannedFiles: new Set(),
    },
    flags,
  };
}
