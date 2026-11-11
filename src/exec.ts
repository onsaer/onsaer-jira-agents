import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

/** On garde la FIN de la sortie : pour des tests, les erreurs utiles sont en bas. */
export function tail(s: string, max = 6000): string {
  return s.length > max ? `…[début tronqué]\n${s.slice(-max)}` : s;
}

/**
 * Exécute une commande fournie par la configuration (jamais par le modèle).
 * Ne lève pas d'exception : renvoie un résultat structuré que le harnais peut
 * transformer en retour exploitable (feedback loop).
 */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, exitCode: 0, output: tail(`${stdout}\n${stderr}`.trim()), durationMs: Date.now() - start };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message: string };
    const body = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message;
    return {
      ok: false,
      exitCode: typeof e.code === "number" ? e.code : -1,
      output: tail(body) + (e.killed ? `\n[interrompu : délai de ${timeoutMs} ms dépassé]` : ""),
      durationMs: Date.now() - start,
    };
  }
}
