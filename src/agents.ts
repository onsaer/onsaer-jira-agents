import {
  createAgent,
  modelCallLimitMiddleware,
  modelRetryMiddleware,
  summarizationMiddleware,
} from "langchain";
import type { HarnessConfig } from "./config.js";
import type { JiraTicket } from "./jira.js";
import { TraceHandler, type Tracer } from "./observability.js";
import { ReviewSchema, TechnicalSpecSchema, type Review, type TechnicalSpec } from "./schemas.js";
import { createRepoTools, type ToolContext } from "./tools.js";
import type { GateResult } from "./verify.js";

/**
 * Trois agents, trois rôles, trois contextes séparés :
 *
 *   Agent 1 (analyste)    : ticket          -> spécification structurée
 *   Agent 2 (développeur) : spécification   -> code + tests   (n'a JAMAIS vu le ticket)
 *   Agent 3 (relecteur)   : spécification + code -> verdict   (n'a JAMAIS vu le raisonnement de l'agent 2)
 *
 * Middlewares du harnais (hooks déterministes autour du modèle) :
 *  - modelRetryMiddleware     : réessaie les erreurs transitoires (réseau, 429, 5xx) avec backoff ;
 *  - modelCallLimitMiddleware : budget d'appels modèle par exécution ;
 *  - summarizationMiddleware  : compaction — résume l'historique quand il devient trop long.
 */

// onFailure: "error" est essentiel : la valeur par défaut ("continue") transformerait une panne
// définitive du modèle en faux message de réponse, et le harnais continuerait comme si de rien n'était.
const retry = () => modelRetryMiddleware({ maxRetries: 3, onFailure: "error" });

/** Une sortie structurée absente (ex. budget d'appels épuisé) doit être une erreur explicite. */
function requireStructured<T>(value: T | undefined, agent: string): T {
  if (value === undefined || value === null) {
    throw new Error(
      `L'agent « ${agent} » n'a pas produit de sortie structurée (budget d'appels modèle épuisé ou échec du modèle). Augmentez MAX_MODEL_CALLS ou consultez trace.jsonl.`,
    );
  }
  return value;
}
const budget = (cfg: HarnessConfig) =>
  modelCallLimitMiddleware({ runLimit: cfg.maxModelCalls, exitBehavior: "end" });
const compaction = (cfg: HarnessConfig, model: string) =>
  summarizationMiddleware({ model, trigger: { tokens: cfg.compactionTokens }, keep: { messages: 20 } });

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text ?? ""))
      .join("");
  }
  return JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// Agent 1 — Analyste technique
// ---------------------------------------------------------------------------

const SPEC_SYSTEM_PROMPT = `Tu es un analyste technique senior.
Tu reçois un ticket Jira et tu produis une spécification technique exploitable
par un développeur qui N'AURA PAS accès au ticket : tout ce qui est nécessaire
doit figurer dans ta spécification.

Règles :
- Ne devine pas en silence : consigne chaque hypothèse dans "assumptions" et
  chaque zone d'ombre dans "openQuestions".
- Les critères d'acceptation doivent être vérifiables (testables).
- Chaque critère d'acceptation doit être couvert par au moins un cas du plan de tests.
- Reste factuel et concis ; n'invente pas de fonctionnalités absentes du ticket.
- Écris en français ; garde en anglais les identifiants techniques.`;

export async function runSpecAgent(
  cfg: HarnessConfig,
  ticket: JiraTicket,
  tracer: Tracer,
): Promise<TechnicalSpec> {
  const agent = createAgent({
    model: cfg.models.spec,
    tools: [],
    systemPrompt: SPEC_SYSTEM_PROMPT,
    responseFormat: TechnicalSpecSchema,
    middleware: [retry(), budget(cfg)],
  });

  const comments = ticket.comments.length
    ? ticket.comments.map((c) => `- ${c.author} : ${c.body}`).join("\n")
    : "(aucun)";

  const result = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content: `Ticket ${ticket.key} (${ticket.issueType}, priorité ${ticket.priority})
Labels : ${ticket.labels.join(", ") || "(aucun)"}

Titre : ${ticket.summary}

Description :
${ticket.description}

Commentaires :
${comments}`,
        },
      ],
    },
    { recursionLimit: cfg.recursionLimit, callbacks: [new TraceHandler(tracer, "spec")] },
  );

  return requireStructured(result.structuredResponse as TechnicalSpec | undefined, "spec");
}

// ---------------------------------------------------------------------------
// Agent 2 — Développeur
// ---------------------------------------------------------------------------

