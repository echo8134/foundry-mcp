import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";

export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;

export type RawFrame = { opcode: number; payload: Buffer; raw: Buffer };

/** Client-to-server frames must be masked, server-to-client frames must not (RFC 6455, section 5.1). */
export function encodeFrame(opcode: number, payload: string | Uint8Array, masked: boolean): Buffer {
  const body = Buffer.from(payload);
  const head = [0x80 | opcode];
  const maskBit = masked ? 0x80 : 0;
  if (body.length < 126) head.push(maskBit | body.length);
  else if (body.length < 65536) head.push(maskBit | 126, body.length >> 8, body.length & 0xff);
  else {
    head.push(maskBit | 127);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(body.length));
    head.push(...length);
  }
  if (!masked) return Buffer.concat([Buffer.from(head), body]);
  const mask = randomBytes(4);
  return Buffer.concat([Buffer.from(head), mask, Buffer.from(body.map((byte, i) => byte ^ mask[i % 4]!))]);
}

export function parseStream(bytes: Buffer): { head: string; frames: RawFrame[] } {
  const end = bytes.indexOf("\r\n\r\n");
  if (end === -1) return { head: "", frames: [] };
  const frames: RawFrame[] = [];
  let rest = bytes.subarray(end + 4);
  for (;;) {
    if (rest.length < 2) break;
    const masked = (rest[1]! & 0x80) !== 0;
    let length = rest[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) break;
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) break;
      length = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    const total = offset + (masked ? 4 : 0) + length;
    if (rest.length < total) break;
    let payload = rest.subarray(total - length, total);
    if (masked) {
      const mask = rest.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
    }
    frames.push({ opcode: rest[0]! & 0x0f, payload, raw: Buffer.from(rest.subarray(0, total)) });
    rest = rest.subarray(total);
  }
  return { head: bytes.subarray(0, end).toString("latin1"), frames };
}

/** The returned socket never answers a close frame. */
export async function rawWebSocket(
  port: number,
  origin: string,
  early: Uint8Array = new Uint8Array()
): Promise<{ socket: net.Socket; received: () => Buffer; closed: Promise<void> }> {
  const socket = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => {});
  const closed = once(socket, "close").then(() => {});
  await once(socket, "connect");
  const request =
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`;
  socket.write(Buffer.concat([Buffer.from(request), early]));
  const received = () => Buffer.concat(chunks);
  while (!received().toString("latin1").startsWith("HTTP/1.1 101") || !received().includes("\r\n\r\n")) {
    if (socket.destroyed) throw new Error(`upgrade refused: ${received().toString("latin1").split("\r\n")[0]}`);
    await new Promise((r) => setTimeout(r, 2));
  }
  return { socket, received, closed };
}

export class SamePortRelay {
  readonly port: number;
  readonly accepted: Promise<void>;
  readonly toModule: Buffer[] = [];
  readonly toServer: Buffer[] = [];
  moduleClosed = false;
  private down: net.Socket | null = null;
  private up: net.Socket | null = null;
  private readonly early: Buffer[] = [];

  private constructor(listener: net.Server, port: number) {
    this.port = port;
    this.accepted = new Promise((resolve) => {
      listener.once("connection", (down) => {
        listener.close();
        this.down = down;
        down.on("error", () => {});
        down.on("data", (chunk: Buffer) => {
          this.toServer.push(chunk);
          if (this.up) this.up.write(chunk);
          else this.early.push(chunk);
        });
        down.on("close", () => {
          this.moduleClosed = true;
          this.up?.destroy();
        });
        resolve();
      });
    });
  }

  static async listen(): Promise<SamePortRelay> {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    return new SamePortRelay(listener, (listener.address() as net.AddressInfo).port);
  }

  async dialUpstream(): Promise<void> {
    const up = net.connect(this.port, "127.0.0.1");
    up.on("error", () => {});
    await once(up, "connect");
    up.on("data", (chunk: Buffer) => {
      this.toModule.push(chunk);
      this.down?.write(chunk);
    });
    up.on("close", () => this.down?.destroy());
    this.up = up;
    for (const chunk of this.early.splice(0)) up.write(chunk);
  }

  get framesToModule(): RawFrame[] {
    return parseStream(Buffer.concat(this.toModule)).frames;
  }

  get framesToServer(): RawFrame[] {
    return parseStream(Buffer.concat(this.toServer)).frames;
  }

  get seen(): string {
    const payloads = [...this.framesToModule, ...this.framesToServer].map((frame) => frame.payload);
    return Buffer.concat([...this.toModule, ...this.toServer, ...payloads]).toString("latin1");
  }

  injectToModule(bytes: Buffer): void {
    this.down!.write(bytes);
  }

  injectToServer(bytes: Buffer): void {
    this.up!.write(bytes);
  }

  close(): void {
    this.down?.destroy();
    this.up?.destroy();
  }
}
