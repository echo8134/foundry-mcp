import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { Channel, newNonce, toBase64url } from "../module/scripts/channel.mjs";
import {
  type BridgeInfo,
  type Challenge,
  type ErrorCode,
  type Method,
  PROTOCOL_VERSION,
  parseInbound,
  READY,
  type Request,
  type Response
} from "./protocol.ts";
import type { Token } from "./token.ts";

type BridgeErrorCode = "no_bridge" | "port_unavailable" | "timeout" | "bridge_closed" | ErrorCode;

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export const CLOSE_PROTOCOL_ERROR = 4400;
export const CLOSE_AUTH_FAILED = 4401;
export const CLOSE_HANDSHAKE_TIMEOUT = 4408;
export const CLOSE_ANOTHER_BRIDGE = 4409;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_GRACE_MS = 1000;
const MAX_UNAUTHENTICATED = 256;
const MAX_UNAUTHENTICATED_BYTES = 16 * 1024;
// A get_scene_image result at the largest maxSize can be 18 MiB.
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
// Longer than the module's longest retry delay (MAX_DELAY_MS in bridge.mjs), so a lasting mismatch stays fresh.
const REFUSED_HELLO_FRESH_MS = 30_000;

export const DEFAULT_PORT = 31800;
export const DEFAULT_ORIGINS = ["http://localhost:30000"];

type HubOptions = {
  token: Token;
  port?: number;
  allowedOrigins?: readonly string[];
  handshakeTimeoutMs?: number;
  log?: (message: string) => void;
  now?: () => number;
};

type ListenerState =
  | { kind: "stopped" }
  | { kind: "listening"; http: Server; wss: WebSocketServer; port: number; address: string }
  | { kind: "unavailable"; port: number; message: string };

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: NodeJS.Timeout;
};

type BridgeState =
  | { kind: "none" }
  | { kind: "ready"; ws: WebSocket; channel: Channel; info: BridgeInfo; pending: Map<string, Pending> };

type ConnectionState =
  | { kind: "awaiting-hello" }
  | { kind: "awaiting-auth"; channel: Channel }
  | { kind: "ready"; channel: Channel }
  | { kind: "closed" };

// ws throws for a close reason over 123 bytes (ws/lib/sender.js). This is 110 plus two numbers of at most four digits.
const foreignHelloReason = (protocol: number) =>
  `module speaks protocol ${protocol}, server ${PROTOCOL_VERSION}: reload Foundry if the module is older, restart the MCP server if it is newer`;

const mismatchAdvice = (protocol: number) =>
  `A Foundry tab tried to connect with protocol ${protocol}, but this server speaks protocol ${PROTOCOL_VERSION}. ` +
  (protocol < PROTOCOL_VERSION
    ? "That tab still runs an older foundry-mcp module, so the user has to reload Foundry (F5) to load the current one. "
    : "This MCP server still runs older code than that tab's module, so the user has to restart this MCP server " +
      "to run the current code (in Claude Code: /mcp, then reconnect the server). ") +
  "Retrying alone does not help.";

const NOT_PROVEN = "the bridge did not prove it knows the token";

export class BridgeHub {
  private listener: ListenerState = { kind: "stopped" };
  private bridge: BridgeState = { kind: "none" };
  /** Named by a peer that proved nothing, so it only words the no_bridge error. */
  private refusedHello: { protocol: number; at: number } | null = null;
  private relisten: Promise<ListenerState> | null = null;
  private readonly unauthenticated = new Map<WebSocket, () => void>();
  private readonly token: Token;
  private readonly requestedPort: number;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly handshakeTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(options: HubOptions) {
    this.token = options.token;
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ORIGINS);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  get state(): ListenerState {
    return this.listener;
  }

  get port(): number {
    return this.listener.kind === "listening" ? this.listener.port : this.requestedPort;
  }

  get bridgeInfo(): BridgeInfo | null {
    return this.bridge.kind === "ready" ? this.bridge.info : null;
  }

  start(): Promise<ListenerState> {
    return new Promise((resolve) => {
      const http = createServer((_req, res) => {
        res.writeHead(426, { "content-type": "text/plain" }).end("foundry-mcp bridge: WebSocket only\n");
      });
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
      http.on("upgrade", (req, socket, head) => this.onUpgrade(wss, req, socket, head));
      wss.on("connection", (ws, req) => this.onConnection(ws, req.socket));
      const onStartupError = (error: NodeJS.ErrnoException) => {
        const message =
          `Cannot listen on 127.0.0.1:${this.requestedPort} (${error.code ?? error.message}). ` +
          "Another foundry-mcp instance, for example a second Claude session, probably holds this port. " +
          "Set FOUNDRY_MCP_PORT in the MCP server config and the module's port setting in Foundry to a free port.";
        this.log(message);
        this.listener = { kind: "unavailable", port: this.requestedPort, message };
        resolve(this.listener);
      };
      http.once("error", onStartupError);
      http.listen(this.requestedPort, "127.0.0.1", () => {
        http.off("error", onStartupError);
        http.on("error", (error) => this.log(`listener error: ${error.message}`));
        const address = http.address();
        const bound = typeof address === "object" && address ? address : null;
        const port = bound?.port ?? this.requestedPort;
        this.log(`listening on 127.0.0.1:${port}`);
        this.listener = { kind: "listening", http, wss, port, address: bound?.address ?? "127.0.0.1" };
        resolve(this.listener);
      });
    });
  }

