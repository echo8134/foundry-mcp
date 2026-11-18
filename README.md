# foundry-mcp

A local MCP server and a Foundry VTT module.

## Features

An MCP client such as Claude Code can:

- list the scenes and scene folders of a world
- read a scene with its walls, ambient lights and tokens
- render a scene as an image, with walls, lights and tokens drawn over the map
- list the actors and actor folders of a world, and read an actor with its items, effects and placed tokens (dnd5e)
- read the stored field names and legal keys of the installed dnd5e
- place tokens of world actors, change, move and delete tokens, and read a token's full stored data (dnd5e)
- create an actor of any type, copy one from a compendium, bring an actor or a token's own actor to given data, and delete actors (dnd5e)
- give an actor or a single token features, spells, weapons, a class, a species and a background as items, each with its activities (attack, damage, save, cast and the rest) and active effects, copy items from a compendium, and change or remove them (dnd5e)
- create a scene, or bring an existing one to given settings
- draw walls and doors from paths, and delete walls
- sync walls and ambient lights to an exact set, without touching those placed by hand
- list and read documents of every Foundry type in the world, inside another document or in a compendium pack: journal entries and their pages, items, roll tables, macros, playlists, cards, chat messages, combats, folders, users, settings and the rest
- create, change and delete documents of every type but settings, a journal entry with its pages in one call, in the world or in an unlocked compendium pack, with the same checks before anything is written
- read the stored field names of every document type

## License

MIT, see `LICENSE`.
