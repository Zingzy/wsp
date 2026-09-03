// SPDX-License-Identifier: AGPL-3.0-only
// The rung screen driven through fake streams: keys go in as the escape
// sequences a terminal sends, frames come out and are read with the ANSI
// stripped. Nothing here touches process.stdin.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { buildEntries, matches, rungSelect, toggleEntry, type SelectItem } from "../src/init-select.js";

const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", space: " ", enter: "\r", esc: "\x1b", ctrlC: "\x03" };

const CHOICES = [
  { value: "copy", label: "copy" },
  { value: "machine", label: "sign in" },
  { value: "skip", label: "skip" },
];

const ITEMS: SelectItem[] = [
  { id: "git", label: "git name and email", detail: ["~/.gitconfig", "512 B"], lock: "on" },
  { id: "gh", label: "gh", group: "Homebrew", detail: ["Brewfile", "reinstalled by brew"] },
  { id: "jq", label: "jq", group: "Homebrew", detail: ["Brewfile", "reinstalled by brew"] },
  { id: "pnpm", label: "pnpm", group: "npm globals", detail: ["npm -g", "reinstalled by npm"] },
  { id: "rectangle", label: "rectangle", group: "Homebrew casks", detail: ["Brewfile", "macOS app, no Linux build"], lock: "off" },
  { id: "zshrc", label: "~/.zshrc", detail: ["~/.zshrc", "3.0 KB"] },
];

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const text = () => stripVTControlCharacters(chunks.join(""));
  const clear = () => chunks.splice(0);
  return { input, output, text, clear };
}

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function press(input: PassThrough, ...keys: string[]): Promise<void> {
  for (const k of keys) {
    input.write(k);
    // A lone escape is only an escape once readline's 50ms sequence timeout passes.
    await settle(k === KEY.esc ? 70 : 5);
  }
}

describe("rung entries", () => {
  it("groups items under their heading, keeps ungrouped ones flat, and starts with the all row", () => {
    const entries = buildEntries(ITEMS, "", new Set());
    expect(entries.map(e => (e.type === "item" ? e.item.id : e.type === "group" ? `#${e.group}` : "*"))).toEqual([
      "*", "git", "#Homebrew", "gh", "jq", "#npm globals", "pnpm", "#Homebrew casks", "rectangle", "zshrc",
    ]);
  });

  it("a folded group hides its items; a search matches label or id and drops the all row", () => {
    const folded = buildEntries(ITEMS, "", new Set(["Homebrew"]));
    expect(folded.map(e => (e.type === "item" ? e.item.id : e.type === "group" ? `#${e.group}` : "*"))).toEqual([
      "*", "git", "#Homebrew", "#npm globals", "pnpm", "#Homebrew casks", "rectangle", "zshrc",
    ]);
    expect(matches(ITEMS[1]!, "GH")).toBe(true);
    expect(matches(ITEMS[5]!, "zsh")).toBe(true);
    expect(matches(ITEMS[5]!, "fish")).toBe(false);
    const searched = buildEntries(ITEMS, "j", new Set());
    expect(searched.map(e => (e.type === "item" ? e.item.id : e.type === "group" ? `#${e.group}` : "*"))).toEqual(["#Homebrew", "jq"]);
  });

  it("toggling a group flips only its tickable items; locked items never move", () => {
    const ticks = new Set<string>(["git"]);
    const entries = buildEntries(ITEMS, "", new Set());
    toggleEntry(ticks, entries[2]!, ITEMS);
    expect([...ticks].sort()).toEqual(["gh", "git", "jq"]);
    toggleEntry(ticks, entries[2]!, ITEMS);
    expect([...ticks]).toEqual(["git"]);
    toggleEntry(ticks, entries[7]!, ITEMS);
    expect(ticks.has("rectangle")).toBe(false);
    toggleEntry(ticks, entries[1]!, ITEMS);
    expect(ticks.has("git")).toBe(true);
    toggleEntry(ticks, entries[0]!, ITEMS);
    expect([...ticks].sort()).toEqual(["gh", "git", "jq", "pnpm", "zshrc"]);
    toggleEntry(ticks, entries[0]!, ITEMS);
    expect([...ticks]).toEqual(["git"]);
  });
});

