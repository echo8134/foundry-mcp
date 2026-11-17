export const PROTOCOL = 3;

const NONCE_BYTES = 32;
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const KEY_INFO = {
  "client-to-server": `foundry-mcp/${PROTOCOL} client-to-server`,
  "server-to-client": `foundry-mcp/${PROTOCOL} server-to-client`
};

/** @param {Uint8Array} bytes */
export function toBase64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * @param {unknown} text
 * @returns {Uint8Array | null}
 */
export function fromBase64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let binary;
  try {
    binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return toBase64url(bytes) === text ? bytes : null;
}

export function newNonce() {
  return toBase64url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/** @param {unknown} value */
export function isNonce(value) {
  return fromBase64url(value)?.length === NONCE_BYTES;
}

/** @param {number} counter */
function iv(counter) {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(4, BigInt(counter));
  return bytes;
}

/** @param {ArrayBuffer | ArrayBufferView} data */
function asBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * @typedef {"server" | "client"} Role
 * @typedef {{ok: true, text: string} | {ok: false, reason: "forged" | "crypto-error" | "poisoned", error?: unknown}} Opened
 */

/** Sealing and opening are async, so both run through promise chains that keep call order and arrival order. */
export class Channel {
  #sealKey;
  #openKey;
  #transmit;
  #sent = 0;
  #opened = 0;
  #sending = Promise.resolve();
  #opening = Promise.resolve(/** @type {Opened | null} */ (null));
  #sendFailed = false;
  #poisoned = false;

  /**
   * @param {CryptoKey} sealKey
   * @param {CryptoKey} openKey
   * @param {(sealed: Uint8Array, counter: number) => void} transmit
   */
  constructor(sealKey, openKey, transmit) {
    this.#sealKey = sealKey;
    this.#openKey = openKey;
    this.#transmit = transmit;
  }

  /**
   * @param {{token: string, clientNonce: string, serverNonce: string, role: Role,
   *   transmit: (sealed: Uint8Array, counter: number) => void}} options
   * @returns {Promise<Channel>}
   */
  static async create({ token, clientNonce, serverNonce, role, transmit }) {
    const client = fromBase64url(clientNonce);
    const server = fromBase64url(serverNonce);
    if (client?.length !== NONCE_BYTES || server?.length !== NONCE_BYTES)
      throw new TypeError("a nonce is not 32 bytes of base64url");
    if (role !== "server" && role !== "client") throw new TypeError("role must be server or client");
    const salt = new Uint8Array(2 * NONCE_BYTES);
    salt.set(client, 0);
    salt.set(server, NONCE_BYTES);
    const base = await crypto.subtle.importKey("raw", encoder.encode(token), "HKDF", false, ["deriveKey"]);
    /** @param {keyof typeof KEY_INFO} direction @param {KeyUsage} usage */
    const derive = (direction, usage) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(KEY_INFO[direction]) },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        [usage]
      );
    const [out, back] =
      role === "server" ? ["server-to-client", "client-to-server"] : ["client-to-server", "server-to-client"];
    const [sealKey, openKey] = await Promise.all([derive(out, "encrypt"), derive(back, "decrypt")]);
    return new Channel(sealKey, openKey, transmit);
  }

  /**
   * @param {unknown} value
   * @returns {Promise<void>}
   */
  send(value) {
    const plaintext = encoder.encode(JSON.stringify(value));
    const step = this.#sending.then(async () => {
      if (this.#sendFailed) throw new Error("the channel failed to send an earlier frame");
      const counter = this.#sent++;
      try {
        const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(counter) }, this.#sealKey, plaintext);
        this.#transmit(new Uint8Array(sealed), counter);
      } catch (error) {
        this.#sendFailed = true;
        throw error;
      }
    });
    this.#sending = step.catch(() => {});
    return step;
  }

  /**
   * @param {ArrayBuffer | ArrayBufferView} data
   * @returns {Promise<Opened>}
   */
  receive(data) {
    const bytes = asBytes(data);
    const step = this.#opening.then(async () => {
      if (this.#poisoned) return /** @type {Opened} */ ({ ok: false, reason: "poisoned" });
      const opened = await this.#open(bytes);
      if (!opened.ok) this.#poisoned = true;
      return opened;
    });
    this.#opening = step;
    return step;
  }

  /** @param {Uint8Array | null} bytes @returns {Promise<Opened>} */
  async #open(bytes) {
    const counter = this.#opened++;
    if (bytes === null || bytes.byteLength < TAG_BYTES) return { ok: false, reason: "forged" };
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(counter) }, this.#openKey, bytes);
    } catch (error) {
      // WebCrypto throws OperationError for a failed AES-GCM tag check (W3C Web Cryptography API, AES-GCM decrypt).
      if (/** @type {{name?: unknown}} */ (error)?.name === "OperationError") return { ok: false, reason: "forged" };
      return { ok: false, reason: "crypto-error", error };
    }
    return { ok: true, text: decoder.decode(plaintext) };
  }
}
