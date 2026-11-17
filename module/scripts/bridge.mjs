import { Channel, fromBase64url, isNonce, newNonce, PROTOCOL } from "./channel.mjs";
import { MethodError } from "./methods.mjs";

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
const HEALTHY_AFTER_MS = 10000;
const HANDSHAKE_TIMEOUT_MS = 5000;
const BRIDGE_HOST = "127.0.0.1";
const MAX_CHALLENGE_CHARS = 1024;
const CLOSE_HELLO_REFUSED = 4400;

/**
 * @typedef {{kind: "no-token"} | {kind: "insecure-context"} | {kind: "loopback-ip-page"}
 *   | {kind: "bad-proof", port: number} | {kind: "no-challenge", port: number}
 *   | {kind: "protocol-mismatch", port: number}} Problem
 */

export class Bridge {
  /**
   * @param {object} options
   * @param {() => number} options.getPort
   * @param {() => string} options.getPageHost
   * @param {() => string} options.getToken
   * @param {() => object} options.getInfo
   * @param {Record<string, (params: any) => Promise<unknown>>} options.methods
   * @param {(message: string, ...rest: unknown[]) => void} options.log
   * @param {(problem: Problem) => void} options.warn
   */
  constructor({ getPort, getPageHost, getToken, getInfo, methods, log, warn }) {
    this.getPort = getPort;
    this.getPageHost = getPageHost;
    this.getToken = getToken;
    this.getInfo = getInfo;
    this.methods = methods;
    this.log = log;
    this.warn = warn;
    this.state = { kind: "idle" };
    this.delay = MIN_DELAY_MS;
    this.warned = new Set();
  }

  start() {
    if (this.state.kind !== "idle") return;
    this.connect();
  }

  stop() {
    const state = this.state;
    this.state = { kind: "idle" };
    this.delay = MIN_DELAY_MS;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.ws?.close();
  }

  restart() {
    this.stop();
    this.warned.clear();
    this.start();
  }

  /** @param {Problem} problem */
  warnOnce(problem) {
    if (this.warned.has(problem.kind)) return;
    this.warned.add(problem.kind);
    this.warn(problem);
  }

