// The embedded documents of a document class, and the walk through document data that follows them.

import { isPlainObject } from "./data-diff.mjs";

/**
 * The embedded documents of a class, each with the field that stores them and the class of its documents: Foundry's
 * Document.hierarchy (common/abstract/document.mjs:259-266), whose fields name that class as `model`
 * (common/data/fields.mjs:3033-3035). A token's own actor data is one such document and no collection
 * (common/documents/token.mjs:64).
 * @returns {{field: string, cls: any}[]}
 */
export const embeddedFieldsOf = (cls) =>
  Object.entries(cls.hierarchy).map(([field, { model }]) => ({ field, cls: model }));

/** The document names a class embeds. */
export const embeddedNamesOf = (cls) => embeddedFieldsOf(cls).map(({ cls: inner }) => inner.documentName);

/**
 * Applies `change` to the data of a document, and to the data of each embedded document given inside it, down through
 * their own embedded documents. `path` names where the data lies, and ends in a dot below the top.
 * @param {Record<string, any>} data
 * @param {any} cls
 * @param {(data: Record<string, any>, cls: any, path: string) => Record<string, any>} change gets a shallow copy
 * @param {(documents: unknown[]) => unknown} [collection] what each list of embedded documents becomes
 * @returns {Record<string, any>}
 */
export function mapGiven(data, cls, change, collection = (documents) => documents, path = "") {
  const changed = change({ ...data }, cls, path);
  for (const { field, cls: inner } of embeddedFieldsOf(cls)) {
    const given = changed[field];
    if (Array.isArray(given)) {
      changed[field] = collection(
        given.map((child, index) =>
          isPlainObject(child) ? mapGiven(child, inner, change, collection, `${path}${field}.${index}.`) : child
        )
      );
    } else if (isPlainObject(given)) {
      changed[field] = mapGiven(given, inner, change, collection, `${path}${field}.`);
    }
  }
  return changed;
}

/**
 * Document data with each embedded collection as an object keyed by position, down through the embedded documents'
 * own collections. The comparisons of data-diff.mjs take a list as one value, and so would call a created page changed
 * for the id Foundry gave it. Keyed by position, an embedded document is compared field by field with the one given in
 * its place.
 * @param {unknown} data
 * @param {any} cls
 * @returns {any}
 */
export const byPosition = (data, cls) =>
  isPlainObject(data)
    ? mapGiven(
        data,
        cls,
        (given) => given,
        (documents) => ({ ...documents })
      )
    : data;
