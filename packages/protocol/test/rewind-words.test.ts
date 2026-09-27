// SPDX-License-Identifier: AGPL-3.0-only
// What a rewind says before the click and when the host says no: one home for
// the words, so the dialog, the refusal and the tests read the same sentence.
import { describe, expect, it } from "vitest";
import { REWIND_LATEST_LINE, REWIND_NO_CHECKPOINT_LINE, REWIND_NO_UNDO_LINE, REWIND_OWN_FOLDER_LINE, REWIND_WORKING_LINE, rewindChildrenLine, rewindNoAnchorLine, rewindNote, UNDO_REWIND_LINE } from "../src/index.js";

describe("the words a rewind says", () => {
  it("names what goes before the click, and that undo brings the files back and never the conversation", () => {
    expect(rewindNote({ turns: 3, files: true, cutsConversation: true, agent: "Claude Code" })).toBe(
      "The 3 turns after this reply leave the conversation, and the files go back to how they stood at this reply. Undo rewind puts the files back until the next turn ends; the conversation does not come back.",
    );
    expect(rewindNote({ turns: 1, files: false, cutsConversation: true, agent: "Codex" })).toBe("The turn after this reply leaves the conversation; the files stay as they are.");
    // An agent that keeps its own history: only the files move, and the note says why the turns stay.
    expect(rewindNote({ turns: 2, files: true, cutsConversation: false, agent: "Cursor" })).toBe(
      "Cursor keeps its own history, so the conversation stays and the files go back to how they stood at this reply. Undo rewind puts the files back until the next turn ends.",
    );
  });

  it("refuses in one sentence each, naming what to do", () => {
    expect(REWIND_WORKING_LINE).toBe("this thread is working; stop its turn first, since a rewind never stops it for you");
    expect(rewindChildrenLine(["fix the port list", "write the migration"])).toBe(
      "stop the threads under this one first (fix the port list, write the migration); a rewind never stops them for you",
    );
    expect(REWIND_NO_CHECKPOINT_LINE).toBe("that reply kept no checkpoint of the files, so only its conversation can be rewound");
    expect(rewindNoAnchorLine("Claude Code")).toBe("Claude Code left no point in that reply to cut its conversation at, so only the files can go back");
    expect(REWIND_LATEST_LINE).toBe("that is the thread's latest reply, so nothing comes after it to rewind");
    expect(REWIND_OWN_FOLDER_LINE).toBe("this workspace is your own folder, and wsp keeps no checkpoints there; start the work in a copy to rewind it");
    expect(REWIND_NO_UNDO_LINE).toBe("this thread has no rewind to undo; undo lasts until the turn after a rewind ends");
    expect(UNDO_REWIND_LINE).toBe("Files come back; the cut conversation does not.");
  });
});