  connect() {
    const token = String(this.getToken() ?? "").trim();
    // Cookies do not isolate by port (RFC 6265 section 8.5): from a page on BRIDGE_HOST, the upgrade request would
    // carry Foundry's session cookie to whatever process holds the port.
    const blocker = !globalThis.crypto?.subtle
      ? { kind: "insecure-context" }
      : this.getPageHost() === BRIDGE_HOST
        ? { kind: "loopback-ip-page" }
        : token === ""
          ? { kind: "no-token" }
          : null;
    if (blocker) {
      this.state = { kind: "idle" };
      this.log(`not connecting: ${blocker.kind}`);
      this.warn(blocker);
      return;
    }
    const port = this.getPort();
    const url = `ws://${BRIDGE_HOST}:${port}`;
    let ws;
    try {
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error(`the port setting must be 1 to 65535, got ${port}`);
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
    } catch (error) {
      this.log(`cannot connect to ${url} (${error.message}), retrying in ${this.delay} ms`);
      this.scheduleRetry();
      return;
    }
    const timer = setTimeout(() => {
      if (this.state.ws === ws && this.state.kind === "awaiting-challenge")
        this.warnOnce({ kind: "no-challenge", port });
      this.abandon(ws, `no valid challenge from ${url} in time`);
    }, HANDSHAKE_TIMEOUT_MS);
    this.state = { kind: "connecting", ws, timer };
    ws.addEventListener("open", () => {
      if (this.state.ws !== ws) return;
      const clientNonce = newNonce();
      this.state = { kind: "awaiting-challenge", ws, timer, clientNonce };
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, nonce: clientNonce }));
      this.log(`connected to ${url}, checking that it knows the token`);
    });
    ws.addEventListener("message", (event) => {
      const state = this.state;
      if (state.ws !== ws) return;
      if (state.kind === "awaiting-challenge") this.answerChallenge(state, event.data, { port, token });
      else if (state.kind === "open") this.receive(state, event.data, port);
      else this.abandon(ws, `unexpected frame from ${url} while ${state.kind}`);
    });
    ws.addEventListener("error", () => {});
    ws.addEventListener("close", (event) => {
      const state = this.state;
      if (state.ws !== ws) return;
      if (state.timer !== undefined) clearTimeout(state.timer);
      if (state.kind === "awaiting-challenge") {
        const refused = event.code === CLOSE_HELLO_REFUSED;
        // The reason comes from a process that proved nothing, so it goes to the console only.
        if (refused)
          this.log(
            `the server on 127.0.0.1:${port} refused this module's protocol ${PROTOCOL} hello, saying:`,
            event.reason
          );
        this.warnOnce({ kind: refused ? "protocol-mismatch" : "no-challenge", port });
      }
      // The backoff resets only after a useful connection, so a tab the server turns away does not retry every second.
      const healthy = state.kind === "open" && (state.served || Date.now() - state.openedAt > HEALTHY_AFTER_MS);
      if (healthy) this.delay = MIN_DELAY_MS;
      this.log(
        `disconnected (code ${event.code}${event.reason ? `, ${event.reason}` : ""}), retrying in ${this.delay} ms`
      );
      this.scheduleRetry();
    });
  }

  async answerChallenge({ ws, timer, clientNonce }, raw, { port, token }) {
    const frame = typeof raw === "string" && raw.length <= MAX_CHALLENGE_CHARS ? parseFrame(raw) : null;
    const proof = frame?.type === "challenge" && isNonce(frame.nonce) ? fromBase64url(frame.proof) : null;
    if (proof === null) {
      this.warnOnce({ kind: "no-challenge", port });
      this.abandon(ws, `expected a protocol ${PROTOCOL} challenge from 127.0.0.1:${port}`);
      return;
    }
    const verifying = { kind: "verifying", ws, timer };
    this.state = verifying;
    /** @type {"proven" | "forged" | "crypto-error"} */
    let outcome = "crypto-error";
    let channel = null;
    try {
      channel = await Channel.create({
        token,
        clientNonce,
        serverNonce: frame.nonce,
        role: "client",
        transmit: (sealed) => ws.readyState === WebSocket.OPEN && ws.send(sealed)
      });
      const opened = await channel.receive(proof);
      if (opened.ok) outcome = parseFrame(opened.text)?.type === "ready" ? "proven" : "forged";
      else if (opened.reason === "forged") outcome = "forged";
      else this.log("checking the server proof failed:", opened.error);
    } catch (error) {
      this.log("checking the server proof failed:", error);
    }
    if (this.state !== verifying) return;
    if (outcome === "crypto-error") {
      this.abandon(ws, `could not check the proof of 127.0.0.1:${port}`);
      return;
    }
    if (outcome === "forged") {
      this.warnOnce({ kind: "bad-proof", port });
      this.abandon(ws, `the process on 127.0.0.1:${port} did not prove it knows the token`);
      return;
    }
    clearTimeout(timer);
    const open = { kind: "open", ws, channel, openedAt: Date.now(), served: false };
    this.state = open;
    this.log(`the server on 127.0.0.1:${port} proved it knows the token`);
    channel.send({ type: "auth", ...this.getInfo() }).catch((error) => {
      this.log("could not send the auth frame:", error);
      this.abandon(ws, "the auth frame was not sent");
    });
  }

  async receive(state, data, port) {
    const { ws, channel } = state;
    if (typeof data === "string") {
      this.abandon(ws, `a text frame from 127.0.0.1:${port} after the handshake`);
      return;
    }
    const opened = await channel.receive(data);
    if (this.state !== state) return;
    if (!opened.ok) {
      if (opened.reason === "crypto-error") this.log("opening a frame failed:", opened.error);
      this.abandon(ws, `a frame from 127.0.0.1:${port} did not open (${opened.reason})`);
      return;
    }
    state.served = true;
    this.dispatch(channel, opened.text);
  }

  abandon(ws, reason) {
    const state = this.state;
    if (state.ws !== ws) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    this.log(`${reason}, closing, retrying in ${this.delay} ms`);
    this.scheduleRetry();
    ws.close();
  }

  scheduleRetry() {
    const delay = this.delay;
    this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    this.state = { kind: "waiting", timer: setTimeout(() => this.connect(), delay) };
  }

  async dispatch(channel, text) {
    const frame = parseFrame(text);
    if (frame === null) {
      this.log("ignored a frame that is not JSON");
      return;
    }
    if (frame?.type !== "request" || typeof frame.id !== "string" || typeof frame.method !== "string") {
      this.log("ignored a frame that is not a request");
      return;
    }
    const reply = (body) =>
      channel
        .send({ type: "response", id: frame.id, ...body })
        .catch((error) => this.log(`could not answer ${frame.method}:`, error));
    if (!Object.hasOwn(this.methods, frame.method)) {
      reply({ ok: false, error: { code: "unknown_method", message: `Unknown method ${frame.method}.` } });
      return;
    }
    try {
      const result = await this.methods[frame.method](frame.params ?? {});
      reply({ ok: true, result });
    } catch (error) {
      const code = error instanceof MethodError ? error.code : "foundry_error";
      if (code === "foundry_error") this.log(`${frame.method} failed:`, error);
      reply({ ok: false, error: { code, message: error?.message ?? String(error) } });
    }
  }
}

function parseFrame(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
