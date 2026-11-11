import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

/**
 * PILIER « OBSERVABILITÉ ».
 *
 * Un agent est une boîte noire tant qu'on ne trace pas ce qu'il fait. Ici :
 *  - un journal JSONL (une ligne = un événement) lisible par un humain ET par un script ;
 *  - des métriques agrégées (appels modèle, tokens, appels d'outils, erreurs, boucles).
 */
export class Tracer {
  readonly metrics = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: {} as Record<string, number>,
    toolErrors: 0,
    loopTrips: 0,
    policyDenials: 0,
    retries: 0,
  };

  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`);
  }

  toolCall(agent: string, tool: string, ok: boolean, durationMs: number): void {
    const key = `${agent}.${tool}`;
    this.metrics.toolCalls[key] = (this.metrics.toolCalls[key] ?? 0) + 1;
    if (!ok) this.metrics.toolErrors += 1;
    this.event("tool_call", { agent, tool, ok, durationMs });
  }

  llmUsage(agent: string, input: number, output: number): void {
    this.metrics.llmCalls += 1;
    this.metrics.inputTokens += input;
    this.metrics.outputTokens += output;
    this.event("llm_call", { agent, inputTokens: input, outputTokens: output });
  }
}

/** Callback LangChain : récupère la consommation de tokens de chaque appel modèle. */
export class TraceHandler extends BaseCallbackHandler {
  name = "harness-trace";

  constructor(
    private readonly tracer: Tracer,
    private readonly agent: string,
  ) {
    super();
  }

  override handleLLMEnd(output: LLMResult): void {
    const gen = output.generations[0]?.[0] as
      | { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }
      | undefined;
    const usage = gen?.message?.usage_metadata;
    this.tracer.llmUsage(this.agent, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0);
  }
}
