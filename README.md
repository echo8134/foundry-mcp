# foundry-mcp

A local MCP server and a Foundry VTT module.

## Connect to a world

Enable the `foundry-mcp` module in the world. The server uses the first authenticated Gamemaster browser to connect. If you already paired a browser with the bridge token, you can keep using it.

To use MCP with your Foundry tab closed, install Chromium on the machine that runs the MCP server. Create a dedicated Foundry user with the Gamemaster role. Set the following environment variables in your MCP server configuration as needed.

| Variable                 | Default                                 | Purpose                                                                                                                                |
| ------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `FOUNDRY_URL`            | `http://localhost:30000`                | URL of the running Foundry world, including its route prefix if configured. Use localhost for a local world or HTTPS for a remote one. |
| `FOUNDRY_USER`           | `Claude`                                | Foundry account for the headless browser.                                                                                              |
| `FOUNDRY_PASSWORD_FILE`  | `~/.config/foundry-mcp/claude-password` | Plain-text password file readable by the server user. `FOUNDRY_PASSWORD` takes precedence when set.                                    |
| `CHROME_PATH`            | `/usr/bin/chromium`                     | Path to the Chromium executable.                                                                                                       |
| `FOUNDRY_MCP_AUTOCLIENT` | `1`                                     | Set to `0` to require a manually connected GM browser.                                                                                 |

If you set `FOUNDRY_MCP_ORIGINS` explicitly, include the origin of `FOUNDRY_URL`. On the first tool call without a connected bridge, the server waits briefly for a GM browser, then opens its own. Concurrent calls share that browser. You can keep playing from another browser or device under your own account. Pass `sceneId` when you want the scene you are viewing. Without it, the tools use the connected browser's viewed scene or the world's active scene. The server closes its headless browser when it exits.

## Features

An MCP client such as Claude Code can:

- list the scenes and scene folders of a world
- read a scene with its levels, walls, ambient lights, tokens and regions
- render a scene or one of its levels as an image, with walls, lights, tokens and regions drawn over the map
- list the actors and actor folders of a world, and read an actor with its items, effects and placed tokens (dnd5e)
- read the stored field names and legal keys of the installed dnd5e
- place tokens of world actors, change, move and delete tokens, and read a token's full stored data (dnd5e)
- create an actor of any type, copy one from a compendium, bring an actor or a token's own actor to given data, and delete actors (dnd5e)
- give an actor or a single token features, spells, weapons, a class, a species and a background as items, each with its activities (attack, damage, save, cast and the rest) and active effects, copy items from a compendium, and change or remove them (dnd5e)
- create a scene, or bring an existing one to given settings
- draw walls and doors from paths, and delete walls
- sync walls and ambient lights to an exact set, without touching those placed by hand
- sync the regions of a level to an exact list, with the stairs between levels as changeLevel and teleportToken behaviors, without touching regions and behaviors made by hand
- list and read documents of every Foundry type in the world, inside another document or in a compendium pack: journal entries and their pages, items, roll tables, macros, playlists, cards, chat messages, combats, folders, users, settings and the rest
- create, change and delete documents of every type but settings, a journal entry with its pages in one call, in the world or in an unlocked compendium pack, with the same checks before anything is written
- read the stored field names of every document type

## Releases

[release-please](https://github.com/googleapis/release-please) keeps a release PR open against `main`. It raises the version in `package.json`, `package-lock.json` and `module/module.json` and adds the changes to `CHANGELOG.md`. When you merge it, the workflow tags the version, publishes the [GitHub release](https://github.com/echo8134/foundry-mcp/releases) and attaches `module.json` and `module.zip`.

Pull requests are squash merged, so each PR title becomes one commit on `main` and one changelog entry. Titles follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:` lands under features, `fix:` under bug fixes, `feat!:` or `fix!:` marks a breaking change. `docs:`, `test:`, `refactor:`, `ci:` and `chore:` do not appear in the changelog.

To write a different entry than the title, or several, put them in the PR description:

```text
BEGIN_COMMIT_OVERRIDE
feat: add hex grid support to ensure_scene
fix: keep refused region destinations pending
END_COMMIT_OVERRIDE
```

To check that a downloaded module was built by this repository's workflow:

```sh
gh attestation verify module.zip -R echo8134/foundry-mcp
```

## License

MIT, see `LICENSE`.
