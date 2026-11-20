import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const noteSections = new Map([
  ["Added", "Features"],
  ["Improved", "Improvements"],
  ["Fixed", "Fixes"],
  ["Breaking:", "Breaking changes"]
]);
const titleSections = new Map([
  ["feat", "Features"],
  ["perf", "Improvements"],
  ["fix", "Fixes"]
]);
const internalTypes = new Set(["build", "chore", "ci", "docs", "refactor", "style", "test"]);

export function changeNotes(title, body = "") {
  const lines = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const heading = lines.findLastIndex((line) => /^(?:#{1,6}\s+release notes:?|release notes:)\s*$/i.test(line));
  if (heading >= 0) {
    const notes = [];
    for (const line of lines.slice(heading + 1)) {
      if (/^#{1,6}\s/.test(line)) break;
      const text = /^\s*[-*+]\s+(.+)/.exec(line)?.[1].trim();
      if (text === "N/A") return [];
      if (!text) continue;
      const section = noteSections.get(text.split(/\s+/, 1)[0]);
      if (section && /\s/.test(text)) notes.push({ section, text });
    }
    if (notes.length) return notes;
  }

  const conventional = /^(\w+)(?:\([^)]+\))?(!)?:\s+(.+)$/.exec(title);
  if (!conventional) return [{ section: "Other changes", text: title }];
  const [, type, breaking, text] = conventional;
  const section = breaking ? "Breaking changes" : titleSections.get(type);
  if (section) return [{ section, text }];
  return internalTypes.has(type) ? [] : [{ section: "Other changes", text: title }];
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function releaseNotes(tag, repo) {
  if (!tag || !repo) throw new Error("Usage: GITHUB_REPOSITORY=owner/repo node scripts/release-notes.mjs TAG");
  const ref = `refs/tags/${tag}`;
  const parent = git("log", "-1", "--format=%P", ref, "--").split(" ")[0];
  // With --always, a history without a version tag produces a commit hash.
  const nearest =
    parent && git("describe", "--first-parent", "--tags", "--match=v[0-9]*", "--abbrev=0", "--always", parent);
  const previous = nearest.startsWith("v") ? nearest : undefined;
  const range = previous ? `refs/tags/${previous}..${ref}` : ref;
  const commits = git("log", "--first-parent", "--reverse", "--format=%H%x00%s", range, "--")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0"));
  const hashes = new Set(commits.map(([sha]) => sha));
  const seen = new Set();
  const url = `https://github.com/${repo}`;
  const sections = { "Breaking changes": [], Features: [], Improvements: [], Fixes: [], "Other changes": [] };

  for (const [sha, subject] of commits) {
    const pages = execFileSync("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--paginate", "--slurp"], {
      encoding: "utf8"
    });
    const pulls = JSON.parse(pages)
      .flat()
      .filter(
        (pr) =>
          pr.merged_at && pr.base.repo.full_name.toLowerCase() === repo.toLowerCase() && hashes.has(pr.merge_commit_sha)
      );
    if (!pulls.length) {
      for (const { section, text } of changeNotes(subject)) {
        sections[section].push(`- ${text} ([${sha.slice(0, 7)}](${url}/commit/${sha}))`);
      }
    }
    for (const pr of pulls) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      for (const { section, text } of changeNotes(pr.title, pr.body)) {
        sections[section].push(`- ${text} ([#${pr.number}](${url}/pull/${pr.number}))`);
      }
    }
  }

  const blocks = Object.entries(sections)
    .filter(([, notes]) => notes.length)
    .map(([section, notes]) => `## ${section}\n\n${notes.join("\n")}`);
  if (!blocks.length) blocks.push("No user-facing changes.");
  const target = encodeURIComponent(tag);
  const path = previous ? `compare/${encodeURIComponent(previous)}...${target}` : `commits/${target}`;
  blocks.push(`[Full changelog](${url}/${path})`);
  return blocks.join("\n\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(releaseNotes(process.argv[2], process.env.GITHUB_REPOSITORY));
}
