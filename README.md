# jira-agents — pipeline à trois agents avec harnais

```
Ticket Jira ─► Agent 1 (analyste) ─► spec.json ─► ✋ validation humaine
                                                     │
          ┌──────────────────────────────────────────┘
          ▼
   Agent 2 (développeur) ─► quality gates (tests, lint, périmètre…) ─► Agent 3 (relecteur)
          ▲                                                                   │
          └──────────── retours à traiter (max MAX_ROUNDS tours) ◄────────────┘
```

Les agents sont indépendants : l'agent 2 ne voit que la spécification (jamais le ticket) ; l'agent 3 ne voit ni le ticket ni le raisonnement de l'agent 2, seulement la spécification et le code.

## Installation et usage

```bash
npm install
cp .env.example .env        # puis renseigner (Jira, clé API, TARGET_REPO, TEST_COMMAND…)
npm start -- PROJ-123               # pipeline complet
npm start -- PROJ-123 --spec-only   # s'arrête après la spécification
npm start -- PROJ-123 --resume      # reprend un run interrompu
npm start -- PROJ-123 --yes         # approuve automatiquement le point de contrôle (CI)
npm test                            # tests du harnais (déterministes, sans appel modèle)
npm run gc -- --keep 20 [--dry-run] # ménage des anciens runs
```

Code de sortie : `0` validé · `2` non validé après `MAX_ROUNDS` (escalade humaine) · `1` erreur.
Node.js ≥ 22. Lancez l'agent 2 sur une **branche dédiée** et relisez le `git diff`.

## Les piliers du harnais et où les trouver

| Pilier | Ce que ça fait ici | Fichier |
| --- | --- | --- |
| **Context engineering** | Briefing préparé pour les agents : instructions du dépôt (AGENTS.md, CLAUDE.md, README), stack détectée (Angular, Spring, version de Java), carte du dépôt ; détail à la demande via les outils | `context.ts` |
| **Contraintes / guardrails** (feedforward) | Refus déterministes avant écriture : secrets, lockfiles, CI, taille, quota de fichiers, `STRICT_SCOPE` ; chaque refus explique quoi faire | `policy.ts` |
| **Conception des outils** | Outils étroits, lecture par extraits, recherche, erreurs actionnables (« ERREUR… Que faire : … ») ; relecteur en lecture seule | `tools.ts` |
| **Feedback loops** (correctif) | `run_tests` / `run_lint` à disposition de l'agent + boucle développeur → vérifications → retours → développeur | `tools.ts`, `main.ts` |
| **Quality gates** (enforcement) | Vérifications indépendantes du discours de l'agent : tests écrits, fichiers de la spec créés, dérive de périmètre, lint, tests | `verify.ts` |
| **Évaluateur indépendant** | Agent 3 : couverture des critères d'acceptation, qualité, cohérence spec/code ; sortie structurée | `agents.ts`, `schemas.ts` |
| **Hooks / middleware** | Retry avec backoff, budget d'appels modèle et d'outils, détection de boucle, compaction automatique de l'historique | `agents.ts`, `tools.ts` |
| **Mémoire / état** | `state.json` + `spec.json` persistés : reprise (`--resume`), audit ; état partagé entre tours | `state.ts`, `main.ts` |
| **Observabilité** | `trace.jsonl` (1 ligne = 1 événement) + `metrics.json` (appels, tokens, outils, refus, boucles) | `observability.ts` |
| **Humain dans la boucle** | Validation de la spécification avant toute écriture ; escalade si non validé après N tours | `hitl.ts`, `main.ts` |
| **Garbage collection** | `npm run gc` : runs bloqués → `aborted`, anciens runs supprimés ; gate `scope` contre la dérive côté dépôt | `gc.ts`, `verify.ts` |

## Hors périmètre (volontairement)

- **Sandbox d'exécution** : pas de conteneur, ni isolation réseau/système, ni limites de ressources. Le confinement des chemins à `TARGET_REPO` (`safePath`) n'est qu'une validation d'arguments, et `TEST_COMMAND` / `LINT_COMMAND` s'exécutent tels quels sur votre machine : ne mettez que des commandes de confiance. Le modèle, lui, ne peut lancer que ces deux commandes, sans arguments.
- **Évaluations de régression du harnais** (jeu de tickets de référence rejoué à chaque changement de prompt) : non incluses.

## Sorties d'un run (`out/<CLÉ>/`)

`spec.md` · `spec.json` · `dev-tour-N.md` · `rapport.md` · `trace.jsonl` · `metrics.json` · `state.json`
