// What the tests of the MCP tools share: a client connected to the server, whose bridge the test answers for.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Method } from "../src/protocol.ts";
import { type Bridge, createMcpServer } from "../src/tools.ts";

export type Call = { method: Method; params: Record<string, unknown>; timeoutMs?: number };

export async function connect(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const bridge: Bridge = {
    async request(method, params, options) {
      const call: Call = { method, params, ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }) };
      calls.push(call);
      return answer(call);
    }
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(bridge).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, calls };
}

export const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
