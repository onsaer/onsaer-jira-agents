import { promises as fs } from "node:fs";
import path from "node:path";
import { IGNORED_DIRS, exists } from "./fsutil.js";

/**
 * PILIER « CONTEXT ENGINEERING ».
 *
 * Un agent ne connaît que ce qu'on lui met sous les yeux. Plutôt que de le laisser
 * deviner la stack et les conventions, le harnais lui prépare un « briefing » :
 *  1. les fichiers d'instructions du dépôt (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md) ;
 *  2. la stack détectée (Angular, Spring, version de Java…) ;
 *  3. une carte du dépôt sur 2 niveaux.
 *
 * Principe de « divulgation progressive » : on donne une CARTE courte, et l'agent
 * va chercher le détail avec ses outils (read_file, search_files) quand il en a besoin.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md"];
const PER_FILE_CHARS = 4_000;
const TOTAL_CHARS = 12_000;

export async function buildRepoContext(root: string): Promise<string> {
  const parts: string[] = [];

  // 1) Instructions du dépôt
  let budget = TOTAL_CHARS;
  for (const name of INSTRUCTION_FILES) {
    if (budget <= 0) break;
    const file = path.join(root, name);
    if (!(await exists(file))) continue;
    const text = (await fs.readFile(file, "utf8")).slice(0, Math.min(PER_FILE_CHARS, budget));
    budget -= text.length;
    parts.push(`### ${name}\n${text}`);
  }

  // 2) Stack détectée
  const stack = await detectStack(root);

  // 3) Carte du dépôt
  const tree = await describeTree(root, 2, 80);

  return [
    "## Contexte du dépôt (préparé par le harnais)",
    `### Stack détectée\n${stack.length ? stack.map((s) => `- ${s}`).join("\n") : "- non détectée : explorez avec list_dir"}`,
    `### Carte du dépôt (2 niveaux)\n${tree}`,
    parts.length
      ? `### Instructions du dépôt (extraits ; lisez le fichier complet si besoin)\n${parts.join("\n\n")}`
      : "### Instructions du dépôt\nAucun AGENTS.md / CLAUDE.md / README.md trouvé : déduisez les conventions du code existant.",
  ].join("\n\n");
}

async function detectStack(root: string): Promise<string[]> {
  const stack: string[] = [];

  const pkgFile = path.join(root, "package.json");
  if (await exists(pkgFile)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgFile, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["@angular/core"]) stack.push(`Angular ${deps["@angular/core"]}`);
      if (deps["@nx/workspace"] || deps["nx"]) stack.push("Monorepo Nx");
      if (deps["react"]) stack.push(`React ${deps["react"]}`);
      if (deps["typescript"]) stack.push(`TypeScript ${deps["typescript"]}`);
      for (const fw of ["jest", "vitest", "karma", "@playwright/test", "cypress"]) {
        if (deps[fw]) stack.push(`Test : ${fw}`);
      }
      if (pkg.scripts?.test) stack.push(`Script npm « test » : ${pkg.scripts.test}`);
    } catch {
      stack.push("package.json présent mais illisible");
    }
  }

  const pom = path.join(root, "pom.xml");
  if (await exists(pom)) {
    const xml = await fs.readFile(pom, "utf8");
    const java = /<(?:java\.version|maven\.compiler\.(?:release|source))>([^<]+)</.exec(xml)?.[1];
    stack.push(`Maven${xml.includes("spring-boot") ? " + Spring Boot" : ""}${java ? `, Java ${java}` : ""}`);
    if (xml.includes("junit-jupiter")) stack.push("Test : JUnit 5");
  }

  for (const g of ["build.gradle", "build.gradle.kts"]) {
    if (await exists(path.join(root, g))) stack.push(`Gradle (${g})`);
  }

  return stack;
}

async function describeTree(root: string, maxDepth: number, maxEntries: number): Promise<string> {
  const lines: string[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (lines.length >= maxEntries) return;
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= maxEntries) {
        lines.push(`${"  ".repeat(depth)}…`);
        return;
      }
      lines.push(`${"  ".repeat(depth)}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && depth + 1 < maxDepth) await visit(path.join(dir, e.name), depth + 1);
    }
  }

  await visit(root, 0);
  return "```\n" + (lines.join("\n") || "(dépôt vide)") + "\n```";
}
