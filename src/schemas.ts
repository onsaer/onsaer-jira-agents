import { z } from "zod";

/**
 * Le « contrat » entre les deux agents.
 *
 * L'agent 1 doit produire exactement cette structure (sortie structurée validée
 * par Zod). L'agent 2 ne reçoit QUE ceci : il ne voit ni le ticket Jira,
 * ni la conversation de l'agent 1. C'est ce qui les rend indépendants.
 */
export const TechnicalSpecSchema = z.object({
  ticketKey: z.string().describe("Clé du ticket Jira, ex. PROJ-123"),
  title: z.string().describe("Titre court de la fonctionnalité ou du correctif"),
  summary: z.string().describe("Résumé du besoin en 2-4 phrases"),
  assumptions: z
    .array(z.string())
    .describe("Hypothèses faites quand le ticket est ambigu ou incomplet"),
  openQuestions: z
    .array(z.string())
    .describe("Questions à poser à l'analyste/PO avant ou pendant l'implémentation"),
  acceptanceCriteria: z
    .array(z.string())
    .describe("Critères d'acceptation vérifiables, un par ligne"),
  technicalApproach: z
    .string()
    .describe("Approche technique : composants, couches, flux de données"),
  filesToChange: z
    .array(
      z.object({
        path: z.string().describe("Chemin relatif dans le dépôt"),
        action: z.enum(["create", "modify"]),
        purpose: z.string().describe("Ce qui doit y être fait"),
      }),
    )
    .describe("Fichiers à créer ou modifier"),
  testPlan: z
    .array(
      z.object({
        name: z.string().describe("Nom du cas de test"),
        type: z.enum(["unit", "integration", "e2e"]),
        description: z.string().describe("Ce que le test vérifie (given/when/then)"),
      }),
    )
    .describe("Cas de test à écrire, en lien avec les critères d'acceptation"),
  risks: z.array(z.string()).describe("Risques et points d'attention"),
});

export type TechnicalSpec = z.infer<typeof TechnicalSpecSchema>;

/**
 * Verdict du relecteur indépendant (agent 3). Séparer « celui qui produit » de
 * « celui qui évalue » évite qu'un agent s'auto-valide trop facilement.
 */
export const ReviewSchema = z.object({
  verdict: z
    .enum(["approve", "changes_requested"])
    .describe("approve UNIQUEMENT s'il ne reste aucun problème de sévérité blocker ou major"),
  summary: z.string().describe("Synthèse de la relecture en 2-4 phrases"),
  criteriaCoverage: z
    .array(
      z.object({
        criterion: z.string().describe("Critère d'acceptation de la spécification"),
        covered: z.boolean().describe("Le code ET un test le couvrent-ils réellement ?"),
        evidence: z.string().describe("Fichier(s) / test(s) qui le prouvent, ou ce qui manque"),
      }),
    )
    .describe("Un élément par critère d'acceptation"),
  findings: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor"]),
      file: z.string().optional(),
      issue: z.string(),
      suggestion: z.string().describe("Correction concrète attendue"),
    }),
  ),
});

export type Review = z.infer<typeof ReviewSchema>;

/** Rendu Markdown de la spec : lisible par un humain (analyste, relecteur). */
export function specToMarkdown(spec: TechnicalSpec): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "_Aucun_";

  return `# ${spec.ticketKey} — ${spec.title}

## Résumé
${spec.summary}

## Hypothèses
${list(spec.assumptions)}

## Questions ouvertes
${list(spec.openQuestions)}

## Critères d'acceptation
${list(spec.acceptanceCriteria)}

## Approche technique
${spec.technicalApproach}

## Fichiers concernés
${spec.filesToChange.map((f) => `- \`${f.path}\` (${f.action}) — ${f.purpose}`).join("\n")}

## Plan de tests
${spec.testPlan.map((t) => `- **${t.name}** [${t.type}] — ${t.description}`).join("\n")}

## Risques
${list(spec.risks)}
`;
}
