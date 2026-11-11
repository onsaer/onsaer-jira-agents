import { createInterface } from "node:readline/promises";

/**
 * PILIER « HUMAIN DANS LA BOUCLE ».
 *
 * Point de contrôle explicite entre la spécification et l'implémentation : c'est là
 * qu'un humain valide (ou non) ce que l'agent va construire. Les décisions
 * irréversibles restent aux humains ; l'agent 2 n'écrit rien avant ce « oui ».
 *
 * - Terminal interactif : on pose la question.
 * - Pas de terminal (CI, cron) : on refuse par défaut, sauf option --yes explicite.
 */
export async function askApproval(question: string, autoApprove: boolean): Promise<boolean> {
  if (autoApprove) {
    console.log(`${question} → approuvé automatiquement (--yes)`);
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log("Pas de terminal interactif : approbation refusée par défaut. Relancez avec --yes pour passer outre.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [o/N] `)).trim().toLowerCase();
    return ["o", "oui", "y", "yes"].includes(answer);
  } finally {
    rl.close();
  }
}
