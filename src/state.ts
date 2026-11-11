import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * PILIER « MÉMOIRE / ÉTAT ».
 *
 * Les agents n'ont pas de mémoire entre deux exécutions : l'état durable vit donc
 * dans des fichiers (spec.json, state.json…), pas dans la conversation. Cela permet
 * de reprendre un run interrompu (--resume) et d'auditer ce qui s'est passé.
 */
export type StageStatus = "pending" | "done";

export interface GateRecord {
  name: string;
  status: "passed" | "failed" | "skipped";
  blocking: boolean;
  details: string;
}

export interface RoundRecord {
  round: number;
  gates: GateRecord[];
  reviewVerdict?: string;
  passed: boolean;
}

export interface RunState {
  ticketKey: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "passed" | "failed" | "aborted";
  stages: { spec: StageStatus; approval: StageStatus };
  rounds: RoundRecord[];
}

const stateFile = (outDir: string) => path.join(outDir, "state.json");

export function newState(ticketKey: string): RunState {
  const now = new Date().toISOString();
  return {
    ticketKey,
    startedAt: now,
    updatedAt: now,
    status: "running",
    stages: { spec: "pending", approval: "pending" },
    rounds: [],
  };
}

export async function loadState(outDir: string): Promise<RunState | undefined> {
  try {
    return JSON.parse(await fs.readFile(stateFile(outDir), "utf8")) as RunState;
  } catch {
    return undefined;
  }
}

export async function saveState(outDir: string, state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(stateFile(outDir), JSON.stringify(state, null, 2));
}
