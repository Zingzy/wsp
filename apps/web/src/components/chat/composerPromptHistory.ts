// Adapted from pingdotgg/t3code apps/web/src/components/chat/composerPromptHistory.ts at c9a0e8a1 (MIT).
// Differs from upstream: a sent prompt is recalled whole, chips and all, since
// wsp's chips are the text they send and nothing is appended at send time that
// would need stripping.

/**
 * Terminal-style prompt recall for the composer. ArrowUp walks back through
 * the thread's sent prompts, ArrowDown walks forward and empties the composer
 * past the newest. Derived from the thread's user messages on every keypress,
 * so there is no store to persist or sync.
 */

export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

/** Active recall: the entry's id, resolved against the entries on every step so an optimistic row replaced by the
 * runtime's cannot move the position, and the text put in the composer, which once edited ends browsing. */
export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

export interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
}

/** The id first; a collapsed repeat can retire it while the same text lives on under a newer one. */
function findActive(entries: ReadonlyArray<ComposerPromptHistoryEntry>, position: ComposerPromptHistoryPosition): number {
  const byId = entries.findIndex(entry => entry.id === position.entryId);
  return byId >= 0 ? byId : entries.findLastIndex(entry => entry.prompt === position.recalled);
}

/** Oldest first. Consecutive identical prompts collapse into the newest, as a shell's ignoredups does, and a send
 * with no words is skipped. */
export function buildComposerPromptHistoryEntries(messages: ReadonlyArray<ComposerPromptHistoryMessage>): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const prompt = message.text.trim();
    if (prompt.length === 0) continue;
    if (entries.at(-1)?.prompt === prompt) entries[entries.length - 1] = { id: message.id, prompt };
    else entries.push({ id: message.id, prompt });
  }
  return entries;
}

/** Null when the key should fall through to the caret. Backward starts only from an empty composer or from a recall
 * still unedited, and stops at the oldest; forward past the newest empties the composer and ends browsing. */
export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const active = position !== null && position.recalled === currentPrompt ? findActive(entries, position) : -1;
  if (input.direction === "backward") {
    if (active < 0 && currentPrompt.length > 0) return null;
    const entry = entries[active < 0 ? entries.length - 1 : active - 1];
    return entry === undefined ? null : { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }
  if (active < 0) return null;
  const entry = entries[active + 1];
  return entry === undefined ? { position: null, prompt: "" } : { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}
