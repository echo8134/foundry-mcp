import { loadToken, tokenPath } from "./token.ts";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === "EPIPE"
      ? "foundry-mcp | nothing took the token: the program it was piped into ended first. If that was a clipboard tool, run the command in a terminal of your desktop session."
      : `foundry-mcp | could not write the token: ${error.message}`
  );
  process.exitCode = 1;
});

try {
  const token = await loadToken(tokenPath(), (message) => console.error(`foundry-mcp | ${message}`));
  process.stdout.write(`${token}\n`);
} catch (error) {
  console.error(`foundry-mcp | ${(error as Error).message}`);
  process.exitCode = 1;
}
