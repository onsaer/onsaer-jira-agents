import { promises as fs } from "node:fs";
import path from "node:path";

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "target", "build", ".angular", ".nx",
  ".idea", ".vscode", "coverage", ".gradle", "out",
]);

/** Parcourt récursivement un dossier et renvoie les chemins relatifs (séparateur "/"). */
export async function* walkFiles(root: string, dir = root): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) yield* walkFiles(root, full);
    } else if (e.isFile()) {
      yield path.relative(root, full).split(path.sep).join("/");
    }
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
