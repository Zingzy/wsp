// SPDX-License-Identifier: AGPL-3.0-only
/** The id the computer the host runs on carries in that list. It is a place like every other, and the one nothing
 * was installed on, so both sides of the wire read the same word for it. */
export const HERE_PLACE_ID = "here";

/** Whether a word names this place: the id the wire keys it by, or the name a person types. The one reading every
 * road that takes a place word makes, so a list, a frame and a typed word cannot disagree about which place. */
export const namesPlace = (place: { id: string; name: string }, word: string): boolean => word === place.id || word === place.name;
