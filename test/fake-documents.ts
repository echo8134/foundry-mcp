// Stand-ins for the documents the generic document tools read and write: document classes built from a field list,
// the world collections and the compendium packs that hold them. Written from the Foundry 14.370 source, each behavior
// with its place there. None of it was measured in a live world, which the e2e checks do.

import { Collection } from "./fake-actors.ts";
import { applyChanges, cleanValue, cloneChanges, isObject, sanitizeHtml, validationErrors } from "./fake-model.ts";
import {
  ArrayField,
  BooleanField,
  ColorField,
  type DataField,
  DocumentFlagsField,
  DocumentIdField,
  DocumentOwnershipField,
  DocumentTypeField,
  EmbeddedCollectionField,
  FilePathField,
  ForeignDocumentField,
  HTMLField,
  JSONField,
  NumberField,
  ObjectField,
  SchemaField,
  StringField,
  TypeDataField
} from "./fake-system.ts";

type Source = Record<string, any>;

type Definition = {
  name: string;
  /** The stored fields of the document, without its embedded collections. */
  fields: Record<string, DataField>;
  /** The embedded documents, by their document name, with the field that stores them (metadata.embedded). */
  embedded?: Record<string, string>;
  /** The subtypes of the document, as game.documentTypes lists them. */
  types?: string[];
  baseTypeAllowed?: boolean;
  /** The data models of the subtypes that have one (CONFIG[name].dataModels). */
  models?: Record<string, { schema: SchemaField }>;
  /** The fields a pack's index holds of each document (metadata.compendiumIndexFields). */
  indexFields?: string[];
  /** What the server makes of the data it stores, beyond what cleaning does. */
  onServer?: (source: Source) => void;
};

/** One create, update or deletion of documents, as the fake saw it. */
export type DocumentWrite = {
  action: "create" | "update" | "delete";
  document: string;
  parent: string | null;
  pack: string | null;
  data: any[];
};

type Env = {
  folders: Collection<any>;
  log: {
    notifications: string[];
    documentWrites: DocumentWrite[];
    /** Every index a pack was asked for, with the fields named. */
    packIndexes: { pack: string; fields: string[] }[];
    /** Every document a pack loaded. */
    packLoads: string[];
  };
  control: Record<string, any>;
  delay: () => Promise<void>;
  nextNumber: () => number;
};

const folder = () => new ForeignDocumentField({ documentName: "Folder" }, { nullable: true, initial: null });
const sort = () => new NumberField({ integer: true, initial: 0 });
const ownership = () => new DocumentOwnershipField({ initial: () => ({ default: 0 }) });
const named = () => new StringField({ required: true, blank: false });
const id = () => new DocumentIdField({ nullable: true, initial: null });

/**
 * The fields of Foundry's own documents that the tests use, with their kinds and initial values
 * (common/documents/journal-entry.mjs, journal-entry-page.mjs:44-75, journal-entry-category.mjs, playlist.mjs,
 * playlist-sound.mjs, chat-message.mjs:40-66, user.mjs:48-68, setting.mjs:42-52, macro.mjs, folder.mjs).
 */
