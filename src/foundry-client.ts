import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

// Globals used only inside the Foundry page by Puppeteer callbacks.
declare const location: { origin: string };
declare const CONST: { USER_ROLES: { GAMEMASTER: number } };
declare const game: {
  ready: boolean;
  user: { id: string; hasRole(role: number): boolean };
  modules: Map<string, { active: boolean }>;
};

interface FoundryClientOptions {
  url: string;
  user: string;
  port: number;
  token: string;
  signal: AbortSignal;
}

async function readPassword(signal: AbortSignal): Promise<string> {
  if (process.env.FOUNDRY_PASSWORD !== undefined) return process.env.FOUNDRY_PASSWORD;
  const configured = process.env.FOUNDRY_PASSWORD_FILE;
  const file = configured ?? join(homedir(), ".config", "foundry-mcp", "claude-password");
  try {
    return (await readFile(file, { encoding: "utf8", signal })).replace(/\r?\n$/, "");
  } catch (error) {
    signal.throwIfAborted();
    if (configured === undefined && error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw new Error(`Cannot read the Foundry password file at ${file}. Check FOUNDRY_PASSWORD_FILE.`);
  }
}

async function openFoundryPage(page: Page, url: URL, signal: AbortSignal) {
  const response = await page.goto(url.href, { waitUntil: "domcontentloaded", signal });
  const landed = new URL(page.url());
  if (landed.origin !== url.origin) throw new Error("Foundry redirected to another origin. Check FOUNDRY_URL.");
  if (!response?.ok() || landed.pathname !== url.pathname) {
    throw new Error(`Foundry did not open ${url.pathname}. Check FOUNDRY_URL and that the world is running.`);
  }
}

export async function launchFoundryClient({ url, user, port, token, signal }: FoundryClientOptions): Promise<{
  userId: string;
  close: () => Promise<void>;
}> {
  signal.throwIfAborted();
  const base = URL.parse(url);
  if (
    !base ||
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("FOUNDRY_URL must be an HTTP or HTTPS base URL without credentials, query, or fragment.");
  }
  if (base.hostname === "127.0.0.1") {
    throw new Error("Use localhost in FOUNDRY_URL so the Foundry session cookie stays off the bridge connection.");
  }
  const host = base.hostname.replace(/\.$/, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    (isIPv4(host) && host.startsWith("127."));
  if (!loopback && base.protocol !== "https:") throw new Error("FOUNDRY_URL must use HTTPS outside loopback.");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const joinUrl = new URL("join", base);
  const password = await readPassword(signal);
  const browser = await puppeteer
    .launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
      headless: true,
      pipe: true,
      signal,
      handleSIGINT: false,
      handleSIGTERM: false,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    })
    .catch((error) => {
      signal.throwIfAborted();
      throw new Error(`Cannot start Chromium. Check CHROME_PATH and the Chromium installation. ${error.message}`);
    });
  try {
    const page = await browser.newPage();
    await openFoundryPage(page, joinUrl, signal);
    await page.waitForSelector('select[name="userId"] option[value]:not([value=""])', { signal });
    const account = await page.$$eval(
      'select[name="userId"] option',
      (options: { textContent: string; value: string; disabled: boolean }[], name) => {
        const option = options.find((entry) => entry.textContent.trim() === name && entry.value);
        return option ? { id: option.value, active: option.disabled } : null;
      },
      user
    );
    if (!account) throw new Error(`Foundry has no user named "${user}".`);
    if (account.active) throw new Error(`Foundry user "${user}" is already logged in elsewhere.`);
    const joined = await page.evaluate(
      async ({ origin, endpoint, userId, password, port, token }) => {
        // A navigation can replace the main document after goto resolves.
        if (location.origin !== origin) throw new Error("The Foundry join page changed origin.");
        if (!globalThis.crypto?.subtle) throw new Error("Open Foundry using HTTPS or localhost for the secure bridge.");
        const response = await fetch(endpoint, {
          method: "POST",
          mode: "same-origin",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "join", userId, password })
        });
        if (!response.ok) return false;
        const reply: unknown = await response.json().catch(() => null);
        if (!reply || typeof reply !== "object" || !("status" in reply) || reply.status !== "success") return false;
        localStorage.setItem("foundry-mcp.port", JSON.stringify(port));
        localStorage.setItem("foundry-mcp.token", JSON.stringify(token));
        return true;
      },
      { origin: base.origin, endpoint: joinUrl.href, userId: account.id, password, port, token }
    );
    if (!joined) throw new Error(`Foundry refused login for "${user}". Check the account and its password.`);
    // Chrome 147 began requiring permission for WebSockets from remote sites to loopback.
    if (!loopback && Number.parseInt((await browser.version()).split("/")[1] ?? "", 10) >= 147) {
      await browser.setPermission(base.origin, { permission: { name: "loopback-network" }, state: "granted" });
    }
    await openFoundryPage(page, new URL("game", base), signal);
    await page.waitForFunction(() => typeof game !== "undefined" && game.ready === true, { timeout: 180_000, signal });
    const session = await page.evaluate(() => ({
      id: game.user.id,
      gm: game.user.hasRole(CONST.USER_ROLES.GAMEMASTER),
      active: game.modules.get("foundry-mcp")?.active === true
    }));
    if (session.id !== account.id) throw new Error(`Foundry logged in as a different user than "${user}".`);
    if (!session.gm) throw new Error(`Foundry user "${user}" needs the full Gamemaster role.`);
    if (!session.active) throw new Error("Enable the foundry-mcp module in the active Foundry world.");
    signal.throwIfAborted();
    return { userId: session.id, close: () => browser.close() };
  } catch (error) {
    await browser.close();
    signal.throwIfAborted();
    throw error;
  }
}
