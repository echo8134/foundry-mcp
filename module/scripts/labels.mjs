// @ts-check
// A caller may name an activity or an effect by a label of its own where Foundry wants a document id. The same label
// always becomes the same id, so a second call finds what the first one made.

const DOCUMENT_ID = /^[a-zA-Z0-9]{16}$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 16;

/**
 * @param {unknown} value
 * @returns {value is string} whether the value has the form of a Foundry document id (common/data/validators.mjs:8-10)
 */
export const isDocumentId = (value) => typeof value === "string" && DOCUMENT_ID.test(value);

/**
 * FNV-1a over the UTF-16 code units of the text.
 * @param {string} text
 * @param {number} basis the offset basis, which tells two hashes of one text apart
 */
function fnv1a(text, basis) {
  let hash = basis;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Hashed here and not with crypto.subtle, which a Foundry served over plain http on a LAN does not have. The mapping
 * must never change: an id made from a label by an earlier version is how a later call finds that activity or effect.
 * @param {string} label
 * @returns {string} a document id that depends on nothing but the label
 */
export function idFromLabel(label) {
  // A xorshift state of 0 would stay 0.
  let state = fnv1a(label, 0x811c9dc5) || 1;
  let mix = fnv1a(label, 0x9747b28c);
  let id = "";
  for (let index = 0; index < ID_LENGTH; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    mix = (Math.imul(mix ^ (mix >>> 15), 0x2c1b3c6d) + state) >>> 0;
    id += ALPHABET[((state ^ mix) >>> 0) % ALPHABET.length];
  }
  return id;
}

/**
 * @param {string} value a document id, or a label
 * @returns {string} the id itself, or the id of the label
 */
export const idFor = (value) => (isDocumentId(value) ? value : idFromLabel(value));