  async stop(): Promise<void> {
    const listener = this.listener;
    this.listener = { kind: "stopped" };
    if (listener.kind !== "listening") return;
    for (const ws of listener.wss.clients) ws.terminate();
    listener.wss.close();
    await new Promise<void>((resolve) => {
      listener.http.close(() => resolve());
      listener.http.closeAllConnections();
    });
  }

  async request(
    method: Method,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (this.listener.kind === "unavailable") {
      this.relisten ??= this.start().finally(() => (this.relisten = null));
      await this.relisten;
    }
    if (this.listener.kind === "unavailable") throw new BridgeError("port_unavailable", this.listener.message);
    const bridge = this.bridge;
    if (bridge.kind !== "ready") throw new BridgeError("no_bridge", this.noBridgeMessage());
    const id = randomUUID();
    const frame: Request = { type: "request", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bridge.pending.delete(id);
        reject(new BridgeError("timeout", `Foundry did not answer ${method} within ${timeoutMs} ms.`));
      }, timeoutMs);
      bridge.pending.set(id, { resolve, reject, timer });
      bridge.channel.send(frame).catch((error: Error) => {
        clearTimeout(timer);
        bridge.pending.delete(id);
        reject(new BridgeError("bridge_closed", `Could not send ${method} to Foundry: ${error.message}`));
        this.dropBridge(bridge.ws, `bridge closed: could not send ${method}`);
        bridge.ws.terminate();
      });
    });
  }

  private noBridgeMessage(): string {
    const refused = this.refusedHello;
    const advice =
      refused === null || this.now() - refused.at > REFUSED_HELLO_FRESH_MS
        ? "Open the world in Foundry as Gamemaster with the foundry-mcp module enabled and keep that browser tab open. " +
          "If the world is already open, the module reconnects by itself within about 15 seconds, so retry shortly. " +
          "From a tab at a 127.0.0.1 address the module does not connect, so the user has to open Foundry at " +
          "http://localhost:<Foundry's port> instead."
        : mismatchAdvice(refused.protocol);
    return (
      `No Foundry bridge is connected. ${advice} The server is listening on 127.0.0.1:${this.port}. ` +
      "If Foundry shows a foundry-mcp token warning, the user has to paste the bridge token into the module's " +
      "Bridge token setting. Do not print the token or run a command that prints it, because it would end up in this transcript."
    );
  }

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin;
    if (origin === undefined || !this.allowedOrigins.has(origin)) {
      this.log(`rejected upgrade from origin ${origin ?? "(none)"}`);
      // Node's http server removes its socket error listener before "upgrade" (lib/_http_server.js), and an "error"
      // event with no listener crashes the process.
      socket.on("error", () => socket.destroy());
      socket.once("finish", () => socket.destroy());
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }

  private onConnection(ws: WebSocket, socket: Duplex): void {
    ws.on("error", (error) => this.log(`socket error: ${error.message}`));

    let state: ConnectionState = { kind: "awaiting-hello" };
    let graceTimer: NodeJS.Timeout | undefined;
    const reject = (code: number, reason: string) => {
      if (state.kind === "closed") return;
      clearTimeout(handshakeTimer);
      state = { kind: "closed" };
      this.unauthenticated.delete(ws);
      this.dropBridge(ws, `bridge closed: ${reason}`);
      ws.close(code, reason);
      graceTimer = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
    };
    const handshakeTimer = setTimeout(
      () => reject(CLOSE_HANDSHAKE_TIMEOUT, "no handshake in time"),
      this.handshakeTimeoutMs
    );

    const cut = () => {
      clearTimeout(handshakeTimer);
      state = { kind: "closed" };
      this.unauthenticated.delete(ws);
      ws.terminate();
    };
    this.unauthenticated.set(ws, cut);
    if (this.unauthenticated.size > MAX_UNAUTHENTICATED) {
      this.log(`more than ${MAX_UNAUTHENTICATED} unauthenticated connections, dropped the oldest`);
      this.unauthenticated.values().next().value?.();
    }

    const cutOverBound = () => {
      this.log(`cut off a connection that sent more than ${MAX_UNAUTHENTICATED_BYTES} bytes without being the bridge`);
      cut();
    };
    // Counted on the raw socket, so the bytes of a frame that never completes count too.
    let received = 0;
    socket.on("data", (chunk: Buffer) => {
      if (state.kind === "ready") return;
      received += chunk.length;
      if (received > MAX_UNAUTHENTICATED_BYTES) cutOverBound();
    });

    // Every await is followed by a check that the state is still the one this frame started from.
    const handle = async (data: Buffer, isBinary: boolean): Promise<void> => {
      const current = state;
      if (current.kind === "closed") return;
      // Bounds what is parsed or opened by itself, without relying on the byte count above.
      if (current.kind !== "ready" && data.length > MAX_UNAUTHENTICATED_BYTES) return cutOverBound();
      switch (current.kind) {
        case "awaiting-hello": {
          const inbound = isBinary ? null : parseInbound(data.toString());
          if (inbound?.kind === "foreign-hello") {
            this.log(
              `refused a hello for protocol ${inbound.protocol}, this server speaks protocol ${PROTOCOL_VERSION}`
            );
            this.refusedHello = { protocol: inbound.protocol, at: this.now() };
            return reject(CLOSE_PROTOCOL_ERROR, foreignHelloReason(inbound.protocol));
          }
          if (inbound?.kind !== "hello")
            return reject(CLOSE_PROTOCOL_ERROR, `first frame must be a protocol ${PROTOCOL_VERSION} hello`);
          const serverNonce = newNonce();
          const channel = await Channel.create({
            token: this.token,
            clientNonce: inbound.nonce,
            serverNonce,
            role: "server",
            transmit: (sealed, counter) => {
              const challenge: Challenge = { type: "challenge", nonce: serverNonce, proof: toBase64url(sealed) };
              ws.send(counter === 0 ? JSON.stringify(challenge) : sealed);
            }
          });
          if (state !== current) return;
          state = { kind: "awaiting-auth", channel };
          await channel.send(READY);
          return;
        }
        case "awaiting-auth": {
          if (!isBinary) return reject(CLOSE_PROTOCOL_ERROR, "every frame after the challenge must be sealed");
          const opened = await current.channel.receive(data);
          if (state !== current) return;
          if (!opened.ok) {
            if (opened.reason === "crypto-error") {
              this.log(`could not open an auth frame: ${String(opened.error)}`);
              return reject(CLOSE_INTERNAL_ERROR, "internal error");
            }
            this.log("rejected a bridge that did not prove it knows the token");
            return reject(CLOSE_AUTH_FAILED, NOT_PROVEN);
          }
          const inbound = parseInbound(opened.text);
          if (inbound.kind !== "auth") return reject(CLOSE_AUTH_FAILED, NOT_PROVEN);
          // Only a peer that authenticated learns that another bridge is connected.
          if (this.bridge.kind === "ready")
            return reject(CLOSE_ANOTHER_BRIDGE, "another Foundry bridge is already connected");
          clearTimeout(handshakeTimer);
          this.unauthenticated.delete(ws);
          state = { kind: "ready", channel: current.channel };
          this.bridge = { kind: "ready", ws, channel: current.channel, info: inbound.info, pending: new Map() };
          this.refusedHello = null;
          const { foundry, world, user } = inbound.info;
          this.log(`bridge ready: Foundry ${foundry}, world ${world.id}, user ${user.name}`);
          return;
        }
        case "ready": {
          if (!isBinary) return reject(CLOSE_PROTOCOL_ERROR, "a text frame after the handshake");
          const opened = await current.channel.receive(data);
          if (state !== current) return;
          if (!opened.ok) {
            this.log(`closed the bridge: a frame did not open (${opened.reason})`);
            return reject(CLOSE_AUTH_FAILED, "a frame did not open");
          }
          const inbound = parseInbound(opened.text);
          if (inbound.kind === "response") return this.settle(inbound.response);
          const reason = inbound.kind === "invalid" ? inbound.reason : `unexpected ${inbound.kind}`;
          const answeredPending =
            inbound.kind === "invalid" && inbound.id !== undefined && this.rejectMalformed(inbound.id, reason);
          if (!answeredPending) this.log(`ignored frame from bridge: ${reason}`);
          return;
        }
      }
    };

    let queue = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      if (state.kind === "closed") return;
      queue = queue
        .then(() => handle(data as Buffer, isBinary))
        .catch((error: Error) => {
          this.log(`error while handling a frame: ${error.message}`);
          reject(CLOSE_INTERNAL_ERROR, "internal error");
        });
    });

    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      clearTimeout(graceTimer);
      state = { kind: "closed" };
      this.unauthenticated.delete(ws);
      this.dropBridge(ws, "bridge disconnected");
    });
  }

  private dropBridge(ws: WebSocket, message: string): void {
    if (this.bridge.kind !== "ready" || this.bridge.ws !== ws) return;
    const { pending } = this.bridge;
    this.bridge = { kind: "none" };
    this.log(message);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError("bridge_closed", "The Foundry bridge disconnected before answering."));
    }
  }

  private rejectMalformed(id: string, reason: string): boolean {
    if (this.bridge.kind !== "ready") return false;
    const entry = this.bridge.pending.get(id);
    if (!entry) return false;
    this.bridge.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new BridgeError("foundry_error", `malformed response from the bridge: ${reason}`));
    return true;
  }

  private settle(response: Response): void {
    if (this.bridge.kind !== "ready") return;
    const entry = this.bridge.pending.get(response.id);
    if (!entry) {
      this.log(`response for unknown request ${response.id}`);
      return;
    }
    this.bridge.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new BridgeError(response.error.code, response.error.message));
  }
}
