import path from "node:path";

/**
 * PILIER « CONTRAINTES / GUARDRAILS » (feedforward).
 *
 * Règles déterministes appliquées AVANT l'écriture : le modèle ne peut pas les
 * « négocier ». Quand une règle refuse, le message explique quoi faire à la place
 * (c'est ce qui permet à l'agent de se corriger tout seul).
 */
export interface Policy {
  /** Globs interdits en écriture (secrets, CI, lockfiles, .git…). */
  denyWrite: string[];
  /** Nombre maximum de fichiers distincts écrits pendant un run. */
  maxFiles: number;
  /** Taille maximale d'un fichier écrit. */
  maxFileBytes: number;
  /** Si vrai : seuls les fichiers de la spec (+ fichiers de tests) sont écrivables. */
  strictScope: boolean;
  /** Fichiers prévus par la spécification (chemins normalisés). */
  plannedFiles: Set<string>;
}

export const DEFAULT_DENY_WRITE = [
  "**/.env", "**/.env.*", ".git/**", "**/node_modules/**",
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  ".github/**", ".gitlab-ci.yml", "Jenkinsfile", "**/*.pem", "**/*.key",
];

export function normalizeRel(p: string): string {
  let n = path.posix.normalize(p.replaceAll("\\", "/"));
  while (n.startsWith("./")) n = n.slice(2);
  return n;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const TEST_FILE_RE =
  /(\.(spec|test)\.[cm]?[jt]sx?$)|((Test|Tests|IT)\.(java|kt)$)|((^|\/)(__tests__|tests?)\/)/;

export function isTestFile(rel: string): boolean {
  return TEST_FILE_RE.test(normalizeRel(rel));
}

export type WriteVerdict = { ok: true } | { ok: false; reason: string; hint: string };

export function checkWrite(
  policy: Policy,
  relPath: string,
  content: string,
  alreadyWritten: Map<string, number>,
): WriteVerdict {
  const rel = normalizeRel(relPath);

  const denied = policy.denyWrite.find((g) => globToRegExp(g).test(rel));
  if (denied) {
    return {
      ok: false,
      reason: `écriture dans « ${rel} » interdite par la politique (motif « ${denied} »)`,
      hint: "ne modifiez pas ce fichier ; si c'est indispensable, signalez-le dans votre rapport final.",
    };
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > policy.maxFileBytes) {
    return {
      ok: false,
      reason: `fichier trop volumineux (${bytes} octets, maximum ${policy.maxFileBytes})`,
      hint: "découpez le contenu en plusieurs fichiers de taille raisonnable.",
    };
  }

  if (!alreadyWritten.has(rel) && alreadyWritten.size >= policy.maxFiles) {
    return {
      ok: false,
      reason: `quota de ${policy.maxFiles} fichiers écrits atteint`,
      hint: "terminez avec les fichiers déjà écrits et signalez ce qui manque dans votre rapport.",
    };
  }

  if (policy.strictScope && !policy.plannedFiles.has(rel) && !isTestFile(rel)) {
    return {
      ok: false,
      reason: `« ${rel} » n'est pas dans la liste « filesToChange » de la spécification`,
      hint: "limitez-vous aux fichiers prévus (et aux fichiers de tests) ; signalez le besoin d'un autre fichier dans votre rapport.",
    };
  }

  return { ok: true };
}
