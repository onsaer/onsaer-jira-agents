import { promises as fs } from "node:fs";
import path from "node:path";
import { loadState, saveState } from "./state.js";

/**
 * PILIER « GARBAGE COLLECTION / ENTROPIE ».
 *
 * Un harnais qui tourne souvent accumule des déchets : anciens runs, runs restés
 * « running » après un plantage, traces obsolètes. Cette commande fait le ménage :
 *   - marque « aborted » les runs bloqués en « running » depuis plus d'une heure ;
 *   - supprime les dossiers de runs les plus anciens (on garde les N plus récents).
 *
 *   npm run gc -- [--keep 20] [--dry-run]
 *
 * (La dérive côté dépôt cible est, elle, traitée par le gate « scope » de verify.ts.)
 */
const STALE_MS = 60 * 60 * 1000;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const keepIdx = args.indexOf("--keep");
  const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : 20;
  const outRoot = path.resolve(process.env.OUT_DIR ?? "out");

  let names: string[];
  try {
    names = (await fs.readdir(outRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    console.log(`Rien à nettoyer : ${outRoot} n'existe pas.`);
    return;
  }

  const runs = await Promise.all(
    names.map(async (name) => {
      const dir = path.join(outRoot, name);
      return { name, dir, mtime: (await fs.stat(dir)).mtimeMs, state: await loadState(dir) };
    }),
  );

  for (const r of runs) {
    if (r.state?.status === "running" && Date.now() - Date.parse(r.state.updatedAt) > STALE_MS) {
      console.log(`Run bloqué → aborted : ${r.name}`);
      if (!dryRun) {
        r.state.status = "aborted";
        await saveState(r.dir, r.state);
      }
    }
  }

  const obsolete = runs.sort((a, b) => b.mtime - a.mtime).slice(Math.max(keep, 0));
  for (const r of obsolete) {
    console.log(`${dryRun ? "[simulation] " : ""}Suppression : ${r.name}`);
    if (!dryRun) await fs.rm(r.dir, { recursive: true, force: true });
  }
  console.log(`Terminé : ${runs.length} run(s), ${obsolete.length} supprimé(s)${dryRun ? " (simulation)" : ""}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
