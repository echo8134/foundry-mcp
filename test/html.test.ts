import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalNodes, canonicalStyle, type DomNode } from "../module/scripts/html.mjs";

// Stand-ins for the DOM nodes a browser parses HTML into, with the properties the walk reads.
const text = (data: string): DomNode => ({ nodeType: 3, data, childNodes: [] });
const comment = (data: string): DomNode => ({ nodeType: 8, data, childNodes: [] });
const element = (localName: string, attributes: Record<string, string> = {}, childNodes: DomNode[] = []): DomNode => ({
  nodeType: 1,
  localName,
  attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
  childNodes
});
const asGiven = (style: string) => [style];

describe("canonicalNodes", () => {
  it("keeps elements by name with their children, and texts", () => {
    const nodes = [element("p", {}, [text("one"), element("br"), text("two")]), text("\n"), element("hr")];
    assert.deepEqual(canonicalNodes(nodes, asGiven), [["p", [], ["one", ["br", [], []], "two"]], "\n", ["hr", [], []]]);
  });

  it("puts attributes in one order, whatever order the text had them in", () => {
    const one = canonicalNodes([element("span", { id: "z", class: "b a", "data-x": "1" })], asGiven);
    const other = canonicalNodes([element("span", { "data-x": "1", id: "z", class: "b a" })], asGiven);
    assert.deepEqual(one, [
      [
        "span",
        [
          ["class", "b a"],
          ["data-x", "1"],
          ["id", "z"]
        ],
        []
      ]
    ]);
    assert.deepEqual(other, one);
  });

  it("tells apart two elements that differ in an attribute value, a name, or a text", () => {
    const form = (node: DomNode) => JSON.stringify(canonicalNodes([node], asGiven));
    const base = form(element("p", { class: "a" }, [text("x")]));
    assert.notEqual(form(element("p", { class: "b" }, [text("x")])), base);
    assert.notEqual(form(element("div", { class: "a" }, [text("x")])), base);
    assert.notEqual(form(element("p", { class: "a" }, [text("y")])), base);
    assert.notEqual(form(element("p", {}, [text("x")])), base);
  });

  it("leaves a comment out and joins the texts on both sides of it", () => {
    const withComment = [element("p", {}, [text("a"), comment(" note "), text("b")]), comment("end")];
    assert.deepEqual(canonicalNodes(withComment, asGiven), [["p", [], ["ab"]]]);
    assert.deepEqual(canonicalNodes([element("p", {}, [text("ab")])], asGiven), [["p", [], ["ab"]]]);
  });

  it("hands the style attribute, and no other, to the style reader", () => {
    const seen: string[] = [];
    const styleOf = (style: string) => {
      seen.push(style);
      return ["parsed"];
    };
    const nodes = [element("p", { style: "color: red", title: "color: red" })];
    assert.deepEqual(canonicalNodes(nodes, styleOf), [
      [
        "p",
        [
          ["style", ["parsed"]],
          ["title", "color: red"]
        ],
        []
      ]
    ]);
    assert.deepEqual(seen, ["color: red"]);
  });

  it("leaves out a style attribute without a declaration, as the server stores it", () => {
    const none = () => [];
    assert.deepEqual(canonicalNodes([element("p", { style: "", class: "x" }, [text("t")])], none), [
      ["p", [["class", "x"]], ["t"]]
    ]);
  });

  it("reads the children of a template element from its content", () => {
    const template: DomNode = { ...element("template"), content: { childNodes: [element("p", {}, [text("inside")])] } };
    assert.deepEqual(canonicalNodes([template], asGiven), [["template", [], [["p", [], ["inside"]]]]]);
  });
});

describe("canonicalStyle", () => {
  // Stands in for the browser: it knows color and margin, and writes them back in its own spelling.
  const parse = (declaration: string) => {
    const [name, value] = declaration.split(":").map((part) => part.trim().toLowerCase());
    return name === "color" || name === "margin" ? `${name}: ${value};` : "";
  };

  it("writes each declaration as the style parser does, so spaces, case and a last semicolon make no difference", () => {
    const expected = ["color: red;", "margin: 0;"];
    assert.deepEqual(canonicalStyle("color: red; margin: 0", parse), expected);
    assert.deepEqual(canonicalStyle("COLOR:RED;margin:0;", parse), expected);
    assert.deepEqual(canonicalStyle(" color : red ;; margin:0 ; ", parse), expected);
  });

  it("keeps a declaration the parser does not know, as its text without the spaces around the colon", () => {
    assert.deepEqual(canonicalStyle("color: red; frobnicate: 3", parse), ["color: red;", "frobnicate:3"]);
    assert.deepEqual(canonicalStyle("frobnicate:3", parse), ["frobnicate:3"]);
    assert.notDeepEqual(canonicalStyle("frobnicate: 4", parse), canonicalStyle("frobnicate: 3", parse));
    assert.deepEqual(canonicalStyle("background: url(a:b) ", parse), ["background:url(a:b)"]);
  });

  it("keeps the order of the declarations, which decides between two of the same property", () => {
    assert.notDeepEqual(
      canonicalStyle("color: red; color: blue", parse),
      canonicalStyle("color: blue; color: red", parse)
    );
  });

  it("splits only at a semicolon that ends a declaration, not at one inside quotes, parentheses or an escape", () => {
    assert.deepEqual(canonicalStyle('content: "a; color:blue"', parse), ['content:"a; color:blue"']);
    assert.notDeepEqual(
      canonicalStyle('content: "a";color:blue"', parse),
      canonicalStyle('content: "a; color:blue"', parse)
    );
    assert.deepEqual(canonicalStyle("content: 'it\\'s; here'; color: red", parse), [
      "content:'it\\'s; here'",
      "color: red;"
    ]);
    assert.deepEqual(canonicalStyle("background: url(data:image/png;base64,AA); margin: 0", parse), [
      "background:url(data:image/png;base64,AA)",
      "margin: 0;"
    ]);
    assert.deepEqual(canonicalStyle("content: a\\;b", parse), ["content:a\\;b"]);
  });

  it("is empty for a style without a declaration", () => {
    assert.deepEqual(canonicalStyle("", parse), []);
    assert.deepEqual(canonicalStyle(" ; ", parse), []);
  });
});
