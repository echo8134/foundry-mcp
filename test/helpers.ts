import { WebSocket } from "ws";
import { Channel, fromBase64url, newNonce } from "../module/scripts/channel.mjs";
import { type BridgeInfo, type Challenge, PROTOCOL_VERSION, type Request } from "../src/protocol.ts";
import { parseToken } from "../src/token.ts";

export const ORIGIN = "http://localhost:30000";

export const TOKEN = parseToken("test-token-0123456789abcdefghijklmnopqrstuv", "the tests");
export const WRONG_TOKEN = parseToken("wrong-token-0123456789abcdefghijklmnopqrstu", "the tests");

export const info: BridgeInfo = {
  foundry: "14.370",
  module: "0.2.0",
  world: { id: "test-world", title: "Test World" },
  user: { id: "u1", name: "Gamemaster" }
};

export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Frame = { type?: unknown };

export class FakeBridge {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  readonly wire: { from: "hub" | "bridge"; data: Buffer }[] = [];
  clientNonce = "";
  channel: Channel | null = null;
  proofOpened: boolean | null = null;
  closed: { code: number; reason: string } | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer, isBinary) => {
      this.wire.push({ from: "hub", data });
      if (!isBinary) return void this.frames.push(JSON.parse(data.toString()) as Frame);
      const opened = this.channel?.receive(data);
      opened?.then((result) =>
        this.frames.push(result.ok ? (JSON.parse(result.text) as Frame) : { type: "unopenable" })
      );
    });
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  static async connect(port: number, origin: string = ORIGIN): Promise<FakeBridge> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new FakeBridge(ws);
  }

  get requests(): Request[] {
    return this.frames.filter((frame): frame is Request => frame.type === "request");
  }

  get challenge(): Challenge | undefined {
    return this.frames.find((frame): frame is Challenge => frame.type === "challenge");
  }

  sendRaw(data: string | Uint8Array): void {
    this.wire.push({ from: "bridge", data: Buffer.from(data) });
    this.ws.send(data);
  }

  sendText(frame: object): void {
    this.sendRaw(JSON.stringify(frame));
  }

  sendHello(): void {
    this.clientNonce = newNonce();
    this.sendText({ type: "hello", protocol: PROTOCOL_VERSION, nonce: this.clientNonce });
  }

  async sendAuth(token: string = TOKEN): Promise<void> {
    await until(() => this.challenge !== undefined || this.closed !== null);
    const challenge = this.challenge;
    if (!challenge) throw new Error(`closed before a challenge arrived: ${JSON.stringify(this.closed)}`);
    this.channel = await Channel.create({
      token,
      clientNonce: this.clientNonce,
      serverNonce: challenge.nonce,
      role: "client",
      transmit: (sealed) => this.sendRaw(sealed)
    });
    this.proofOpened = (await this.channel.receive(fromBase64url(challenge.proof)!)).ok;
    await this.channel.send({ type: "auth", ...info });
  }

  async handshake(token: string = TOKEN): Promise<void> {
    this.sendHello();
    await this.sendAuth(token);
  }

  respond(id: string, result: unknown): Promise<void> {
    return this.channel!.send({ type: "response", id, ok: true, result });
  }

  fail(id: string, code: string, message: string): Promise<void> {
    return this.channel!.send({ type: "response", id, ok: false, error: { code, message } });
  }

  close(): void {
    this.ws.close();
  }
}
