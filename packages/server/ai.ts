import { randomUUID } from "node:crypto";
import { pool } from "../db";
import { AppError } from "../core/security";
import { checkBrandGuardrails } from "../core/brand-guardrails";
import type { Platform } from "../core/domain";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";

type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};
type ProviderResult = {
  text: string;
  usage: Usage;
  estimatedCostMicros: number | null;
};

export interface LLMProvider {
  provider: string;
  model: string;
  mode: "mock" | "live";
  generate(
    action: string,
    input: string,
    brand: Record<string, unknown>,
  ): Promise<ProviderResult>;
}

const estimateTokens = (value: string) =>
  Math.max(1, Math.ceil(value.length / 4));

class MockAI implements LLMProvider {
  provider = "mock";
  model = "deterministic-caption-v1";
  mode = "mock" as const;
  async generate(
    action: string,
    input: string,
    brand: Record<string, unknown>,
  ) {
    const name = String(brand.brandName ?? "Your brand");
    const text =
      action === "shorten"
        ? input.split(/\s+/).slice(0, 25).join(" ")
        : `${name}: ${input || "Discover something made for you."}\n\n${brand.preferredCTA || "Explore what’s new and tell us what you think."}\n\n${brand.hashtags || "#BehindTheBrand"}`;
    const promptTokens = estimateTokens(input + JSON.stringify(brand));
    const completionTokens = estimateTokens(text);
    return {
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      estimatedCostMicros: 0,
    };
  }
}

class OpenAIProvider implements LLMProvider {
  provider = "openai";
  model = process.env.AI_MODEL ?? "unconfigured";
  mode = "live" as const;
  async generate(
    action: string,
    input: string,
    brand: Record<string, unknown>,
  ) {
    if (!process.env.OPENAI_API_KEY || !process.env.AI_MODEL)
      throw new AppError(
        503,
        "AI_NOT_CONFIGURED",
        "Configure the AI model and API key.",
      );
    const result = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Write social captions. Follow the supplied brand profile as writing guidance. Return only suggested content. Never claim to have published anything.",
          },
          { role: "user", content: JSON.stringify({ action, input, brand }) },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!result.ok)
      throw new AppError(
        502,
        "AI_REQUEST_FAILED",
        "The AI provider could not complete the request.",
      );
    const data = (await result.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const inputRate = Number(process.env.AI_INPUT_COST_PER_MILLION ?? 0);
    const outputRate = Number(process.env.AI_OUTPUT_COST_PER_MILLION ?? 0);
    return {
      text: String(data.choices?.[0]?.message?.content ?? ""),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens:
          data.usage?.total_tokens ?? promptTokens + completionTokens,
      },
      estimatedCostMicros:
        inputRate || outputRate
          ? Math.round(promptTokens * inputRate + completionTokens * outputRate)
          : null,
    };
  }
}

export function llm(): LLMProvider {
  return process.env.AI_PROVIDER === "openai"
    ? new OpenAIProvider()
    : new MockAI();
}

async function brandProfile(c: Context) {
  return (
    (
      await pool.query(
        "SELECT profile FROM brand_profiles WHERE organization_id=$1 AND client_id=$2",
        [c.organizationId, c.clientId],
      )
    ).rows[0]?.profile ?? {}
  );
}

export async function generateContent(
  c: Context,
  input: {
    operation: string;
    text: string;
    platforms: Platform[];
    postId?: string;
  },
) {
  const brand = await brandProfile(c);
  const provider = llm();
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ai_generations(
       id,organization_id,client_id,user_id,post_id,operation,provider,model,mode,status,input,brand_snapshot
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$11)`,
    [
      id,
      c.organizationId,
      c.clientId,
      c.userId,
      input.postId ?? null,
      input.operation,
      provider.provider,
      provider.model,
      provider.mode,
      input.text,
      JSON.stringify(brand),
    ],
  );
  try {
    const generated = await provider.generate(
      input.operation,
      input.text,
      brand,
    );
    const guardrails = checkBrandGuardrails(
      generated.text,
      brand,
      input.platforms,
    );
    await transaction(async (tx) => {
      await tx.query(
        `UPDATE ai_generations SET status='COMPLETE',output=$1,guardrail_result=$2,
           prompt_tokens=$3,completion_tokens=$4,total_tokens=$5,estimated_cost_micros=$6,
           completed_at=now(),updated_at=now()
         WHERE id=$7 AND organization_id=$8 AND client_id=$9`,
        [
          generated.text,
          JSON.stringify(guardrails),
          generated.usage.promptTokens,
          generated.usage.completionTokens,
          generated.usage.totalTokens,
          generated.estimatedCostMicros,
          id,
          c.organizationId,
          c.clientId,
        ],
      );
      await audit(tx, c, "ai.generation.completed", id, {
        operation: input.operation,
        provider: provider.provider,
        model: provider.model,
        mode: provider.mode,
        passedGuardrails: guardrails.passed,
      });
    });
    return {
      id,
      text: generated.text,
      mode: provider.mode,
      provider: provider.provider,
      model: provider.model,
      usage: generated.usage,
      estimatedCostMicros: generated.estimatedCostMicros,
      guardrails,
    };
  } catch (error) {
    const code =
      error instanceof AppError ? error.code : "AI_GENERATION_FAILED";
    await pool.query(
      `UPDATE ai_generations SET status='FAILED',error_code=$1,completed_at=now(),updated_at=now()
       WHERE id=$2 AND organization_id=$3 AND client_id=$4`,
      [code, id, c.organizationId, c.clientId],
    );
    throw error;
  }
}

export async function checkContent(
  c: Context,
  text: string,
  platforms: Platform[],
) {
  return checkBrandGuardrails(text, await brandProfile(c), platforms);
}

export async function listGenerations(c: Context, limit = 20) {
  return (
    await pool.query(
      `SELECT id,post_id,operation,provider,model,mode,status,input,output,
            guardrail_result,prompt_tokens,completion_tokens,total_tokens,
            estimated_cost_micros,error_code,applied_at,created_at,completed_at
     FROM ai_generations WHERE organization_id=$1 AND client_id=$2
     ORDER BY created_at DESC LIMIT $3`,
      [c.organizationId, c.clientId, Math.max(1, Math.min(100, limit))],
    )
  ).rows;
}

export async function generation(c: Context, id: string) {
  const row = (
    await pool.query(
      `SELECT id,post_id,operation,provider,model,mode,status,input,output,
            brand_snapshot,guardrail_result,prompt_tokens,completion_tokens,total_tokens,
            estimated_cost_micros,error_code,applied_at,created_at,completed_at
     FROM ai_generations WHERE organization_id=$1 AND client_id=$2 AND id=$3`,
      [c.organizationId, c.clientId, id],
    )
  ).rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "AI generation not found.");
  return row;
}

export async function markGenerationApplied(c: Context, id: string) {
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        `UPDATE ai_generations SET applied_at=coalesce(applied_at,now()),updated_at=now()
       WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND status='COMPLETE'
       RETURNING id,applied_at`,
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!row)
      throw new AppError(
        404,
        "NOT_FOUND",
        "Completed AI generation not found.",
      );
    await audit(tx, c, "ai.generation.applied", id);
    return row;
  });
}
