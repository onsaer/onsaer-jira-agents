import { promises as fs } from "node:fs";
import path from "node:path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { runCommand } from "./exec.js";
import { IGNORED_DIRS, walkFiles } from "./fsutil.js";
import type { Tracer } from "./observability.js";
import { checkWrite, globToRegExp, normalizeRel, type Policy } from "./policy.js";

const MAX_READ_CHARS = 12_000;
const MAX_SEARCH_MATCHES = 40;
/** Préfixes des retours qui signalent un échec de l'outil lui-même (pour les métriques). */
const FAILURE_PREFIXES = ["ERREUR", "REFUSÉ", "BOUCLE", "BUDGET"];

export interface ToolContext {
  root: string;
  policy: Policy;
  tracer: Tracer;
  /** Nom de l'agent, pour la trace (ex. "dev", "review"). */
  agent: string;
  /** Fichiers écrits -> nombre d'écritures. Partagé entre les tours pour garder la mémoire du run. */
  written: Map<string, number>;
  testCommand?: string;
  lintCommand?: string;
  commandTimeoutMs: number;
  /** Budget d'appels d'outils pour cet agent. */
  maxToolCalls: number;
}

/**
 * PILIERS « CONCEPTION DES OUTILS », « GUARDRAILS » et « HOOKS DÉTERMINISTES ».
 *
 * Chaque outil est enveloppé par `guarded` qui applique, hors du modèle :
 *  - un budget d'appels (le modèle ne peut pas boucler indéfiniment) ;
 *  - une détection de boucle (3e appel identique sans changement entre-temps) ;
 *  - la conversion de toute exception en message d'erreur ACTIONNABLE
 *    (« ERREUR : … Que faire : … ») plutôt qu'un plantage ;
 *  - la trace de chaque appel (observabilité).
 *
 * `mode: "read-only"` : l'agent relecteur n'a ni écriture ni exécution de commandes.
 *
 * Note : le confinement des chemins à la racine du dépôt (safePath) est un simple
 * garde-fou de validation d'arguments, pas une sandbox d'exécution.
 */
