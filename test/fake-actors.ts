// The actors of the fake world with their items and active effects, and the actor of an unlinked token. Written from
// what was measured on Foundry 14.370 with dnd5e 6.1.0: every "measured" below names a behavior seen in the live world,
// for a token's actor in what the server holds and not in what the page shows.

import assert from "node:assert/strict";
import {
  applyChanges,
  cleanValue,
  cloneChanges,
  ForcedDeletion,
  isObject,
  merge,
  ownershipErrors,
  sanitizeHtml,
  validationErrors
} from "./fake-model.ts";
import { ObjectField, SchemaField, type systemConfig, TypeDataField5e, TypedObjectField } from "./fake-system.ts";

export class Collection<T> extends Map<string, T> {
  filter(fn: (value: T) => boolean) {
    return [...this.values()].filter(fn);
  }
  map<R>(fn: (value: T) => R) {
    return [...this.values()].map(fn);
  }
  find(fn: (value: T) => boolean) {
    return [...this.values()].find(fn);
  }
}

type Source = Record<string, any>;
type Kind = {
  name: "Actor" | "Item" | "ActiveEffect";
  collection: string;
  schema: SchemaField;
  models: Record<string, any>;
};
/** One write of embedded documents, as the fake saw it. */
export type EmbeddedWrite = {
  action: "create" | "update" | "delete";
  document: "Item" | "ActiveEffect";
  parent: string;
  data: any[];
  keepId?: true;
};

/** Where the embedded documents of one parent are stored. `edit` gives the stored record to change in place. */
type Shelf = { list(): Source[]; put(source: Source): void; edit(id: string): Source; drop(id: string): void };

const plainShelf = (records: () => Source[]): Shelf => ({
  list: records,
  put: (source) => void records().push(source),
  edit: (id) => records().find((record) => record._id === id)!,
  drop: (id) => {
    const all = records();
    all.splice(
      all.findIndex((record) => record._id === id),
      1
    );
  }
});

/**
 * The embedded documents of a token's actor: those of the world actor, with the token's own records over them
 * (common/documents/actor-delta.mjs:135-146). Measured: a document of the world actor that is changed for the token is
 * stored whole with the token, one that is deleted for it leaves a tombstone, and one the token added is gone when it
 * is deleted. `own` reads the token's records, and `ownForWrite` makes the list when the token has none yet.
 */
const deltaShelf = (base: () => Source[], own: () => Source[], ownForWrite: () => Source[]): Shelf => ({
  list: () => {
    const records = own();
    const ids = new Set(records.map((record) => record._id));
    return [...records.filter((record) => !record._tombstone), ...base().filter((record) => !ids.has(record._id))];
  },
  put: (source) => void ownForWrite().push(source),
  edit: (id) => {
    const records = ownForWrite();
    const mine = records.find((record) => record._id === id);
    if (mine) return mine;
    const copy = structuredClone(base().find((record) => record._id === id)!);
    records.push(copy);
    return copy;
  },
  drop: (id) => {
    const records = ownForWrite();
    const at = records.findIndex((record) => record._id === id);
    if (at >= 0) records.splice(at, 1);
    if (base().some((record) => record._id === id)) records.push({ _id: id, _tombstone: true });
  }
});

/** The effects of an item, which are stored inside the item's record: for a token's actor inside the token's copy of it. */
const effectsOfItem = (items: Shelf, itemId: string): Shelf => ({
  list: () => items.list().find((record) => record._id === itemId)?.effects ?? [],
  put: (source) => void items.edit(itemId).effects.push(source),
  edit: (id) => items.edit(itemId).effects.find((record: Source) => record._id === id),
  drop: (id) => {
    const effects = items.edit(itemId).effects;
    effects.splice(
      effects.findIndex((record: Source) => record._id === id),
      1
    );
  }
});

type Env = {
  system: ReturnType<typeof systemConfig>;
  folders: Collection<any>;
  log: {
    notifications: string[];
    actorCreates: Record<string, any>[];
    actorUpdates: { id: string; changes: Record<string, any> }[];
    actorDeletes: string[][];
    embedded: EmbeddedWrite[];
  };
  control: Record<string, any>;
  delay: () => Promise<void>;
  nextNumber: () => number;
  makeToken: (data: Record<string, any>, scene: any, id: string | null) => any;
  viewedScene: () => any;
  userId: string;
  /** The documents of a compendium pack, which the world keeps for every document type. */
  packDocuments: (pack: string, documentName: string) => Collection<any>;
};

