// SPDX-License-Identifier: AGPL-3.0-only
// The servers a turn of an agent gets in a folder, read off one Host by the
// catalog's one resolver, keyed by the folder's checkout as git answers it on
// that Host.
import { checkoutArgs, checkoutOf, turnServerFiles, turnServers, type Checkout, type McpAgent, type TurnFile, type TurnServer } from "@wsp/catalog";
import type { Host } from "../host.js";

/** The folder's checkout on that Host: its top, and the main checkout both agents key a turn's servers by. */
export const readCheckout = async (host: Pick<Host, "exec">, folder: string): Promise<Checkout> => checkoutOf(await host.exec.run("git", checkoutArgs(folder)), folder);

/** Every server a turn of the agent in `folder` gets there, by scope, read off the files that Host holds. `checkout` is
 * the folder's, read off the Host where it is not handed in; `own` reads the agent's own file alone, keyed by the folder
 * itself. The first of the own file's candidates that is there is the one, as the agent reads it, so none after it is
 * read. */
export async function readTurnServers(host: Pick<Host, "home" | "stores" | "fs" | "exec">, agent: McpAgent, folder: string, o: { checkout?: Checkout; own?: true } = {}): Promise<TurnServer[]> {
  const checkout = o.checkout ?? (o.own === true ? { key: folder } : await readCheckout(host, folder));
  const files = turnServerFiles(agent, folder, host.home, host.stores?.[agent.id], checkout.top);
  const read = async (path: string): Promise<TurnFile | undefined> => {
    const text = await host.fs.readText(path);
    return text === undefined ? undefined : { path, text };
  };
  let user: TurnFile | undefined;
  for (const path of files.user) if ((user = await read(path)) !== undefined) break;
  const projects = o.own === true ? [] : (await Promise.all(files.projects.map(read))).filter(f => f !== undefined);
  return turnServers(agent, { ...(user !== undefined ? { user } : {}), projects, folder, key: checkout.key });
}
