import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type Token = string & { readonly __brand: "Token" };

const MIN_TOKEN_LENGTH = 32;

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FOUNDRY_MCP_TOKEN_FILE) return env.FOUNDRY_MCP_TOKEN_FILE;
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "foundry-mcp", "token");
}

export function parseToken(text: string, file: string): Token {
  const token = text.trim();
  const fix = `Delete ${file} to have a new token generated. Then run "npm run -s token" in the foundry-mcp folder yourself, not through an AI agent, and paste the output into the module's Bridge token setting.`;
  if (/\s/.test(token)) throw new Error(`The bridge token in ${file} contains whitespace. ${fix}`);
  // A short token makes a captured proof open to an offline dictionary attack.
  if (token.length < MIN_TOKEN_LENGTH)
    throw new Error(`The bridge token in ${file} is shorter than ${MIN_TOKEN_LENGTH} characters. ${fix}`);
  return token as Token;
}

export async function loadToken(file: string, log: (message: string) => void = () => {}): Promise<Token> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await createIfMissing(file)) log(`created a new bridge token in ${file}`);
  const entry = await lstat(file);
  if (entry.isSymbolicLink()) {
    throw new Error(
      `The bridge token file ${file} is a symbolic link, which the server does not follow. Put a regular file there, or point FOUNDRY_MCP_TOKEN_FILE at a regular file.`
    );
  }
  const { mode, uid } = entry;
  const myUid = process.getuid?.();
  if (myUid !== undefined && uid !== myUid) {
    throw new Error(
      `The bridge token file ${file} belongs to another user (uid ${uid}). Delete it or point FOUNDRY_MCP_TOKEN_FILE at a file of your own.`
    );
  }
  if (mode & 0o077)
    log(`warning: ${file} is readable by other users (mode ${(mode & 0o777).toString(8)}). Run chmod 600 on it.`);
  const directoryMode = (await stat(directory)).mode;
  if (directoryMode & 0o022) {
    log(
      `warning: ${directory} is writable by other users (mode ${(directoryMode & 0o777).toString(8)}), so they can replace the token file. Run chmod 700 on it.`
    );
  }
  return parseToken(await readFile(file, "utf8"), file);
}

// link() fails when the file exists and no reader sees it half written, so servers that start together share one token.
async function createIfMissing(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    await rm(temporary, { force: true });
  }
}