describe("rungSelect", () => {
  it("enter returns the ticks with locked-on items included and locked-off items never", async () => {
    const { input, output, text } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(["gh", "jq", "pnpm", "zshrc"]), input, output });
    await settle();
    const frame = text();
    expect(frame).toContain("Tools");
    expect(frame).toContain("5/7");
    expect(frame).toMatch(/rectangle\s+stays here/);
    expect(frame).toMatch(/git name and email\s+always/);
    expect(frame).not.toContain("macOS app, no Linux build");
    expect(frame).not.toMatch(/—|\p{Emoji_Presentation}/u);
    // Cursor starts on the all row; down twice lands on the Homebrew heading, space clears it.
    await press(input, KEY.down, KEY.down, KEY.space);
    expect(text()).toContain("Homebrew");
    await press(input, KEY.enter);
    const result = await p;
    expect(result.kind).toBe("next");
    if (result.kind !== "next") return;
    expect([...result.ticks].sort()).toEqual(["git", "pnpm", "zshrc"]);
  });

  it("a locked row shows why only in the detail pane, once it is highlighted", async () => {
    const { input, output, text, clear } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(), input, output });
    await press(input, "r", "e", "c", "t");
    clear();
    await press(input, KEY.down);
    expect(text()).toContain("macOS app, no Linux build");
    await press(input, KEY.enter);
    await p;
  });

  it("typing filters, space ticks the match, and the detail pane shows the highlighted item's lines", async () => {
    const { input, output, text, clear } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(["git"]), input, output });
    await press(input, "j", "q");
    clear();
    await press(input, KEY.down);
    const frame = text();
    expect(frame).toContain("reinstalled by brew");
    expect(frame).not.toContain("pnpm");
    await press(input, KEY.space, KEY.enter);
    const result = await p;
    expect(result.kind === "next" && [...result.ticks].sort()).toEqual(["git", "jq"]);
  });

  it("escape goes back and still hands the ticks so the earlier screen can replay them", async () => {
    const { input, output } = streams();
    const p = rungSelect({ title: "Shell", counter: "2/7", items: ITEMS, initial: new Set(["zshrc"]), input, output });
    await press(input, KEY.down, KEY.down, KEY.down, KEY.space, KEY.esc);
    const result = await p;
    expect(result).toEqual({ kind: "back", ticks: new Set(["git", "gh", "zshrc"]), choices: new Map() });
  });

  it("ctrl-c cancels", async () => {
    const { input, output } = streams();
    const p = rungSelect({ title: "Shell", counter: "2/7", items: ITEMS, initial: new Set(), input, output });
    await press(input, KEY.ctrlC);
    expect(await p).toEqual({ kind: "cancel" });
  });

  it("initial ticks for rows not on the screen are dropped from the answer", async () => {
    const { input, output } = streams();
    const p = rungSelect({ title: "Shell", counter: "2/7", items: ITEMS, initial: new Set(["zshrc", "gone"]), input, output });
    await press(input, KEY.enter);
    expect(await p).toEqual({ kind: "next", ticks: new Set(["git", "zshrc"]), choices: new Map() });
  });

  it("the header of a choice screen carries the spread of answers; a group row carries only its size", async () => {
    const items: SelectItem[] = [
      { id: "gh", label: "GitHub CLI login", group: "CLI logins", detail: [], choices: CHOICES },
      { id: "claude", label: "Claude Code login", group: "Agent logins", detail: [], choices: CHOICES },
      { id: "codex", label: "Codex login", group: "Agent logins", detail: [], choices: CHOICES },
      { id: "gemini", label: "Gemini CLI login", group: "Agent logins", detail: [], choices: CHOICES },
    ];
    const { input, output, text, clear } = streams();
    const p = rungSelect({
      title: "Sign-ins",
      counter: "7/7",
      items,
      initial: new Set(["gh", "codex"]),
      initialChoices: new Map([["gh", "copy"], ["claude", "machine"], ["codex", "copy"], ["gemini", "skip"]]),
      input,
      output,
    });
    await settle();
    expect(text()).toMatch(/Sign-ins\s+7\/7\s+2 copy, 1 sign in, 1 skip/);
    expect(text()).toMatch(/Agent logins\s+3\n/);
    expect(text()).toMatch(/CLI logins\s+1\n/);
    expect(text()).not.toContain("0 of 0");
    clear();
    // Past the CLI heading, gh, and the Agent heading onto claude: sign in -> skip.
    await press(input, KEY.down, KEY.down, KEY.down, KEY.space);
    expect(text()).toMatch(/Sign-ins\s+7\/7\s+2 copy, 2 skip/);
    expect(text()).toMatch(/Agent logins\s+3\n/);
    await press(input, KEY.enter);
    await p;
  });

  it("a row with choices cycles them on space, has no all row, and reports the choice; copy counts as a tick", async () => {
    const items: SelectItem[] = [
      { id: "gh", label: "GitHub CLI login", detail: ["~/.config/gh/hosts.yml"], choices: CHOICES },
      { id: "claude", label: "Claude Code login", detail: ["Keychain"], choices: CHOICES },
    ];
    const { input, output, text, clear } = streams();
    const p = rungSelect({
      title: "Sign-ins",
      counter: "7/7",
      items,
      initial: new Set(["gh"]),
      initialChoices: new Map([["gh", "copy"], ["claude", "machine"]]),
      input,
      output,
    });
    await settle();
    expect(text()).not.toContain("all ");
    expect(text()).toMatch(/GitHub CLI login\s+copy/);
    expect(text()).toMatch(/Claude Code login\s+sign in/);
    clear();
    await press(input, KEY.space);
    expect(text()).toMatch(/GitHub CLI login\s+sign in/);
    await press(input, KEY.space);
    await press(input, KEY.space);
    await press(input, KEY.down, KEY.space, KEY.enter);
    const result = await p;
    expect(result.kind).toBe("next");
    if (result.kind !== "next") return;
    expect(result.choices).toEqual(new Map([["gh", "copy"], ["claude", "skip"]]));
    expect([...result.ticks]).toEqual(["gh"]);
  });

  it("rows line up in two columns cut to the width, and never wrap", async () => {
    const wide: SelectItem[] = [
      { id: "a", label: "a".repeat(120), group: "Go binaries", detail: ["go install", "reinstalled by go"], hint: "1.2 MB" },
      { id: "b", label: "short", group: "Go binaries", detail: [], hint: "12 B" },
      { id: "c", label: "c", detail: [] },
    ];
    const { input, output, text } = streams();
    Object.assign(output, { columns: 60 });
    const p = rungSelect({ title: "Tools", counter: "5/7", items: wide, initial: new Set(["a"]), input, output });
    await settle();
    const rows = text().split("\n").filter(l => l.includes("◼") || l.includes("◻") || l.includes("▾"));
    expect(rows.length).toBe(5);
    expect(rows.map(l => l.length).filter(n => n > 60)).toEqual([]);
    expect(rows.find(l => l.includes("aaaa"))).toMatch(/a…\s+1\.2 MB$/);
    // The second column is flush right: every filled second cell ends at the same column.
    const ends = rows.filter(l => /(MB|B|of \d+)$/.test(l)).map(l => l.length);
    expect(new Set(ends).size).toBe(1);
    await press(input, KEY.enter);
    await p;
  });

  it("left folds the group under the cursor and right unfolds it", async () => {
    const { input, output, text, clear } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: ITEMS, initial: new Set(), input, output });
    await press(input, KEY.down, KEY.down, KEY.down);
    clear();
    await press(input, KEY.left);
    expect(text()).toContain("Homebrew");
    expect(text()).not.toContain("jq");
    clear();
    await press(input, KEY.right);
    expect(text()).toContain("jq");
    await press(input, KEY.enter);
    await p;
  });
});
