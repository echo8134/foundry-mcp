// @ts-check

export const ERROR_CODES = Object.freeze(
  /** @type {const} */ (["unknown_method", "invalid_params", "not_found", "foundry_error"])
);

/** @typedef {(typeof ERROR_CODES)[number]} ErrorCode */

export class MethodError extends Error {
  /** @param {ErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "MethodError";
    this.code = code;
  }
}