const DEV_SYSTEM_PROMPT = `Tu es un développeur senior. Tu implémentes une spécification technique
dans le dépôt qui t'est donné, via les outils fournis (list_dir, read_file, search_files,
write_file, et run_tests / run_lint s'ils sont disponibles).

Méthode :
1. Appuie-toi sur le contexte du dépôt ci-dessous, puis explore avec les outils pour
   repérer les conventions (nommage, structure, framework de test). Respecte-les.
2. Implémente le code décrit dans "filesToChange". Avant de modifier un fichier existant,
   lis-le ; réécris-le en entier avec write_file en conservant ce qui n'est pas concerné.
3. Écris les tests du "testPlan" (un test par cas, nommé clairement).
4. Si run_tests / run_lint sont disponibles, lance-les ; en cas d'échec, corrige la CAUSE
   puis relance.
5. Termine par un court rapport : fichiers créés/modifiés, tests écrits, résultat des tests,
   et tout écart par rapport à la spécification (avec la raison).

Contraintes :
- N'invente pas d'exigences : si la spécification est ambiguë, applique ses "assumptions"
  et signale le point dans ton rapport.
- Ne touche qu'aux fichiers nécessaires. Ne supprime rien.
- Les outils peuvent refuser une action (« REFUSÉ… Que faire : … ») : suis la consigne
  au lieu d'insister ou de contourner.
- Si on te fournit des « retours à traiter », corrige-les en priorité : ils viennent de
  vérifications automatiques et d'un relecteur indépendant.`;

export async function runDevAgent(input: {
  cfg: HarnessConfig;
  spec: TechnicalSpec;
  toolCtx: ToolContext;
  repoContext: string;
  feedback?: string;
  tracer: Tracer;
}): Promise<string> {
  const { cfg, spec, toolCtx, repoContext, feedback, tracer } = input;

  const agent = createAgent({
    model: cfg.models.dev,
    tools: createRepoTools(toolCtx, "read-write"),
    systemPrompt: `${DEV_SYSTEM_PROMPT}\n\n${repoContext}`,
    middleware: [retry(), budget(cfg), compaction(cfg, cfg.models.dev)],
  });

  // Indépendance : l'agent 2 ne reçoit QUE la spécification (+ retours éventuels),
  // jamais le ticket ni l'historique de l'agent 1.
  const task = feedback
    ? `Spécification à implémenter :\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\n` +
      `Un tour précédent a déjà écrit du code dans le dépôt (relis les fichiers avant de les modifier).\n` +
      `## Retours à traiter\n${feedback}`
    : `Voici la spécification technique à implémenter :\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``;

  const result = await agent.invoke(
    { messages: [{ role: "user", content: task }] },
    { recursionLimit: cfg.recursionLimit, callbacks: [new TraceHandler(tracer, "dev")] },
  );

  return textOf(result.messages.at(-1)?.content);
}

// ---------------------------------------------------------------------------
// Agent 3 — Relecteur indépendant (évaluateur)
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT = `Tu es un relecteur de code senior, indépendant de l'auteur.
Tu reçois la spécification technique et la liste des fichiers écrits ; tu lis le code avec
les outils (lecture seule). Tu ne corriges rien : tu juges.

Vérifie :
1. Chaque critère d'acceptation est implémenté ET couvert par un test pertinent
   (pas un test vide ou tautologique).
2. Le code respecte les conventions du dépôt et ne contient ni code mort, ni TODO oubliés,
   ni secrets, ni fichiers de debug.
3. Les cas limites et erreurs cités par la spécification (risks) sont traités.
4. Cohérence entre la spécification et ce qui est réellement écrit.

Sévérités : blocker (fonctionnalité fausse/manquante), major (test manquant, bug probable),
minor (style, nommage). Verdict "approve" UNIQUEMENT s'il ne reste aucun blocker ni major.
Sois précis : fichier, problème, correction attendue. N'invente pas de problèmes.`;

export async function runReviewAgent(input: {
  cfg: HarnessConfig;
  spec: TechnicalSpec;
  toolCtx: ToolContext;
  repoContext: string;
  gates: GateResult[];
  tracer: Tracer;
}): Promise<Review> {
  const { cfg, spec, toolCtx, repoContext, gates, tracer } = input;

  const agent = createAgent({
    model: cfg.models.review,
    tools: createRepoTools(toolCtx, "read-only"),
    systemPrompt: `${REVIEW_SYSTEM_PROMPT}\n\n${repoContext}`,
    responseFormat: ReviewSchema,
    middleware: [retry(), budget(cfg), compaction(cfg, cfg.models.review)],
  });

  const files = [...toolCtx.written.keys()].map((f) => `- ${f}`).join("\n") || "(aucun)";
  const gateText = gates.map((g) => `- ${g.name} : ${g.status}`).join("\n");

  const result = await agent.invoke(
    {
      messages: [
        {
          role: "user",
          content: `Spécification :\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\n` +
            `Fichiers écrits :\n${files}\n\nVérifications automatiques :\n${gateText}\n\n` +
            `Relis le code et rends ton verdict.`,
        },
      ],
    },
    { recursionLimit: cfg.recursionLimit, callbacks: [new TraceHandler(tracer, "review")] },
  );

  return requireStructured(result.structuredResponse as Review | undefined, "review");
}
