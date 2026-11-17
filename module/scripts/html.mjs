// @ts-check
// The content of parsed HTML as plain data, to tell whether two HTML texts say the same. The Foundry server rewrites
// HTML when it stores it: measured on 14.370, `<br />` is stored as `<br>`, an entity as its character, `class='x'` as
// `class="x"`, `style="color: red"` as `style="color:red"`, a table gains a `<tbody>`, and a comment is dropped. The
// parsed nodes of the given and of the stored text are then the same.

/**
 * @typedef {{nodeType: number, data?: string, localName?: string, attributes?: Iterable<{name: string, value: string}>,
 *   childNodes: Iterable<DomNode>, content?: {childNodes: Iterable<DomNode>}}} DomNode the part of a DOM node read here
 */
/** @typedef {string | [name: string, attributes: [string, unknown][], children: CanonicalNode[]]} CanonicalNode */
/** @typedef {(style: string) => readonly string[]} StyleOf the declarations of a style attribute, in canonical form */

// Node.ELEMENT_NODE and Node.TEXT_NODE.
const ELEMENT = 1;
const TEXT = 3;

/**
 * Elements by name, attributes sorted by name, and texts. A comment is left out, and the texts on both sides of it
 * count as one, as they are once the text is stored without the comment. A style attribute without a declaration is
 * left out too: measured on 14.370, the server stores `<p style="">` as `<p>`.
 * @param {Iterable<DomNode>} nodes
 * @param {StyleOf} styleOf
 * @returns {CanonicalNode[]}
 */
export function canonicalNodes(nodes, styleOf) {
  /** @type {CanonicalNode[]} */
  const out = [];
  for (const node of nodes) {
    if (node.nodeType === TEXT) {
      const last = out.at(-1);
      if (typeof last === "string") out[out.length - 1] = last + node.data;
      else out.push(node.data ?? "");
    } else if (node.nodeType === ELEMENT) {
      /** @type {[string, unknown][]} */
      const attributes = [...(node.attributes ?? [])].flatMap(
        /** @returns {[string, unknown][]} */ ({ name, value }) => {
          if (name !== "style") return [[name, value]];
          const declarations = styleOf(value);
          return declarations.length > 0 ? [[name, declarations]] : [];
        }
      );
      attributes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      // The children of a template element hang on its content, not on the element.
      const inside = node.localName === "template" && node.content ? node.content : node;
      out.push([node.localName ?? "", attributes, canonicalNodes(inside.childNodes, styleOf)]);
    }
  }
  return out;
}

/**
 * Splits a style attribute at each semicolon that ends a declaration: not one inside quotes or parentheses, such as
 * `content: "a;b"` or `url(data:image/png;base64,...)`, and not one escaped with a backslash.
 * @param {string} style
 * @returns {string[]}
 */
function declarationTexts(style) {
  const pieces = [];
  let start = 0;
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  for (let at = 0; at < style.length; at++) {
    const char = style[at];
    if (char === "\\") at++;
    else if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      pieces.push(style.slice(start, at));
      start = at + 1;
    }
  }
  pieces.push(style.slice(start));
  return pieces;
}

/**
 * The declarations of a style attribute, each as the style parser writes it back. A declaration the parser does not
 * know is kept as its text without the spaces around its colon, which is how the server stores it.
 * @param {string} style
 * @param {(declaration: string) => string} parse one declaration as the style parser writes it back, "" for one it
 *   does not know
 * @returns {string[]}
 */
export function canonicalStyle(style, parse) {
  return declarationTexts(style).flatMap((piece) => {
    const kept = parse(piece) || piece.trim().replace(/\s*:\s*/, ":");
    return kept ? [kept] : [];
  });
}
