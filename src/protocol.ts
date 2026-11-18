import { z } from "zod";
import { isNonce, PROTOCOL } from "../module/scripts/channel.mjs";
import { SURFACE } from "../module/scripts/surface.mjs";

export const PROTOCOL_VERSION = PROTOCOL;
export const SURFACE_NUMBER = SURFACE;

export const METHODS = [
  "get_scene",
  "get_scene_image",
  "create_walls",
  "delete_walls",
  "sync_walls",
  "sync_lights",
  "sync_regions",
  "list_scenes",
  "ensure_scene",
  "list_actors",
  "get_actor",
  "get_schema",
  "place_tokens",
  "update_tokens",
  "delete_tokens",
  "ensure_actor",
  "delete_actors",
  "list_documents",
  "get_document",
  "create_documents",
  "update_documents",
  "delete_documents"
] as const;
export type Method = (typeof METHODS)[number];

export const ERROR_CODES = ["unknown_method", "invalid_params", "not_found", "foundry_error"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const nonceSchema = z.string().refine(isNonce, "nonce must be 32 random bytes as unpadded base64url");

const helloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  nonce: nonceSchema
});

const protocolNumberSchema = z.int().min(1).max(9999);

const authSchema = z.object({
  type: z.literal("auth"),
  foundry: z.string(),
  module: z.string(),
  surface: z.int().min(1).optional(),
  world: z.object({ id: z.string(), title: z.string() }),
  user: z.object({ id: z.string(), name: z.string() })
});

export type BridgeInfo = Omit<z.infer<typeof authSchema>, "type">;

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("response"), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    type: z.literal("response"),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string() })
  })
]);
export type Response = z.infer<typeof responseSchema>;

export type Challenge = { type: "challenge"; nonce: string; proof: string };
export const READY = { type: "ready" } as const;
export type Request = { type: "request"; id: string; method: Method; params: Record<string, unknown> };

type Inbound =
  | { kind: "hello"; nonce: string }
  | { kind: "foreign-hello"; protocol: number }
  | { kind: "auth"; info: BridgeInfo }
  | { kind: "response"; response: Response }
  | { kind: "invalid"; reason: string; id?: string };

const schemas = { hello: helloSchema, auth: authSchema, response: responseSchema } as const;

export function parseInbound(raw: string): Inbound {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "frame is not JSON" };
  }
  const type = typeof json === "object" && json !== null ? (json as { type?: unknown }).type : undefined;
  if (typeof type !== "string" || !Object.hasOwn(schemas, type)) {
    return { kind: "invalid", reason: `unknown frame type ${JSON.stringify(type)}` };
  }
  if (type === "hello") {
    const named = protocolNumberSchema.safeParse((json as { protocol?: unknown }).protocol);
    if (named.success && named.data !== PROTOCOL_VERSION) return { kind: "foreign-hello", protocol: named.data };
  }
  const parsed = schemas[type as keyof typeof schemas].safeParse(json);
  if (!parsed.success) {
    const id = type === "response" ? (json as { id?: unknown }).id : undefined;
    return { kind: "invalid", reason: z.prettifyError(parsed.error), ...(typeof id === "string" && { id }) };
  }
  const frame = parsed.data;
  switch (frame.type) {
    case "hello":
      return { kind: "hello", nonce: frame.nonce };
    case "auth": {
      const { type: _type, ...info } = frame;
      return { kind: "auth", info };
    }
    case "response":
      return { kind: "response", response: frame };
  }
}