export function fakeActors(env: Env) {
  const { system, folders, log, control, delay } = env;
  const actors = new Collection<any>();
  const items = new Collection<any>();
  const kinds: Record<Kind["name"], Kind> = {
    Actor: {
      name: "Actor",
      collection: "actors",
      schema: system.Actor.documentClass.schema,
      models: system.Actor.dataModels
    },
    Item: {
      name: "Item",
      collection: "items",
      schema: system.Item.documentClass.schema,
      models: system.Item.dataModels
    },
    ActiveEffect: {
      name: "ActiveEffect",
      collection: "effects",
      schema: system.ActiveEffect.documentClass.schema,
      models: system.ActiveEffect.dataModels
    }
  };
  /** A valid document id, as Foundry gives every embedded document one. */
  const newId = (prefix: string) => `${prefix}${String(env.nextNumber()).padStart(16 - prefix.length, "0")}`;

  /** The fields of a document of a type: the document's own, with `system` as the data model of the type has it. */
  const fieldsOf = (kind: Kind, type: string) =>
    new SchemaField({ ...kind.schema.fields, system: kind.models[type]?.schema ?? new ObjectField() });

  /** What the model makes of given data: the system's migration of old shapes first, then the cleaning of each field. */
  function cleanDocument(kind: Kind, data: Source, type: string, options: { partial: boolean; source?: unknown }) {
    if (isObject(data.system)) kind.models[type]?.migrate?.(data.system);
    return cleanValue(fieldsOf(kind, type), data, options) as Source;
  }

  /** What Foundry's validation has against cleaned changes: against the changes themselves, and against the data they lead to. */
  function changeErrors(kind: Kind, type: string, source: Source, cleaned: Source) {
    const next = applyChanges(structuredClone(source), cleaned);
    const given = isObject(cleaned.ownership) ? ownershipErrors(cleaned.ownership) : [];
    return [...given, ...validationErrors(fieldsOf(kind, type), next)];
  }

  /**
   * validate with changes is a dry run of an update (common/abstract/data.mjs:575): it cleans the changes, the given
   * object itself when clean.copy is false, and throws what the update would refuse, or answers false when it is not
   * strict.
   */
  function checkable(document: any, kind: Kind, stored: () => Source) {
    document.validate = ({
      changes,
      clean,
      strict = true
    }: {
      changes: Source;
      clean?: { copy?: boolean };
      strict?: boolean;
    }) => {
      const cleaned = cleanDocument(kind, clean?.copy === false ? changes : cloneChanges(changes), document.type, {
        partial: true,
        source: stored()
      });
      const errors = changeErrors(kind, document.type, stored(), cleaned);
      if (errors.length > 0 && strict) throw new Error(`${kind.name} validation errors: ${errors.join("; ")}`);
      return errors.length === 0;
    };
  }

  /**
   * Measured: structuredClone refuses the stored data of some items with a DataCloneError (a spell copied from a
   * compendium), and of the actor that has such an item, while Foundry's own deepClone and toObject copy it. The
   * stand-in refuses it for every item and effect, and for every actor that has an item.
   */
  const uncloneable = (source: Source) => new Proxy(source, {});

  /**
   * The stored data Foundry's class builds from given data, cleaned in place, or the error its model throws. Measured:
   * a type the system lacks and a missing name throw, and so does a value of the wrong kind in an activity or in an
   * effect of the item's creation data.
   */
  function builtSource(kind: Kind, data: Source) {
    const type = data.type ?? (kind.name === "ActiveEffect" ? "base" : undefined);
    if (!kind.models[type]) {
      throw new Error(`${kind.name} validation errors: type: "${type}" is not a valid type`);
    }
    const nested = kind.name === "ActiveEffect" ? undefined : (data.effects ?? []);
    delete data.effects;
    cleanDocument(kind, data, type, { partial: false });
    const errors = validationErrors(fieldsOf(kind, type), data);
    if (errors.length > 0) throw new Error(`${kind.name} validation errors: ${errors.join("; ")}`);
    if (nested) {
      data.effects = nested.map((effect: Source, index: number) => {
        try {
          return builtSource(kinds.ActiveEffect, effect);
        } catch (error) {
          throw new Error(`${kind.name} validation errors: effects: ${index}: ${(error as Error).message}`);
        }
      });
    }
    return data;
  }

  /** Document#getEmbeddedCollection, which throws for a name the class does not embed (common/abstract/document.mjs:828-835). */
  function embeddedOf(parent: any, name: string) {
    const held: Record<string, string> = system[parent.documentName as Kind["name"]].documentClass.metadata.embedded;
    const collection = held[name];
    if (!collection) {
      throw new Error(`${name} is not a valid embedded Document within the ${parent.documentName} Document`);
    }
    return parent[collection];
  }

  /** The documents of a shelf by id. A document stays the same object while its record is there, and reads it live. */
  function liveCollection(shelf: Shelf, make: (id: string) => any) {
    const made = new Map<string, any>();
    return () =>
      new Collection<any>(
        shelf.list().map((record) => {
          if (!made.has(record._id)) made.set(record._id, make(record._id));
          return [record._id, made.get(record._id)];
        })
      );
  }

  function effectDocument(read: () => Source, parent: any) {
    const effect: any = {
      documentName: "ActiveEffect",
      parent,
      get _source() {
        return uncloneable(read());
      },
      toObject: () => structuredClone(read()),
      get id() {
        return read()._id ?? null;
      },
      get uuid() {
        return `${parent.uuid}.ActiveEffect.${read()._id}`;
      },
      get name() {
        return read().name;
      },
      get type() {
        return read().type ?? "base";
      },
      get disabled() {
        return read().disabled ?? false;
      },
      get flags() {
        return read().flags ?? {};
      }
    };
    checkable(effect, kinds.ActiveEffect, read);
    return effect;
  }

  const recordOf = (shelf: Shelf, id: string) => () => shelf.list().find((record) => record._id === id)!;

  function itemDocument(
    read: () => Source,
    effects: Shelf,
    parent: any,
    identity: { uuid: string; pack: string | null }
  ) {
    const item: any = {
      documentName: "Item",
      parent,
      actor: parent,
      ...identity,
      get _source() {
        return uncloneable(read());
      },
      get id() {
        return read()._id ?? null;
      },
      get name() {
        return read().name;
      },
      get type() {
        return read().type;
      },
      get flags() {
        return read().flags ?? {};
      },
      toObject: () => structuredClone(read()),
      getEmbeddedCollection: (name: string) => embeddedOf(item, name)
    };
    const collection = liveCollection(effects, (id) => effectDocument(recordOf(effects, id), item));
    Object.defineProperty(item, "effects", { get: collection });
    checkable(item, kinds.Item, read);
    embedded(item, { ActiveEffect: effects });
    return item;
  }

  /** What dnd5e does to an item before it is created on an actor, as far as measured. Answers false to refuse it. */
  function beforeItemCreate(source: Source, given: Source, actor: any) {
    // dnd5e module/documents/item.mjs:1144-1145: a group takes physical items only, without an error.
    if (actor.type === "group" && source.type === "feat") return false;
    // dnd5e module/data/item/feat.mjs:452-454.
    if (source.type === "feat" && actor.type === "npc" && given.system?.type?.value === undefined) {
      source.system.type.value = "monster";
    }
    // dnd5e module/data/item/templates/advancement.mjs:69-70: only for data that has no id.
    if (source.type === "class" && !given._id && given.system?.advancement === undefined) {
      source.system.advancement = { [newId("advance")]: { level: 1 } };
    }
    return true;
  }

  /**
   * One embedded document of a create, or null where Foundry skips it without an error: data its model refuses
   * (client/data/client-backend.mjs:91-108), and a creation the system or a hook refuses. Measured: an id is kept only
   * with keepId, the effects in an item's creation data keep theirs, an effect made on an actor does not transfer
   * (common/documents/active-effect.mjs:128-136), and a taken id throws.
   */
  function createdSource(kind: Kind, given: Source, parent: any, taken: Set<string>, keepId: boolean) {
    let source: Source;
    try {
      source = builtSource(kind, structuredClone(given));
    } catch (error) {
      log.notifications.push(`${kind.name} skipped: ${(error as Error).message}`);
      return null;
    }
    const id = keepId && given._id ? given._id : newId(kind.collection.slice(0, -1));
    if (taken.has(id)) throw new Error(`The _id [${id}] already exists within the parent collection`);
    source._id = id;
    if (kind.name === "Item") {
      if (!beforeItemCreate(source, given, parent)) return null;
      for (const effect of source.effects) effect._id ??= newId("effect");
    } else if (parent.documentName === "Actor") source.transfer = false;
    if (control.vetoEmbedded?.(kind.name, given)) {
      log.notifications.push(`${kind.name} creation prevented`);
      return null;
    }
    control.filterEmbeddedData?.(kind.name, source);
    stored(kind, source);
    return source;
  }

  /**
   * What the stored data of an item or effect holds once written: HTML in the server's spelling, and measured, every
   * activity with all the fields of its type, also one that an update gave only in part.
   */
  function stored(kind: Kind, source: Source) {
    const fields = fieldsOf(kind, source.type ?? "base");
    for (const [key, field] of Object.entries(fields.fields.system.fields ?? {})) {
      if (!(field instanceof TypedObjectField && field.element instanceof TypeDataField5e)) continue;
      const entries = source.system?.[key] ?? {};
      for (const id of Object.keys(entries)) entries[id] = cleanValue(field.element, entries[id], { partial: false });
    }
    sanitizeHtml(fields, source);
    for (const effect of source.effects ?? [])
      sanitizeHtml(fieldsOf(kinds.ActiveEffect, effect.type ?? "base"), effect);
  }

  /**
   * The embedded-document calls of a parent, for the kinds it has a shelf for. Measured: a create answers with the
   * documents in another order than the data, an update or a deletion that names an id the parent does not have throws
   * and writes nothing, and an update is skipped without an error where its result fails validation.
   */
  function embedded(parent: any, shelves: Partial<Record<"Item" | "ActiveEffect", Shelf>>) {
    const on = (name: "Item" | "ActiveEffect") => {
      const shelf = shelves[name];
      assert.ok(shelf, `${parent.documentName} has no embedded ${name}`);
      return { shelf, kind: kinds[name], documents: () => parent[kinds[name].collection] as Collection<any> };
    };
    const record = (entry: EmbeddedWrite) => {
      log.embedded.push(entry);
      const failure = control.embeddedError?.(entry.action, entry.document);
      return () => {
        if (failure) throw new Error(failure);
      };
    };
    const mustHave = (documents: Collection<any>, ids: string[]) => {
      for (const id of ids) {
        if (!documents.has(id))
          throw new Error(`undefined id [${id}] does not exist in the EmbeddedCollection collection.`);
      }
    };
    parent.createEmbeddedDocuments = async (
      name: "Item" | "ActiveEffect",
      data: Source[],
      options: { keepId?: boolean } = {}
    ) => {
      const { shelf, kind, documents } = on(name);
      await delay();
      const fail = record({
        action: "create",
        document: name,
        parent: parent.uuid,
        data: structuredClone(data),
        ...(options.keepId && { keepId: true })
      });
      const taken = new Set(documents().keys());
      const made: string[] = [];
      for (const given of data) {
        const source = createdSource(kind, given, parent, taken, options.keepId === true);
        if (!source) continue;
        shelf.put(source);
        taken.add(source._id);
        made.push(source._id);
      }
      fail();
      return made.reverse().map((id) => documents().get(id));
    };
    parent.updateEmbeddedDocuments = async (name: "Item" | "ActiveEffect", updates: Source[]) => {
      const { shelf, kind, documents } = on(name);
      await delay();
      mustHave(
        documents(),
        updates.map((update) => update._id)
      );
      const fail = record({ action: "update", document: name, parent: parent.uuid, data: cloneChanges(updates) });
      const changed: string[] = [];
      for (const { _id, ...changes } of updates) {
        const { type } = documents().get(_id);
        const current = shelf.list().find((one) => one._id === _id)!;
        const cleaned = cleanDocument(kind, cloneChanges(changes), type, { partial: true, source: current });
        control.filterEmbeddedChanges?.(name, cleaned);
        const errors = changeErrors(kind, type, current, cleaned);
        if (errors.length > 0) {
          log.notifications.push(`${name} update skipped: ${errors.join("; ")}`);
          continue;
        }
        const source = shelf.edit(_id);
        applyChanges(source, cleaned);
        stored(kind, source);
        changed.push(_id);
      }
      fail();
      return changed.map((id) => documents().get(id));
    };
    parent.deleteEmbeddedDocuments = async (name: "Item" | "ActiveEffect", ids: string[]) => {
      const { shelf, documents } = on(name);
      await delay();
      mustHave(documents(), ids);
      const fail = record({ action: "delete", document: name, parent: parent.uuid, data: [...ids] });
      const deleted = ids.map((id) => documents().get(id));
      for (const id of ids) shelf.drop(id);
      fail();
      return deleted;
    };
  }

  /** Gives a parent its items and effects from the shelves that store them. */
  function shelved(actor: any, itemShelf: Shelf, effectShelf: Shelf) {
    const itemsOf = liveCollection(itemShelf, (id) =>
      itemDocument(recordOf(itemShelf, id), effectsOfItem(itemShelf, id), actor, {
        uuid: `${actor.uuid}.Item.${id}`,
        pack: actor.pack
      })
    );
    const effectsOf = liveCollection(effectShelf, (id) => effectDocument(recordOf(effectShelf, id), actor));
    Object.defineProperty(actor, "items", { get: itemsOf, configurable: true });
    Object.defineProperty(actor, "effects", { get: effectsOf, configurable: true });
    embedded(actor, { Item: itemShelf, ActiveEffect: effectShelf });
  }

  /**
   * An update of an actor's own data, for a world actor and for a token's own actor alike: it cleans, passes the
   * stand-in hook, and is skipped without an error when the result fails validation
   * (client/data/client-backend.mjs:246-259). The server then stores HTML in its own spelling.
   */
  function writable(actor: any, stored: () => Source, store: (cleaned: Source) => void) {
    checkable(actor, kinds.Actor, stored);
    actor.update = async (changes: Source) => {
      await delay();
      log.actorUpdates.push({ id: actor.id, changes: cloneChanges(changes) });
      const cleaned = cleanDocument(kinds.Actor, cloneChanges(changes), actor.type, {
        partial: true,
        source: stored()
      });
      control.filterActorChanges?.(cleaned);
      const errors = changeErrors(kinds.Actor, actor.type, stored(), cleaned);
      if (errors.length > 0) {
        log.notifications.push(`Actor update skipped: ${errors.join("; ")}`);
        return undefined;
      }
      sanitizeHtml(fieldsOf(kinds.Actor, actor.type), cleaned);
      store(cleaned);
      if (control.actorUpdateError) throw new Error(control.actorUpdateError);
      return actor;
    };
  }

  /** The tokens built for each actor, stored or not: a token registers with its base actor (client/documents/token.mjs:434). */
  const dependentTokens = new Map<string, Set<any>>();
  /** The part of Actor#getDependentTokens (client/documents/actor.mjs:597-625) that concreteOnly decides. */
  const inItsScene = (token: any) => token.parent.tokens.get(token.id) === token;

  /**
   * An actor around its stored data, which holds its items and effects. `prepared` stands in for what dnd5e derives
   * from the stored `system`, and without it the prepared data is the stored one. `tokenImages` are the files a
   * wildcard token image of the prototype token matches.
   */
  function actorDocument(
    source: Source,
    { id, prepared, tokenImages = [] }: { id: string | null; prepared?: any; tokenImages?: string[] }
  ) {
    let lastWildcard: string | undefined;
    source.items ??= [];
    source.effects ??= [];
    const actor: any = {
      id,
      uuid: `Actor.${id}`,
      documentName: "Actor",
      get _source() {
        return source.items.length > 0 ? uncloneable(source) : source;
      },
      pack: null,
      isToken: false,
      token: null,
      prototypeToken: { toObject: () => structuredClone(source.prototypeToken) },
      get system() {
        return prepared ?? source.system;
      },
      get name() {
        return source.name;
      },
      get type() {
        return source.type;
      },
      get img() {
        return source.img;
      },
      get flags() {
        return source.flags;
      },
      get folder() {
        return source.folder ? folders.get(source.folder) : null;
      },
      /** The stored data with the embedded documents in it, as Document#toObject gives it. */
      toObject: () => ({ ...structuredClone(source), _id: id }),
      getEmbeddedCollection: (name: string) => embeddedOf(actor, name),
      getDependentTokens({ concreteOnly = false }: { concreteOnly?: boolean } = {}) {
        return [...(dependentTokens.get(id ?? "") ?? [])].filter((token) => !concreteOnly || inItsScene(token));
      },
      /**
       * Actor#getTokenDocument (client/documents/actor.mjs:337): an unsaved token from the prototype token with the data
       * merged over it, on the given parent scene or else the viewed one. An unlinked copy with appendNumber is named with
       * the lowest number no token of this actor on that scene has. With randomImg and no image given, each call takes
       * one of the wildcard images, and never the one the call before took when there are several. Invalid data throws,
       * as the token constructor does.
       */
      async getTokenDocument(data: Record<string, any> = {}, tokenOptions: { parent?: any } = {}) {
        const parent = tokenOptions.parent ?? env.viewedScene();
        const { appendNumber, ...prototype } = structuredClone(source.prototypeToken);
        const tokenData: Record<string, any> = { ...prototype, actorId: id };
        if (tokenData.randomImg && !data.texture?.src) {
          const fresh = tokenImages.filter((image: string) => image !== lastWildcard);
          lastWildcard = (tokenImages.length > 1 ? fresh : tokenImages)[0];
          tokenData.texture = { ...tokenData.texture, src: lastWildcard };
        }
        if (!tokenData.actorLink && appendNumber) {
          const taken = new Set(parent.tokens.filter((token: any) => token.actorId === id).map((t: any) => t.name));
          let number = 1;
          while (taken.has(`${tokenData.name} (${number})`)) number++;
          tokenData.name = `${tokenData.name} (${number})`;
        }
        return env.makeToken(merge(tokenData, structuredClone(data)), parent, null);
      }
    };
    shelved(
      actor,
      plainShelf(() => source.items),
      plainShelf(() => source.effects)
    );
    writable(
      actor,
      () => source,
      (cleaned) => applyChanges(source, cleaned)
    );
    return actor;
  }

  /** An item or effect of a test's setup: stored as the test gives it, over an id and a few defaults, without cleaning. */
  const setUpEffect = (effect: Source) => ({ _id: newId("effect"), disabled: false, ...structuredClone(effect) });
  const setUpItem = (item: Source) => ({
    _id: newId("item"),
    system: {},
    flags: {},
    ...structuredClone(item),
    effects: (item.effects ?? []).map(setUpEffect)
  });

  /** An actor of a test's setup: its data is stored as the test gives it, over a few defaults, without cleaning. */
  function makeActor(data: Record<string, any>) {
    const {
      id = `actor${env.nextNumber()}`,
      prepared,
      items: ownItems = [],
      effects = [],
      tokenImages,
      ...rest
    } = data;
    const source: Source = {
      name: "",
      type: "npc",
      img: "icons/svg/mystery-man.svg",
      folder: null,
      system: {},
      prototypeToken: { name: rest.name ?? "", actorLink: false },
      ownership: { default: 0 },
      flags: {},
      ...structuredClone(rest),
      items: ownItems.map(setUpItem),
      effects: effects.map(setUpEffect)
    };
    return actorDocument(source, { id, prepared, tokenImages });
  }

  /**
   * An actor as Foundry's own class builds it from given data: the object it is given becomes its stored data and is
   * cleaned in place, and data the model refuses throws (measured on 14.370). Its items and effects are stored as the
   * data has them, with their ids: measured, an item in an actor's creation data gets none of dnd5e's item defaults.
   */
  function builtActor(data: Source, id: string | null) {
    const { items: ownItems = [], effects = [] } = data;
    delete data.items;
    delete data.effects;
    if (!kinds.Actor.models[data.type]) {
      throw new Error(`Actor validation errors: type: "${data.type}" is not a valid type`);
    }
    cleanDocument(kinds.Actor, data, data.type, { partial: false });
    data._id = id;
    const errors = validationErrors(fieldsOf(kinds.Actor, data.type), data);
    if (errors.length > 0) throw new Error(`Actor validation errors: ${errors.join("; ")}`);
    data.items = ownItems.map((item: Source) => ({ _id: newId("item"), ...item }));
    data.effects = effects.map((effect: Source) => ({ _id: newId("effect"), ...effect }));
    return actorDocument(data, { id });
  }

  /** The changes of an update without its deletions, and without the objects that held nothing else. */
  function withoutDeletions(changes: Source) {
    const kept: Source = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value instanceof ForcedDeletion) continue;
      if (!isObject(value)) kept[key] = value;
      else {
        const inner = withoutDeletions(value);
        if (Object.keys(inner).length > 0 || Object.keys(value).length === 0) kept[key] = inner;
      }
    }
    return kept;
  }

  /**
   * An unlinked token's actor: the base actor with the token's delta merged over it (common/documents/actor-delta.mjs:92).
   * An update of it goes into the delta (client/data/client-backend.mjs:762-767) and leaves the world actor as it was.
   * Measured on 14.370, as the server returns the scene and as the page shows it once loaded again: such an update
   * leaves that update alone as the token's own actor data, which drops what the token changed there before, and
   * removes nothing. It keeps the token's items and effects. An update of the token with a delta merges into it and
   * applies its deletions. The embedded-document calls of this actor write the token's own items and effects and keep
   * everything else the token has.
   */
  function syntheticActor(base: any, token: any) {
    const delta = () => token._source.delta as Source;
    const own = (name: "items" | "effects") => ({
      read: () => (delta()[name] ?? []) as Source[],
      write: () => {
        delta()[name] ??= [];
        return delta()[name] as Source[];
      }
    });
    const itemShelf = deltaShelf(() => base._source.items, own("items").read, own("items").write);
    const effectShelf = deltaShelf(() => base._source.effects, own("effects").read, own("effects").write);
    const actor: any = {
      id: base.id,
      uuid: `${token.parent.uuid}.Token.${token.id}.Actor.${base.id}`,
      documentName: "Actor",
      get _source() {
        const { items: _items, effects: _effects, ...changes } = structuredClone(delta());
        return {
          ...merge(base.toObject(), changes),
          items: itemShelf.list(),
          effects: effectShelf.list()
        };
      },
      pack: null,
      isToken: true,
      token,
      folder: null,
      prototypeToken: base.prototypeToken,
      get system() {
        return merge(structuredClone(base.system), structuredClone(delta().system ?? {}));
      },
      get name() {
        return actor._source.name;
      },
      get type() {
        return actor._source.type;
      },
      get img() {
        return actor._source.img;
      },
      get flags() {
        return actor._source.flags;
      },
      toObject: () => structuredClone(actor._source),
      getEmbeddedCollection: (name: string) => embeddedOf(actor, name),
      getDependentTokens: ({ concreteOnly = false }: { concreteOnly?: boolean } = {}) =>
        !concreteOnly || inItsScene(token) ? [token] : []
    };
    shelved(actor, itemShelf, effectShelf);
    writable(
      actor,
      () => actor._source,
      (cleaned) => {
        const { items: ownItems, effects } = delta();
        token._source.delta = {
          ...withoutDeletions(cleaned),
          ...(ownItems && { items: ownItems }),
          ...(effects && { effects })
        };
      }
    );
    return actor;
  }

  /** An unsaved item or effect, as Foundry's class builds one: with its parent, and without being one of its documents. */
  function unsaved(kind: Kind, data: Source, parent: any) {
    const source = builtSource(kind, data);
    if (kind.name === "ActiveEffect") return effectDocument(() => source, parent);
    const effects = plainShelf(() => source.effects);
    return itemDocument(() => source, effects, parent, { uuid: `${parent?.uuid}.Item.${source._id}`, pack: null });
  }

  class FakeItem {
    static documentName = "Item";
    static schema = kinds.Item.schema;
    static metadata = system.Item.documentClass.metadata;
    static hierarchy = { effects: kinds.Item.schema.fields.effects };
    constructor(data: Source, context: { parent?: any } = {}) {
      // biome-ignore lint/correctness/noConstructorReturn: the fake item is a plain object.
      return unsaved(kinds.Item, data, context.parent ?? null);
    }
  }

  class FakeEffect {
    static documentName = "ActiveEffect";
    static schema = kinds.ActiveEffect.schema;
    static metadata = system.ActiveEffect.documentClass.metadata;
    static hierarchy = {};
    constructor(data: Source, context: { parent?: any } = {}) {
      // biome-ignore lint/correctness/noConstructorReturn: the fake effect is a plain object.
      return unsaved(kinds.ActiveEffect, data, context.parent ?? null);
    }
  }

  /**
   * Foundry's Actor class as the write tools use it. A create resolves to nothing, without an error, for an actor that
   * fails validation or that a preCreate hook refuses (client/data/client-backend.mjs:91-108), and so does the
   * deletion of an actor a preDelete hook refuses.
   */
  class FakeActor {
    static documentName = "Actor";
    static schema = kinds.Actor.schema;
    static metadata = system.Actor.documentClass.metadata;
    static hierarchy = { items: kinds.Actor.schema.fields.items, effects: kinds.Actor.schema.fields.effects };
    /** An unsaved actor keeps the id its data names, as any document Foundry builds does. */
    constructor(data: Source) {
      // biome-ignore lint/correctness/noConstructorReturn: the fake actor is a plain object that builtActor builds.
      return builtActor(data, data._id ?? null);
    }
    static async create(data: Source) {
      await delay();
      log.actorCreates.push(structuredClone(data));
      if (control.actorCreateError) throw new Error(control.actorCreateError);
      let actor: any;
      try {
        actor = builtActor(structuredClone(data), `actor${env.nextNumber()}`);
      } catch (error) {
        log.notifications.push(`Actor skipped: ${(error as Error).message}`);
        return undefined;
      }
      if (control.vetoActor?.(data)) {
        log.notifications.push("Actor creation prevented");
        return undefined;
      }
      control.filterActorData?.(actor._source);
      sanitizeHtml(fieldsOf(kinds.Actor, actor.type), actor._source);
      actors.set(actor.id, actor);
      return actor;
    }
    static async deleteDocuments(ids: string[]) {
      await delay();
      // client/data/client-backend.mjs:403 looks every id up with strict: true before anything is deleted.
      for (const id of ids) if (!actors.has(id)) throw new Error(`Actor ${id} does not exist`);
      log.actorDeletes.push([...ids]);
      const deleted = ids.map((id) => actors.get(id)).filter((actor) => !control.vetoActorDelete?.(actor));
      for (const actor of deleted) actors.delete(actor.id);
      return deleted;
    }
  }

  /**
   * WorldCollection#fromCompendium with clearFolder (client/documents/abstract/world-collection.mjs:109-134), as measured
   * on 14.370 for actors and for items: the stored data with its embedded documents and their ids, without the id, the
   * folder and the sort, with the ownership reset to the current user, and with the source recorded when the document
   * is in a compendium.
   */
  function fromCompendium(document: any, { clearFolder = false }: { clearFolder?: boolean } = {}) {
    const data = document.toObject();
    if (document.pack) data._stats = { ...data._stats, compendiumSource: document.uuid };
    delete data._id;
    delete data.sort;
    if (clearFolder) delete data.folder;
    data.ownership = { default: 0, [env.userId]: 3 };
    return data;
  }
  Object.assign(actors, { fromCompendium });
  Object.assign(items, { fromCompendium });

  /** An item that is no actor's: in the world, or in a compendium pack. */
  function looseItem(data: Source, pack: string | null) {
    const source = setUpItem({ name: "", type: "feat", ...data });
    const uuid = pack ? `Compendium.${pack}.Item.${source._id}` : `Item.${source._id}`;
    return itemDocument(
      () => source,
      plainShelf(() => source.effects),
      null,
      { uuid, pack }
    );
  }

  const inPack = (pack: string, document: any) => {
    env.packDocuments(pack, document.documentName).set(document.id, document);
    return document;
  };

  /** What the rest of a UUID names below an actor or an item: the document itself, an item, or an effect of either. */
  function within(document: any, rest: string[]): any {
    if (rest.length === 0 || !document) return document ?? null;
    const [name, id, ...more] = rest;
    const collection = name === "Item" ? document.items : name === "ActiveEffect" ? document.effects : undefined;
    return within(collection?.get(id!), more);
  }

  /**
   * The UUIDs of world actors and items, resolved as foundry.utils.fromUuid does for them
   * (client/utils/helpers.mjs:172): null when nothing is there, undefined for a UUID of another kind.
   */
  function resolve(parts: string[]) {
    if (parts[0] === "Actor") return within(actors.get(parts[1]!), parts.slice(2));
    if (parts[0] === "Item") return items.get(parts[1]!) ?? null;
    return undefined;
  }

  return {
    actors,
    items,
    dependentTokens,
    syntheticActor,
    resolve,
    within,
    FakeActor,
    FakeItem,
    FakeEffect,
    addActor: (data: Source = {}) => {
      const actor = makeActor(data);
      actors.set(actor.id, actor);
      return actor;
    },
    /** An actor in a compendium pack: not a world actor, with no folder path and no placed tokens. */
    addPackActor: (pack: string, data: Source = {}) => {
      const actor = makeActor(data);
      Object.assign(actor, { pack, uuid: `Compendium.${pack}.Actor.${actor.id}` });
      return inPack(pack, actor);
    },
    addItem: (data: Source = {}) => {
      const item = looseItem(data, null);
      items.set(item.id, item);
      return item;
    },
    addPackItem: (pack: string, data: Source = {}) => inPack(pack, looseItem(data, pack))
  };
}
