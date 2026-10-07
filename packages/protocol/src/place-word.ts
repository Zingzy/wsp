// SPDX-License-Identifier: AGPL-3.0-only
/** The id the computer the host runs on carries in that list. It is a place like every other, and the one nothing
 * was installed on, so both sides of the wire read the same word for it. */
export const HERE_PLACE_ID = "here";

/** Where a Solari key comes from, spelled once for the terminal's ask and the provider's key row. */
export const SOLARI_CONSOLE = "console.getsolari.com";

/** What a person calls a provider, its key and where they get one, keyed by the word WSP_PROVIDER holds. The host's
 * provider registry reads its keyName and keyConsole from here and the app's provider rows read the same, so the
 * screen that asks for a key and the terminal that asks for it say one thing. A provider that takes no key has no
 * row. */
export const PROVIDER_KEY_WORDS: Record<string, { name: string; keyName: string; keyConsole?: string }> = {
  box: { name: "Boat", keyName: "Boat API key", keyConsole: "boat.dev/dashboard" },
  solari: { name: "Solari", keyName: "Solari API key", keyConsole: SOLARI_CONSOLE },
};

/** A provider's name as its key rows say it, by its id; an id with no row reads as itself. */
export const providerKeyName = (provider: string): string => PROVIDER_KEY_WORDS[provider]?.name ?? provider;

/** Whether a word names this place: the id the wire keys it by, or the name a person types. A provider is also named
 * by the name its words row gives it, in any case, since that is the word every table prints for it. The one reading
 * every road that takes a place word makes, so a list, a frame and a typed word cannot disagree about which place. */
export const namesPlace = (place: { id: string; name: string; kind?: string }, word: string): boolean =>
  word === place.id || word === place.name || (place.kind === "provider" && [place.id, place.name, providerKeyName(place.name)].some(name => name.toLowerCase() === word.toLowerCase()));

/** A refusal's two halves, what happened and what to do, for a caller to throw as one usage refusal. */
export interface RefusalHalves {
  happened: string;
  fix: string;
}

/** Why a computer is not renamed: this computer and a cloud go by their own names, a blank name names nothing, and
 * a name another row answers to would make one word name two places. Nothing when the rename may go ahead. */
export function placeRenameRefusal(place: { id: string; name: string; kind?: string }, name: string, others: readonly { id: string; name: string; kind?: string }[]): RefusalHalves | undefined {
  if (place.id === HERE_PLACE_ID || place.kind === "provider") return { happened: `${place.name} keeps its own name`, fix: "Rename one of the computers you added instead." };
  if (name === "") return { happened: "a computer's name cannot be blank", fix: "Give it a name with a letter or a digit in it." };
  return others.some(o => o.id !== place.id && namesPlace(o, name)) ? { happened: `${name} is already the name of another computer`, fix: "Pick a name no other computer goes by." } : undefined;
}

/** Why an ssh login is not taken for a computer before anything is dialled: this computer and a cloud are reached
 * over no login of the person's, and a login is a user at a host, the shape every road that dials one reads. */
export function placeSshRefusal(place: { id: string; name: string; kind?: string }, ssh: string): RefusalHalves | undefined {
  if (place.id === HERE_PLACE_ID || place.kind === "provider") return { happened: `${place.name} is reached over no ssh login of yours`, fix: "Give a new login to one of the computers you added instead." };
  return /^[\w.-]+@[\w.:\[\]-]+$/.test(ssh) ? undefined : { happened: `${ssh} is not an ssh login like root@host`, fix: "Write it as the user and the host ssh logs in with, root@hetzner for one." };
}

/** What a new ssh login is refused with once it was dialled: the computer that answered is not this one, or it
 * could not be read as any computer, and nothing of the record moved either way. */
export const placeSshOtherRefusal = (ssh: string, name: string): RefusalHalves => ({ happened: `${ssh} reaches a computer that is not ${name}, so nothing was saved`, fix: `Give the login that reaches ${name} itself.` });
export const placeSshUncheckedRefusal = (ssh: string, name: string, why: string): RefusalHalves => ({
  happened: `${ssh} could not be checked as ${name}, so nothing was saved: ${why}`,
  fix: `Check that ssh ${ssh} logs in as root, or through a sudo that asks no password, and try again.`,
});
