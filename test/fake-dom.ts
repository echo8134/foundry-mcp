// Stand-ins for the two things world.mjs asks the browser's document for, and for what the Foundry server does to HTML
// it stores. They read the small part of HTML the tests write: tags with quoted or bare attributes, comments, texts,
// and a few entities. Written from what was measured on Foundry 14.370 and Chromium, not from any parser's code.

type DomNode = {
  nodeType: number;
  data?: string;
  localName?: string;
  attributes?: { name: string; value: string }[];
  childNodes: DomNode[];
};

const ENTITIES: Record<string, string> = {
  "&mdash;": "—",
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"'
};
const VOID = new Set(["br", "hr", "img"]);
const TOKEN =
  /<!--([\s\S]*?)-->|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
const ATTRIBUTE = /([a-z-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi;

const decode = (text: string) => text.replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity);

/** An entity becomes its character, a name that is no entity stays as it is, and a tag name is read in lower case. */
function parseHtml(html: string): DomNode[] {
  const root: DomNode = { nodeType: 1, localName: "#root", childNodes: [] };
  const open = [root];
  for (const [, comment, closing, opening, attributeText, text] of html.matchAll(TOKEN)) {
    const parent = open.at(-1)!;
    if (comment !== undefined) parent.childNodes.push({ nodeType: 8, data: comment, childNodes: [] });
    else if (text !== undefined) parent.childNodes.push({ nodeType: 3, data: decode(text), childNodes: [] });
    else if (closing !== undefined) {
      const at = open.findLastIndex((node) => node.localName === closing.toLowerCase());
      if (at > 0) open.length = at;
    } else if (opening !== undefined) {
      const attributes = [...(attributeText ?? "").matchAll(ATTRIBUTE)].map(([, name, double, single, bare]) => ({
        name: name!.toLowerCase(),
        value: decode(double ?? single ?? bare ?? "")
      }));
      const node: DomNode = { nodeType: 1, localName: opening.toLowerCase(), attributes, childNodes: [] };
      parent.childNodes.push(node);
      if (!VOID.has(node.localName!)) open.push(node);
    }
  }
  return root.childNodes;
}

const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The style as the server stores it: no space around a colon or a semicolon, and no semicolon at the end. */
const storedStyle = (style: string) =>
  style
    .split(";")
    .map((piece) => piece.trim().replace(/\s*:\s*/, ":"))
    .filter(Boolean)
    .join(";");

function serialise(nodes: DomNode[]): string {
  return nodes
    .map((node) => {
      if (node.nodeType === 3) return escapeText(node.data!);
      if (node.nodeType !== 1) return "";
      const attributes = node
        .attributes!.flatMap(({ name, value }) => {
          const stored = name === "style" ? storedStyle(value) : value;
          if (name === "style" && stored === "") return [];
          return [` ${name}="${stored.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`];
        })
        .join("");
      const tag = `<${node.localName}${attributes}>`;
      return VOID.has(node.localName!) ? tag : `${tag}${serialise(node.childNodes)}</${node.localName}>`;
    })
    .join("");
}

/**
 * HTML as the Foundry server stores it, measured on 14.370: `<br />` as `<br>`, an entity as its character, an
 * attribute in double quotes, a style without its spaces and no style without a declaration, an ampersand that starts
 * no entity as `&amp;`, and no comment.
 */
export const storedHtml = (html: string) => serialise(parseHtml(html));

/** The properties the stand-in style parser knows. Chromium writes a declaration back as `name: value;`, in lower case. */
const KNOWN_PROPERTIES = new Set(["color", "font-weight", "margin"]);

function parsedDeclaration(declaration: string) {
  const colon = declaration.indexOf(":");
  if (colon < 0) return "";
  const name = declaration.slice(0, colon).trim().toLowerCase();
  const value = declaration
    .slice(colon + 1)
    .trim()
    .toLowerCase();
  return KNOWN_PROPERTIES.has(name) && value ? `${name}: ${value};` : "";
}

/** `document`, as far as world.mjs uses it: a template element that parses HTML, and an element whose style parses a declaration. */
export const fakeDocument = {
  createElement(name: string) {
    if (name === "template") {
      const content = { childNodes: [] as DomNode[] };
      return {
        content,
        set innerHTML(html: string) {
          content.childNodes = parseHtml(html);
        }
      };
    }
    let cssText = "";
    return {
      style: {
        get cssText() {
          return cssText;
        },
        set cssText(declaration: string) {
          cssText = parsedDeclaration(declaration);
        }
      }
    };
  }
};
