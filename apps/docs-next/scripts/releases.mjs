// SPDX-License-Identifier: AGPL-3.0-only
// The one step of generate that reads the network: the published releases off GitHub, drafts and prereleases left
// out, into releases.json, which scripts/changelog.ts writes the changelog from. Run before the other scripts; with no
// network or no gh sign-in it keeps the committed file, so the rest of generate still runs.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let pages;
try {
  pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", "repos/wsp-labs/wsp/releases"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
} catch (error) {
  const why = String(error.stderr ?? error.message).trim().split("\n")[0];
  console.error(`releases.json: kept as committed, since gh could not read the releases (${why}); the changelog is written from it`);
  process.exit(0);
}
const releases = pages
  .flat()
  .filter(r => !r.draft && !r.prerelease)
  .map(r => ({ tag: r.tag_name, date: r.published_at.slice(0, 10), body: r.body ?? "" }));
writeFileSync(new URL("./releases.json", import.meta.url), `${JSON.stringify(releases, null, 2)}\n`);
console.log(`releases.json: ${releases.length} releases, ${releases.map(r => r.tag).join(" ")}`);
