import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DeepSeekUsageSchema,
  estimateContextTokens,
  estimateProviderPayloadTokens,
  estimateTokensFromUtf8Bytes,
} from "../../server/contextTokenEstimate";

describe("context token estimation", () => {
  it("counts UTF-8 bytes and rounds partial token estimates upward", () => {
    expect(estimateTokensFromUtf8Bytes("")).toBe(0);
    expect(estimateTokensFromUtf8Bytes("abcd")).toBe(1);
    expect(estimateTokensFromUtf8Bytes("中国")).toBe(2);
  });

  it("uses provider total as the baseline and estimates only newer rows", () => {
    const estimate = estimateContextTokens({
      messages: [{ role: "user", content: "ignored while baseline exists" }],
      tools: [],
      transcriptRows: [
        { seq: 10 },
        { seq: 11 },
      ],
      baseline: {
        providerTotalTokens: 100,
        coveredThroughSeq: 10,
      },
    });

    expect(estimate).toBe(
      100 + estimateTokensFromUtf8Bytes(JSON.stringify([{ seq: 11 }])),
    );
  });

  it("estimates the complete provider payload when no usage baseline exists", () => {
    const input = {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    };
    expect(estimateContextTokens({
      ...input,
      transcriptRows: [],
      baseline: null,
    })).toBe(estimateProviderPayloadTokens(input));
  });

  it("rejects provider usage whose total contradicts its parts", () => {
    expect(DeepSeekUsageSchema.safeParse({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 14,
    }).success).toBe(false);
  });
});