const DEFINITIONS: Definition[] = [
  {
    name: "JournalEntry",
    fields: {
      _id: id(),
      name: named(),
      folder: folder(),
      sort: sort(),
      ownership: ownership(),
      flags: new DocumentFlagsField()
    },
    embedded: { JournalEntryCategory: "categories", JournalEntryPage: "pages" },
    indexFields: ["_id", "name", "sort", "folder"]
  },
  {
    name: "JournalEntryPage",
    fields: {
      _id: id(),
      name: named(),
      type: new DocumentTypeField({ initial: "text" }),
      system: new TypeDataField({ documentName: "JournalEntryPage" }),
      title: new SchemaField({
        show: new BooleanField({ initial: true }),
        level: new NumberField({ integer: true, min: 1, max: 6, initial: 1 })
      }),
      text: new SchemaField({
        content: new HTMLField({ required: false }),
        format: new NumberField({ integer: true, choices: [1, 2], initial: 1 })
      }),
      src: new StringField({ nullable: true, initial: null }),
      sort: sort(),
      flags: new DocumentFlagsField()
    },
    types: ["text", "image", "rule"],
    // Stands in for a page type of the system that has a data model, as dnd5e's rule pages have.
    models: { rule: { schema: new SchemaField({ tooltip: new HTMLField({ initial: "" }) }) } }
  },
  {
    name: "JournalEntryCategory",
    fields: { _id: id(), name: new StringField({ initial: "" }), sort: sort(), flags: new DocumentFlagsField() }
  },
  {
    name: "Playlist",
    fields: {
      _id: id(),
      name: named(),
      description: new StringField({ initial: "" }),
      playing: new BooleanField({ initial: false }),
      folder: folder(),
      sort: sort(),
      ownership: ownership(),
      flags: new DocumentFlagsField()
    },
    embedded: { PlaylistSound: "sounds" },
    indexFields: ["_id", "name", "description", "sort", "folder"]
  },
  {
    name: "PlaylistSound",
    fields: {
      _id: id(),
      name: named(),
      path: new FilePathField({ nullable: true, initial: null }),
      repeat: new BooleanField({ initial: false }),
      volume: new NumberField({ min: 0, max: 1, step: 0.01, initial: 0.5 }),
      sort: sort(),
      flags: new DocumentFlagsField()
    }
  },
  {
    name: "ChatMessage",
    fields: {
      _id: id(),
      type: new DocumentTypeField({ initial: "base" }),
      system: new TypeDataField({ documentName: "ChatMessage" }),
      author: new ForeignDocumentField({ documentName: "User" }, { nullable: true, initial: null }),
      timestamp: new NumberField({ nullable: true, initial: null }),
      content: new HTMLField({ initial: "" }),
      speaker: new SchemaField({ alias: new StringField({ initial: "" }) }),
      whisper: new ArrayField(new StringField()),
      flags: new DocumentFlagsField()
    },
    types: ["base"],
    baseTypeAllowed: true
  },
  {
    name: "User",
    fields: {
      _id: id(),
      name: named(),
      // CONST.USER_ROLES (common/constants.mjs:1237-1270).
      role: new NumberField({ integer: true, choices: [0, 1, 2, 3, 4], initial: 1 }),
      password: new StringField({ initial: "" }),
      passwordSalt: new StringField({ initial: "" }),
      color: new ColorField({ initial: "#cc2828" }),
      flags: new DocumentFlagsField()
    },
    // The server stores a hash and a salt of its own, and a client is handed neither
    // (dist/database/documents/user.mjs: _preCreate, _preUpdate, and fromSource with safe).
    onServer: (source) => {
      source.password = "";
      source.passwordSalt = "";
    }
  },
  { name: "Setting", fields: { _id: id(), key: named(), value: new JSONField({ nullable: true, initial: null }) } },
  {
    name: "Macro",
    fields: {
      _id: id(),
      name: named(),
      type: new DocumentTypeField({ initial: "chat" }),
      img: new FilePathField({ nullable: true, initial: "icons/svg/dice-target.svg" }),
      command: new StringField({ initial: "" }),
      folder: folder(),
      sort: sort(),
      ownership: ownership(),
      flags: new DocumentFlagsField()
    },
    types: ["chat", "script"],
    indexFields: ["_id", "name", "img", "sort", "folder"]
  },
  {
    name: "Folder",
    fields: {
      _id: id(),
      name: named(),
      type: new DocumentTypeField(),
      folder: folder(),
      sort: sort(),
      color: new ColorField({ nullable: true, initial: null }),
      flags: new DocumentFlagsField()
    },
    // CONST.FOLDER_DOCUMENT_TYPES, the core types of a folder (common/documents/folder.mjs:29).
    types: [
      "Actor",
      "Adventure",
      "Item",
      "Scene",
      "JournalEntry",
      "Playlist",
      "RollTable",
      "Cards",
      "Macro",
      "Compendium"
    ]
  },
  // Exists only in a compendium pack (common/constants.mjs:411-442).
  {
    name: "Adventure",
    fields: { _id: id(), name: named(), folder: folder(), flags: new DocumentFlagsField() },
    indexFields: ["_id", "name", "folder"]
  },
  // A token's own changes to its actor, one embedded document of the token (common/documents/actor-delta.mjs:43-56).
  {
    name: "ActorDelta",
    fields: { _id: id(), name: new StringField({ nullable: true, initial: null }), flags: new DocumentFlagsField() }
  }
];

/** The value at a dot path, as a nested object that holds only that path. */
function pickPath(source: Source, path: string): Source {
  const [key, ...rest] = path.split(".");
  const value = source[key!];
  if (value === undefined) return {};
  if (rest.length === 0) return { [key!]: structuredClone(value) };
  return isObject(value) ? { [key!]: pickPath(value, rest.join(".")) } : {};
}