export function createRepoTools(
  ctx: ToolContext,
  mode: "read-write" | "read-only",
): StructuredToolInterface[] {
  const root = path.resolve(ctx.root);
  let calls = 0;
  const seen = new Map<string, number>();

  function safePath(relative: string): string {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`chemin hors du dépôt : ${relative}`);
    }
    return full;
  }

  function guarded<A>(name: string, run: (args: A) => Promise<string>) {
    return async (args: A): Promise<string> => {
      const t0 = Date.now();
      let out: string;
      calls += 1;

      if (calls > ctx.maxToolCalls) {
        out = `BUDGET ÉPUISÉ : ${ctx.maxToolCalls} appels d'outils utilisés. Que faire : n'appelez plus d'outil et rédigez maintenant votre rapport final (ce qui est fait, ce qui reste).`;
      } else {
        const key = `${name}:${JSON.stringify(args)}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n > 2) {
          ctx.tracer.metrics.loopTrips += 1;
          out = `BOUCLE DÉTECTÉE : « ${name} » appelé ${n} fois avec les mêmes arguments sans rien changer entre-temps. Que faire : changez d'approche (lisez un autre fichier, corrigez le code avant de relancer les tests) ou concluez par votre rapport.`;
        } else {
          try {
            out = await run(args);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            out = `ERREUR : ${msg}. Que faire : vérifiez le chemin avec list_dir (racine : '.') et les arguments, puis réessayez.`;
          }
        }
      }

      ctx.tracer.toolCall(ctx.agent, name, !FAILURE_PREFIXES.some((p) => out.startsWith(p)), Date.now() - t0);
      return out;
    };
  }

  const listDir = tool(
    guarded("list_dir", async ({ dir }: { dir: string }) => {
      const entries = await fs.readdir(safePath(dir), { withFileTypes: true });
      return (
        entries
          .filter((e) => !IGNORED_DIRS.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n") || "(dossier vide)"
      );
    }),
    {
      name: "list_dir",
      description: "Liste le contenu d'un dossier du dépôt (chemin relatif ; '.' pour la racine).",
      schema: z.object({ dir: z.string().default(".") }),
    },
  );

  const readFile = tool(
    guarded("read_file", async ({ filePath, startLine, endLine }: { filePath: string; startLine?: number; endLine?: number }) => {
      const text = await fs.readFile(safePath(filePath), "utf8");
      if (startLine || endLine) {
        const lines = text.split("\n").slice((startLine ?? 1) - 1, endLine ?? undefined);
        return lines.map((l, i) => `${(startLine ?? 1) + i}: ${l}`).join("\n").slice(0, MAX_READ_CHARS);
      }
      return text.length > MAX_READ_CHARS
        ? `${text.slice(0, MAX_READ_CHARS)}\n…[tronqué à ${MAX_READ_CHARS} caractères : utilisez startLine/endLine ou search_files pour cibler]`
        : text;
    }),
    {
      name: "read_file",
      description:
        "Lit un fichier texte du dépôt (chemin relatif). startLine/endLine (1-based) permettent de ne lire qu'un extrait d'un gros fichier. À utiliser AVANT de modifier un fichier existant.",
      schema: z.object({
        filePath: z.string().describe("Chemin relatif dans le dépôt"),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      }),
    },
  );

  const searchFiles = tool(
    guarded("search_files", async ({ pattern, glob }: { pattern: string; glob?: string }) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        return `ERREUR : expression régulière invalide « ${pattern} ». Que faire : échappez les caractères spéciaux ou simplifiez le motif.`;
      }
      const globRe = glob ? globToRegExp(glob) : undefined;
      const hits: string[] = [];
      for await (const rel of walkFiles(root)) {
        if (globRe && !globRe.test(rel)) continue;
        const stat = await fs.stat(path.join(root, rel));
        if (stat.size > 300_000) continue;
        const text = await fs.readFile(path.join(root, rel), "utf8").catch(() => "");
        if (text.includes("\u0000")) continue; // binaire
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= MAX_SEARCH_MATCHES) return `${hits.join("\n")}\n…[limité à ${MAX_SEARCH_MATCHES} résultats : affinez le motif ou le glob]`;
          }
        }
      }
      return hits.join("\n") || "(aucun résultat)";
    }),
    {
      name: "search_files",
      description:
        "Cherche une expression régulière (insensible à la casse) dans les fichiers du dépôt. 'glob' optionnel pour restreindre (ex. 'src/**/*.ts'). Renvoie chemin:ligne: texte.",
      schema: z.object({
        pattern: z.string().describe("Expression régulière"),
        glob: z.string().optional().describe("Filtre de chemins, ex. src/**/*.ts"),
      }),
    },
  );

  const tools: StructuredToolInterface[] = [listDir, readFile, searchFiles];
  if (mode === "read-only") return tools;

  const writeFile = tool(
    guarded("write_file", async ({ filePath, content }: { filePath: string; content: string }) => {
      const full = safePath(filePath);
      const rel = normalizeRel(path.relative(root, full));
      const verdict = checkWrite(ctx.policy, rel, content, ctx.written);
      if (!verdict.ok) {
        ctx.tracer.metrics.policyDenials += 1;
        ctx.tracer.event("policy_denied", { agent: ctx.agent, path: rel, reason: verdict.reason });
        return `REFUSÉ : ${verdict.reason}. Que faire : ${verdict.hint}`;
      }
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      ctx.written.set(rel, (ctx.written.get(rel) ?? 0) + 1);
      seen.clear(); // l'état du dépôt a changé : on repart à zéro pour la détection de boucle
      return `Écrit : ${rel} (${content.length} caractères)`;
    }),
    {
      name: "write_file",
      description:
        "Crée ou remplace entièrement un fichier. Fournir le contenu COMPLET du fichier, pas un extrait. Peut être refusé par la politique du harnais (le message explique alors quoi faire).",
      schema: z.object({
        filePath: z.string().describe("Chemin relatif dans le dépôt"),
        content: z.string().describe("Contenu complet du fichier"),
      }),
    },
  );
  tools.push(writeFile);

  const commandTool = (name: "run_tests" | "run_lint", command: string, description: string) =>
    tool(
      guarded(name, async () => {
        const r = await runCommand(command, root, ctx.commandTimeoutMs);
        return r.ok
          ? `SUCCÈS (${r.durationMs} ms)\n${r.output}`
          : `ÉCHEC (code ${r.exitCode}, ${r.durationMs} ms)\n${r.output}\nQue faire : repérez la PREMIÈRE erreur ci-dessus, corrigez sa cause (pas le test lui-même, sauf si la spécification le justifie), puis relancez.`;
      }),
      { name, description, schema: z.object({}) },
    );

  if (ctx.testCommand) {
    tools.push(commandTool("run_tests", ctx.testCommand, "Lance la commande de tests du projet. Renvoie SUCCÈS ou ÉCHEC avec la fin de la sortie."));
  }
  if (ctx.lintCommand) {
    tools.push(commandTool("run_lint", ctx.lintCommand, "Lance le linter / la vérification de types du projet. Renvoie SUCCÈS ou ÉCHEC avec la fin de la sortie."));
  }

  return tools;
}
