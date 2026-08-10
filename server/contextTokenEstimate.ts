/**
 * [INPUT]: DeepSeek provider messages/tools, optional last provider usage baseline
 * [OUTPUT]: Conservative token estimate used only for the fixed compaction trigger
 * [POS]: A 域 Context token 预算器 —— Provider usage 是基准，bytes/4 只估算尚未发送的增量
 * [PROTOCOL]: 估算值不得命名或记录为 exact tokens；未知 usage 结构必须显式失败
 */
import "server-only";

import { z } from "zod";

export const DeepSeekUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
}).passthrough().superRefine((usage, context) => {
  if (usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) {
    context.addIssue({
      code: "custom",
      path: ["total_tokens"],
      message: "total_tokens must equal prompt_tokens + completion_tokens",
    });
  }
});

export type DeepSeekUsage = z.infer<typeof DeepSeekUsageSchema>;

export type ContextTokenBaseline = Readonly<{
  providerTotalTokens: number;
  coveredThroughSeq: number;
}>;

export function estimateTokensFromUtf8Bytes(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

export function estimateProviderPayloadTokens(input: {
  messages: readonly unknown[];
  tools: readonly unknown[];
}): number {
  return estimateTokensFromUtf8Bytes(JSON.stringify(input));
}

export function estimateContextTokens(input: {
  messages: readonly unknown[];
  tools: readonly unknown[];
  transcriptRows: readonly Readonly<{ seq: number }>[];
  baseline: ContextTokenBaseline | null;
}): number {
  if (!input.baseline) {
    return estimateProviderPayloadTokens({
      messages: input.messages,
      tools: input.tools,
    });
  }

  const newRows = input.transcriptRows.filter(
    (row) => row.seq > input.baseline!.coveredThroughSeq,
  );
  return input.baseline.providerTotalTokens
    + estimateTokensFromUtf8Bytes(JSON.stringify(newRows));
}
