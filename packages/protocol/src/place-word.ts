// SPDX-License-Identifier: AGPL-3.0-only
/** The id the computer the host runs on carries in that list. It is a place like every other, and the one nothing
 * was installed on, so both sides of the wire read the same word for it. */
export const HERE_PLACE_ID = "here";

/** False in a public build, which the bundler fills in where PUBLIC_BUILD=1; never filled in anywhere else. */
declare const __WSP_CLOUD__: boolean | undefined;

/** Where a Solari key comes from, spelled once for the terminal's ask and the provider's key row. */
export const SOLARI_CONSOLE = "console.getsolari.com";

/** What a person calls a provider, its key and where they get one, keyed by the word WSP_PROVIDER holds. The host's
 * provider registry reads its keyName and keyConsole from here and the app's provider rows read the same, so the
 * screen that asks for a key and the terminal that asks for it say one thing. A provider that takes no key has no
 * row. */
export const PROVIDER_KEY_WORDS: Record<string, { name: string; keyName: string; keyConsole?: string }> =
  typeof __WSP_CLOUD__ === "boolean" && !__WSP_CLOUD__ ? {} : cloudKeyWords();

/** The clouds' rows, in a function so a public build, whose bundler reads the test above as false, drops their words.
 * The test is spelled out where it is read, since a bundler folds the constant only there. */
function cloudKeyWords(): Record<string, { name: string; keyName: string; keyConsole?: string }> {
  return {
    box: { name: "Boat", keyName: "Boat API key", keyConsole: "boat.dev/dashboard" },
    solari: { name: "Solari", keyName: "Solari API key", keyConsole: SOLARI_CONSOLE },
  };
}

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
  const fix = "Write it as the user and the host ssh logs in with, root@hetzner for one.";
  if (ssh === "") return { happened: "an ssh login cannot be blank", fix };
  return /^[\w.-]+@[\w.:\[\]-]+$/.test(ssh) ? undefined : { happened: `${ssh} is not an ssh login like root@host`, fix };
}

/** What a new ssh login is refused with once it was dialled: the computer that answered is not this one, or it
 * could not be read as any computer, and nothing of the record moved either way. */
export const placeSshOtherRefusal = (ssh: string, name: string): RefusalHalves => ({ happened: `${ssh} reaches a computer that is not ${name}, so nothing was saved`, fix: `Give the login that reaches ${name} itself.` });
export const placeSshUncheckedRefusal = (ssh: string, name: string, why: string): RefusalHalves => ({
  happened: `${ssh} could not be checked as ${name}, so nothing was saved: ${why}`,
  fix: `Check that ssh ${ssh} logs in as root, or through a sudo that asks no password, and try again.`,
});

/** Where a computer's own ssh login reaches, once its place file did not name that computer: another computer added
 * here, by the name its record has, or a machine that is not the one added under this name. Said without the two
 * names reading as one where an alias and the computer share a name. */
export const placeLoginElsewhere = (ssh: string, name: string, other?: string): string =>
  other === undefined ? `${ssh} no longer reaches the computer added here as ${name}` : `${ssh} reaches the other computer added here as ${other}`;

/** What an update over a computer's own ssh login is refused with before it changes anything there: the place file
 * that login reaches does not name this computer, or it could not be read. Where it names another computer added
 * here, this record is the stale one beside it, named by its id since the two may share a name. */
export const placeLoginOtherRefusal = (ssh: string, place: { id: string; name: string }, other?: string): RefusalHalves => ({
  happened: `${placeLoginElsewhere(ssh, place.name, other)}, so nothing was changed there`,
  fix:
    other === undefined
      ? `Give ${place.name} the login that reaches it with wsp computers set ${place.name} --ssh <user@host>, then try again.`
      : `This record of ${place.name} stands beside that one; take it away with wsp remove ${place.id}.`,
});
export const placeLoginUncheckedRefusal = (ssh: string, name: string, why: string): RefusalHalves => ({
  happened: `${ssh} could not be checked as ${name}, so nothing was changed there: ${why}`,
  fix: `Check that ssh ${ssh} logs in as root, or through a sudo that takes the password you typed, and try again.`,
});

/** What a remove says where the computer's own login reaches another machine: nothing ran there, the record is gone
 * from here all the same, and what wsp left on the computer itself stays. Where that machine is another computer
 * added here, it stays added and no leave is named, since one there would take that computer off. */
export const placeLoginElsewhereRemovedLine = (ssh: string, name: string, other?: string): string =>
  other === undefined
    ? `${placeLoginElsewhere(ssh, name)}, so nothing was changed on the machine it reaches; ${name} is off this host, and whatever wsp left on ${name} itself stays until wsp leave runs there`
    : `${placeLoginElsewhere(ssh, name, other)}, which stays added, so nothing was changed there; this record of ${name} is off this host`;
