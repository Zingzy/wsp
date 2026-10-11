// SPDX-License-Identifier: AGPL-3.0-only
// The servers one scope of an agent's JSON config carries in the copy that
// travelled off this computer. The pack moves every path of this computer's
// home in that copy, its folder keys too, so a copy that came through it holds
// a folder's entry where it lands, as the image's edit also reads it; a copy
// handed in whole holds it where it was.
import { jsonObject, readJsonc } from "./jsonc.js";

/** The servers under `key` in the copy that travelled, at its top or, for a scope that names a folder, in that
 * folder's entry. Throws when the copy is not a JSON object. */
export function travelledServers(travelled: string, key: string, project: { from: string; to: string } | undefined): Record<string, unknown> {
  const copy = jsonObject(readJsonc(travelled).value);
  if (copy === undefined) throw new Error("the copy that travelled is not a JSON object");
  const folders = jsonObject(copy.projects);
  const source = project === undefined ? copy : jsonObject(folders?.[project.from]) ?? jsonObject(folders?.[project.to]) ?? {};
  return jsonObject(source[key]) ?? {};
}
