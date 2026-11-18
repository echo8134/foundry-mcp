// @ts-check

/**
 * The names of Foundry's document types, as CONST.ALL_DOCUMENT_TYPES lists them (common/constants.mjs:403-406). The
 * server reads them here because it has no Foundry to ask. The module checks a name again against the classes the
 * running Foundry has.
 */
export const DOCUMENT_TYPES = Object.freeze(
  /** @type {const} */ ([
    "ActiveEffect",
    "Actor",
    "ActorDelta",
    "Adventure",
    "AmbientLight",
    "AmbientSound",
    "Card",
    "Cards",
    "ChatMessage",
    "Combat",
    "Combatant",
    "CombatantGroup",
    "Drawing",
    "FogExploration",
    "Folder",
    "Item",
    "JournalEntry",
    "JournalEntryCategory",
    "JournalEntryPage",
    "Level",
    "Macro",
    "Note",
    "Playlist",
    "PlaylistSound",
    "Region",
    "RegionBehavior",
    "RollTable",
    "Scene",
    "Setting",
    "TableResult",
    "Tile",
    "Token",
    "User",
    "Wall"
  ])
);

/** What get_schema describes besides documents: dnd5e's activities and advancements, and its key tables. */
export const SCHEMA_EXTRAS = Object.freeze(/** @type {const} */ (["Activity", "Advancement", "Config"]));