function mergeInto(target: Source, picked: Source) {
  for (const [key, value] of Object.entries(picked)) {
    if (isObject(value) && isObject(target[key])) mergeInto(target[key], value);
    else target[key] = value;
  }
  return target;
}

export function fakeDocuments(env: Env) {
  const { log, control } = env;
  const definitions = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));
  const classes: Record<string, any> = {};
  /** The documents of the world, by document name. Only a type a world can hold has a collection. */
  const worlds = new Map<string, Collection<any>>();
  const packs = new Collection<any>();

  const newId = (name: string) => `${name.slice(0, 6).toLowerCase()}${String(env.nextNumber()).padStart(10, "0")}`;

  /** The fields of a document of a type: its own, with `system` as the data model of the type has it. */
  function fieldsFor(definition: Definition, type: string | undefined) {
    const { fields, models = {} } = definition;
    if (!fields.system) return new SchemaField(fields);
    return new SchemaField({ ...fields, system: models[type ?? ""]?.schema ?? new ObjectField() });
  }

  /**
   * The stored data Foundry's class builds from given data, cleaned in place, or the error its model throws. The
   * document type is the given one or the initial value of the type field, and must be a type of the class
   * (common/data/fields.mjs:4285-4310). Each embedded document is built by its own class, gets an id where it has none
   * (:3111-3115), and fails the whole document when its data is refused (common/abstract/data.mjs:74-80).
   */
  function builtSource(definition: Definition, data: Source): Source {
    const { name, embedded = {}, types } = definition;
    if (!isObject(data)) throw new Error(`${name} validation errors: must be an object`);
    const given = Object.fromEntries(Object.values(embedded).map((field) => [field, data[field] ?? []]));
    for (const field of Object.values(embedded)) delete data[field];
    const type = types ? (data.type ?? definition.fields.type?.initial) : undefined;
    if (types && !types.includes(type)) {
      throw new Error(`${name} validation errors: type: "${type}" is not a valid type for the ${name} Document class`);
    }
    const fields = fieldsFor(definition, type);
    cleanValue(fields, data, { partial: false });
    const errors = validationErrors(fields, data);
    if (errors.length > 0) throw new Error(`${name} validation errors: ${errors.join("; ")}`);
    for (const [child, field] of Object.entries(embedded)) {
      if (!Array.isArray(given[field])) throw new Error(`${name} validation errors: ${field}: must be an Array`);
      data[field] = given[field].map((element: Source, index: number) => {
        try {
          const source = builtSource(definitions.get(child)!, element);
          source._id ||= newId(child);
          return source;
        } catch (error) {
          throw new Error(`${name} validation errors: ${field}: ${index}: ${(error as Error).message}`);
        }
      });
    }
    return data;
  }

  /** What the server makes of data it stores: HTML in its own spelling, at every level, and what the class adds. */
  function storedOnServer(definition: Definition, source: Source) {
    sanitizeHtml(fieldsFor(definition, source.type), source);
    definition.onServer?.(source);
    for (const [child, field] of Object.entries(definition.embedded ?? {})) {
      for (const element of source[field]) storedOnServer(definitions.get(child)!, element);
    }
  }

  /** Foundry writes nothing into a locked pack, and throws (common/abstract/backend.mjs:260-283). */
  function assertUnlocked(packId: string | null, action: string) {
    if (packId && packs.get(packId)?.locked) {
      throw new Error(`You may not ${action} documents in the locked compendium "${packId}".`);
    }
  }

  function define(definition: Definition) {
    const { name, fields, embedded = {} } = definition;
    const schema = new SchemaField({
      ...fields,
      ...Object.fromEntries(
        Object.entries(embedded).map(([child, field]) => [field, new EmbeddedCollectionField({ documentName: child })])
      )
    });

    class FakeDocument {
      [key: string]: any;
      static documentName = name;
      static metadata = {
        name,
        embedded,
        hasTypeData: Boolean(fields.system),
        baseTypeAllowed: definition.baseTypeAllowed ?? false,
        compendiumIndexFields: definition.indexFields ?? []
      };
      static schema = schema;
      /** Document.hierarchy: the fields that hold embedded documents (common/abstract/document.mjs:259-266). */
      static hierarchy = Object.fromEntries(Object.values(embedded).map((field) => [field, schema.fields[field]]));
      readonly documentName = name;
      readonly _source: Source;
      readonly parent: any;
      readonly pack: string | null;
      readonly #children = new Map<string, Map<string, any>>();

      /** As Foundry's class: the object it is given becomes its stored data, cleaned in place unless told not to. */
      constructor(data: Source, context: { parent?: any; pack?: string | null; clean?: boolean } = {}) {
        this.parent = context.parent ?? null;
        this.pack = this.parent?.pack ?? context.pack ?? null;
        this._source = context.clean === false ? data : builtSource(definition, data);
      }

      get id() {
        return this._source._id ?? null;
      }

      /** buildUuid (common/utils/helpers.mjs:1542-1566). */
      get uuid() {
        if (this.parent) return `${this.parent.uuid}.${name}.${this.id}`;
        return this.pack ? `Compendium.${this.pack}.${name}.${this.id}` : `${name}.${this.id}`;
      }

      get folder() {
        const folders = this.pack ? packs.get(this.pack).folders : env.folders;
        return this._source.folder ? (folders.get(this._source.folder) ?? null) : null;
      }

      toObject() {
        return structuredClone(this._source);
      }

      /** The embedded documents of one field. A document stays the same object while its record is there. */
      #collection(child: string, field: string) {
        if (!this.#children.has(field)) this.#children.set(field, new Map());
        const made = this.#children.get(field)!;
        return new Collection<any>(
          this._source[field].map((record: Source) => {
            if (made.get(record._id)?._source !== record) {
              made.set(record._id, new classes[child](record, { parent: this, clean: false }));
            }
            return [record._id, made.get(record._id)];
          })
        );
      }

      getEmbeddedCollection(child: string) {
        const field = embedded[child];
        if (!field) throw new Error(`${child} is not a valid embedded Document within the ${name} Document`);
        return this.#collection(child, field);
      }

      /**
       * validate with changes is a dry run of an update (common/abstract/data.mjs:575-597): it cleans the changes, the
       * given object itself when clean.copy is false, and throws what the update would refuse unless it is not strict.
       */
      validate({ changes, clean, strict = true }: { changes: Source; clean?: { copy?: boolean }; strict?: boolean }) {
        const fieldsOfType = fieldsFor(definition, this._source.type);
        const cleaned = cleanValue(fieldsOfType, clean?.copy === false ? changes : cloneChanges(changes), {
          partial: true,
          source: this._source
        }) as Source;
        const errors = validationErrors(fieldsOfType, applyChanges(structuredClone(this._source), cleaned));
        if (errors.length > 0 && strict) throw new Error(`${name} validation errors: ${errors.join("; ")}`);
        return errors.length === 0;
      }

      /**
       * An update is cleaned, passes the stand-in hooks, and is skipped without an error when a hook refuses it or its
       * result fails validation (client/data/client-backend.mjs:237-259). The server then stores HTML in its own spelling.
       */
      async update(changes: Source) {
        await env.delay();
        assertUnlocked(this.pack, "update");
        log.documentWrites.push({
          action: "update",
          document: name,
          parent: this.parent?.uuid ?? null,
          pack: this.pack,
          data: [cloneChanges(changes)]
        });
        const fieldsOfType = fieldsFor(definition, this._source.type);
        const cleaned = cleanValue(fieldsOfType, cloneChanges(changes), {
          partial: true,
          source: this._source
        }) as Source;
        if (control.vetoDocumentUpdate?.(name, cleaned)) return undefined;
        control.filterDocumentChanges?.(name, cleaned);
        const errors = validationErrors(fieldsOfType, applyChanges(structuredClone(this._source), cleaned));
        if (errors.length > 0) {
          log.notifications.push(`${name} update skipped: ${errors.join("; ")}`);
          return undefined;
        }
        sanitizeHtml(fieldsOfType, cleaned);
        applyChanges(this._source, cleaned);
        definition.onServer?.(this._source);
        const failure = control.documentError?.("update", name);
        if (failure) throw new Error(failure);
        return this;
      }

      /**
       * Document.create with one document (common/abstract/document.mjs:732-737). It resolves to nothing, without an
       * error, for data the model refuses and for a creation a hook refuses (client/data/client-backend.mjs:91-108). The
       * server gives the document its id, and keeps the ids of the embedded documents created with it.
       */
      static async create(data: Source, { parent = null, pack = null }: { parent?: any; pack?: string | null } = {}) {
        await env.delay();
        const inPack: string | null = parent?.pack ?? pack;
        assertUnlocked(inPack, "create");
        log.documentWrites.push({
          action: "create",
          document: name,
          parent: parent?.uuid ?? null,
          pack: inPack,
          data: [structuredClone(data)]
        });
        const failure = control.documentError?.("create", name, data);
        if (failure) throw new Error(failure);
        let source: Source;
        try {
          source = builtSource(definition, structuredClone(data));
        } catch (error) {
          log.notifications.push(`${name} skipped: ${(error as Error).message}`);
          return undefined;
        }
        if (control.vetoDocument?.(name, data)) {
          log.notifications.push(`${name} creation prevented`);
          return undefined;
        }
        source._id = newId(name);
        control.filterDocumentData?.(name, source);
        storedOnServer(definition, source);
        return store(name, source, parent, inPack);
      }

      /**
       * Every id is looked up before anything is deleted, so one that is not there throws and deletes nothing, and a
       * document whose deletion a hook refuses is skipped (client/data/client-backend.mjs:393-410).
       */
      static async deleteDocuments(
        ids: string[],
        { parent = null, pack = null }: { parent?: any; pack?: string | null } = {}
      ) {
        await env.delay();
        const inPack: string | null = parent?.pack ?? pack;
        assertUnlocked(inPack, "delete");
        const collection = container(name, parent, inPack);
        for (const one of ids) if (!collection.has(one)) throw new Error(`${name} ${one} does not exist`);
        log.documentWrites.push({
          action: "delete",
          document: name,
          parent: parent?.uuid ?? null,
          pack: inPack,
          data: [...ids]
        });
        const failure = control.documentError?.("delete", name);
        if (failure) throw new Error(failure);
        const deleted = ids
          .map((one) => collection.get(one))
          .filter((document) => !control.vetoDocumentDelete?.(document));
        for (const document of deleted) {
          if (parent) {
            const records: Source[] = parent._source[parent.constructor.metadata.embedded[name]];
            records.splice(records.indexOf(document._source), 1);
          } else collection.delete(document.id);
        }
        return deleted;
      }
    }

    for (const [child, field] of Object.entries(embedded)) {
      Object.defineProperty(FakeDocument.prototype, field, {
        get(this: FakeDocument) {
          return this.getEmbeddedCollection(child);
        }
      });
    }
    for (const key of Object.keys(fields)) {
      if (key in FakeDocument.prototype) continue;
      Object.defineProperty(FakeDocument.prototype, key, {
        get(this: FakeDocument) {
          return this._source[key];
        }
      });
    }
    return FakeDocument;
  }

  /** Where the documents of a name are kept: in a parent, in a pack, or in the world. */
  function container(name: string, parent: any, pack: string | null): Collection<any> {
    if (parent) return parent.getEmbeddedCollection(name);
    const collection = pack ? packs.get(pack)?.documents : worlds.get(name);
    if (!collection)
      throw new Error(`The fake has no place for ${name} documents${pack ? ` in the pack ${pack}` : ""}.`);
    return collection;
  }

  function store(name: string, source: Source, parent: any, pack: string | null) {
    if (parent) {
      parent._source[parent.constructor.metadata.embedded[name]].push(source);
      return parent.getEmbeddedCollection(name).get(source._id);
    }
    const document = new classes[name](source, { pack, clean: false });
    container(name, null, pack).set(document.id, document);
    return document;
  }

  for (const definition of DEFINITIONS) classes[definition.name] = define(definition);
  // The primary types a world can hold (common/constants.mjs:411-426). A Folder lies in the world's folders.
  for (const name of ["JournalEntry", "Playlist", "ChatMessage", "User", "Setting", "Macro"]) {
    worlds.set(name, new Collection<any>());
  }
  worlds.set("Folder", env.folders);

  /**
   * A compendium pack. One of the world is unlocked and one of a system or module locked, until the Gamemaster says
   * otherwise (client/documents/collections/compendium-collection.mjs:227-229). Its index holds a plain object for
   * each document, with the index fields of the class and the fields asked for, a dot path as nested objects, and
   * loads no document (:337-367, :659-680).
   */
  function addPack(packId: string, type: string, options: { title?: string; locked?: boolean } = {}) {
    const documents = new Collection<any>();
    const index = new Collection<any>();
    const packageType = packId.startsWith("world.") ? "world" : "system";
    const pack = {
      collection: packId,
      documentName: type,
      title: options.title ?? packId,
      metadata: { id: packId, type, packageType },
      config: { ...(options.locked !== undefined && { locked: options.locked }) } as { locked?: boolean },
      documents,
      folders: new Collection<any>(),
      index,
      get locked() {
        return pack.config.locked ?? packageType !== "world";
      },
      getUuid: (documentId: string) => `Compendium.${packId}.${type}.${documentId}`,
      async getIndex({ fields = [] }: { fields?: string[] } = {}) {
        await env.delay();
        log.packIndexes.push({ pack: packId, fields: [...fields] });
        const wanted = [...new Set([...(classes[type]?.metadata.compendiumIndexFields ?? ["_id", "name"]), ...fields])];
        index.clear();
        for (const document of documents.values()) {
          const entry = wanted.reduce(
            (picked, path) => mergeInto(picked, pickPath(document._source, path)),
            {} as Source
          );
          index.set(document.id, { ...entry, _id: document.id, uuid: pack.getUuid(document.id) });
        }
        return index;
      },
      async getDocument(documentId: string) {
        await env.delay();
        log.packLoads.push(`${packId}.${documentId}`);
        return documents.get(documentId);
      }
    };
    packs.set(packId, pack);
    return pack;
  }

  /** The pack of an id, made on first use: a document of a test's setup names the pack it lies in. */
  const packOf = (packId: string, type: string) => packs.get(packId) ?? addPack(packId, type);

  /**
   * A document of a test's setup, built as Foundry's class builds one and stored as the server would have stored it.
   * `_id` names its id.
   */
  function addDocument(name: string, data: Source = {}, where: { parent?: any; pack?: string } = {}) {
    const source = builtSource(definitions.get(name)!, structuredClone(data));
    source._id ||= newId(name);
    if (where.pack) packOf(where.pack, name);
    return store(name, source, where.parent ?? null, where.pack ?? null);
  }

  /** A folder of a compendium pack, which keeps its folders apart from the world's (compendium-collection.mjs:146-152). */
  function addPackFolder(packId: string, type: string, name: string, parent: any = null) {
    const source = builtSource(definitions.get("Folder")!, {
      _id: newId("Folder"),
      name,
      type,
      folder: parent?.id ?? null
    });
    const made = new classes.Folder(source, { pack: packId, clean: false });
    packOf(packId, type).folders.set(made.id, made);
    return made;
  }

  /** A world folder as a Folder document. */
  function makeFolder(data: Source) {
    const source = builtSource(definitions.get("Folder")!, { _id: newId("Folder"), ...data });
    const made = new classes.Folder(source, { clean: false });
    env.folders.set(made.id, made);
    return made;
  }

  /** What the rest of a UUID names below a document: an embedded document, by document name and id, at any depth. */
  function within(document: any, rest: string[]): any {
    if (rest.length === 0 || !document) return document ?? null;
    const [name, embeddedId, ...more] = rest;
    return within(document.getEmbeddedCollection(name!).get(embeddedId!), more);
  }

  /**
   * A UUID resolved as foundry.utils.fromUuid resolves it (client/utils/helpers.mjs:172-183): a compendium document is
   * loaded from its pack, and a folder of a pack comes from the pack's folders. Undefined for a UUID of another kind.
   */
  async function resolve(parts: string[]) {
    if (parts[0] === "Compendium") {
      const [, scope, packName, type, documentId, ...rest] = parts;
      const pack = packs.get(`${scope}.${packName}`);
      if (!pack) return null;
      if (type === "Folder") return pack.folders.get(documentId!) ?? null;
      if (type !== pack.documentName) return null;
      return within(await pack.getDocument(documentId!), rest);
    }
    const collection = worlds.get(parts[0]!);
    return collection ? within(collection.get(parts[1]!), parts.slice(2)) : undefined;
  }

  return {
    classes,
    worlds,
    packs,
    dataModels: Object.fromEntries(DEFINITIONS.map((definition) => [definition.name, definition.models ?? {}])),
    documentTypes: Object.fromEntries(DEFINITIONS.flatMap(({ name, types }) => (types ? [[name, types]] : []))),
    addPack,
    packOf,
    addDocument,
    addPackFolder,
    makeFolder,
    resolve
  };
}
