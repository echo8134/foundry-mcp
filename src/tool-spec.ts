// What every tool definition is made of, and the input pieces the tools share.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type ToolSpec = {
  description: string;
  input: z.ZodType;
  timeoutMs: number;
  ifOutcomeUnknown: string | null;
  toResult: (raw: unknown) => CallToolResult;
};

const asJsonText = (raw: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(raw ?? null) }]
});

export function defineTool(
  def: Partial<Pick<ToolSpec, "timeoutMs" | "ifOutcomeUnknown" | "toResult">> & Pick<ToolSpec, "description" | "input">
): ToolSpec {
  return { timeoutMs: 30_000, ifOutcomeUnknown: null, toResult: asJsonText, ...def };
}

// Foundry's StringField trims by default (common/data/fields.mjs).
export const trimmed = z.string().trim();
export const nonBlank = trimmed.min(1);

export const folderPath = z.array(nonBlank);
