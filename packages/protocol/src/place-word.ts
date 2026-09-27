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
