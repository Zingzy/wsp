// SPDX-License-Identifier: AGPL-3.0-only
// The person's own chords over the defaults. An override names one chord for a
// command and replaces every default chord that command has, keeping the
// when of its default on that chord, else of its first default, so a chord
// moved off the terminal still reads only while the terminal has focus and a
// chord moved back onto a default reads where that default did. The chord reader is adapted from pingdotgg/t3code
// apps/web/src/components/settings/KeybindingsSettings.logic.ts at 57a66608
// (MIT); the clash check asks whether two rules can fire in one context rather
// than comparing their when text.
import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS, parseKeybindingShortcut, parseKeybindingWhenExpression } from "./keybindingDefaults.js";
import { browserTabClaimsShortcut, evaluateWhenNode, formatShortcutLabel, shortcutConflictKey } from "./keybindings.js";
import { KEYBINDING_COMMANDS, type KeybindingCommand, type KeybindingRule, type KeybindingWhenNode, type ResolvedKeybindingsConfig } from "./keybindingTypes.js";
import { isMacPlatform } from "./lib/utils.js";
import { CHORD_WORDS } from "./settings/keybindingWords.js";

const isCommand = (id: string): id is KeybindingCommand => (KEYBINDING_COMMANDS as readonly string[]).includes(id);

/** The rules with each override in place of its command's defaults. An override for a command this build does not
 * dispatch, or whose chord does not parse, is left out, so a hand-edited record cannot unbind a command. */
export function rulesWith(defaults: ReadonlyArray<KeybindingRule>, overrides: Readonly<Record<string, string>>, platform = navigator.platform): KeybindingRule[] {
  const moved = Object.entries(overrides).filter((entry): entry is [KeybindingCommand, string] => isCommand(entry[0]) && parseKeybindingShortcut(entry[1]) !== null);
  if (moved.length === 0) return [...defaults];
  const commands = new Set(moved.map(([command]) => command));
  const kept = defaults.filter(rule => !commands.has(rule.command));
  const added = moved.map(([command, key]): KeybindingRule => {
    const when = overrideWhen(defaults, command, key, platform);
    return when === undefined ? { key, command } : { key, command, when };
  });
  return [...kept, ...added];
}

/** The command's default rule on this chord, however the chord is spelled for the platform. */
function defaultOn(defaults: ReadonlyArray<KeybindingRule>, command: KeybindingCommand, key: string, platform: string): KeybindingRule | undefined {
  const shortcut = parseKeybindingShortcut(key);
  if (shortcut === null) return undefined;
  const chord = shortcutConflictKey(shortcut, platform);
  return defaults.find(rule => {
    const at = rule.command === command ? parseKeybindingShortcut(rule.key) : null;
    return at !== null && shortcutConflictKey(at, platform) === chord;
  });
}

/** The when a chord of the person's own takes for a command: its default's on the same chord, else its first
 * default's. */
function overrideWhen(defaults: ReadonlyArray<KeybindingRule>, command: KeybindingCommand, key: string, platform: string): string | undefined {
  return (defaultOn(defaults, command, key, platform) ?? defaults.find(rule => rule.command === command))?.when;
}

const compiled = new WeakMap<object, ResolvedKeybindingsConfig>();

/** The compiled rules for one overrides record, compiled once per record: the store hands the same object back until
 * a patch moves it, so every reader of one record shares one compile. */
export function keybindingsFor(overrides: Readonly<Record<string, string>>): ResolvedKeybindingsConfig {
  if (Object.keys(overrides).length === 0) return DEFAULT_RESOLVED_KEYBINDINGS;
  const held = compiled.get(overrides);
  if (held !== undefined) return held;
  const made = compileResolvedKeybindingsConfig(rulesWith(DEFAULT_KEYBINDINGS, overrides));
  compiled.set(overrides, made);
  return made;
}

function keyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (["meta", "control", "ctrl", "shift", "alt", "option", "altgraph"].includes(normalized)) return null;
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", "enter", "tab", "backspace", "delete", "home", "end", "pageup", "pagedown"].includes(normalized)) return normalized;
  return null;
}

/** The chord a key press makes, in the rules' spelling with mod for the platform's own; nothing for a modifier on its
 * own or a key pressed with no modifier, which is typing rather than a chord. */
export function keybindingFromKeyboardEvent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, platform: string): string | null {
  const token = keyToken(event.key);
  if (token === null) return null;
  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (parts.length === 0) return null;
  parts.push(token);
  return parts.join("+");
}

function identifiersOf(node: KeybindingWhenNode | null, into: Set<string>): Set<string> {
  if (node === null) return into;
  if (node.type === "identifier") into.add(node.name);
  else if (node.type === "not") identifiersOf(node.node, into);
  else {
    identifiersOf(node.left, into);
    identifiersOf(node.right, into);
  }
  return into;
}

/** Whether two when clauses can hold at once: every context their names can make is tried, terminalOwnsMod read off
 * terminalFocus and the platform the way the matcher derives it. */
function canFireTogether(left: string | undefined, right: string | undefined, platform: string): boolean {
  const a = left === undefined ? null : parseKeybindingWhenExpression(left);
  const b = right === undefined ? null : parseKeybindingWhenExpression(right);
  const names = [...identifiersOf(b, identifiersOf(a, new Set(["terminalFocus"])))].filter(name => name !== "terminalOwnsMod" && name !== "true" && name !== "false");
  for (let mask = 0; mask < 1 << names.length; mask += 1) {
    const context: Record<string, boolean> = Object.fromEntries(names.map((name, at) => [name, (mask & (1 << at)) !== 0]));
    context["terminalOwnsMod"] = context["terminalFocus"] === true && !isMacPlatform(platform);
    if ((a === null || evaluateWhenNode(a, context)) && (b === null || evaluateWhenNode(b, context))) return true;
  }
  return false;
}

export interface ChordRead {
  readonly platform: string;
  readonly labelOf: (command: KeybindingCommand) => string;
}

/** Why a command cannot take this chord, or null where it can: another command's rule holds it in a context both can
 * fire in, or a browser tab keeps it for its own and it is none of the command's defaults, which is refused in the
 * desktop too so one binding works in both. */
export function chordRefusal(rules: ReadonlyArray<KeybindingRule>, command: KeybindingCommand, chord: string, read: ChordRead): string | null {
  const shortcut = parseKeybindingShortcut(chord);
  if (shortcut === null) return null;
  const when = overrideWhen(DEFAULT_KEYBINDINGS, command, chord, read.platform);
  const key = shortcutConflictKey(shortcut, read.platform);
  const holders = rules
    .filter(rule => rule.command !== command)
    .filter(rule => {
      const other = parseKeybindingShortcut(rule.key);
      return other !== null && shortcutConflictKey(other, read.platform) === key && canFireTogether(when, rule.when, read.platform);
    })
    .map(rule => read.labelOf(rule.command));
  const named = [...new Set(holders)];
  if (named.length > 0) return CHORD_WORDS.taken(named);
  // A command's own default stands where it stood, so a chord moved off one goes back onto it.
  if (browserTabClaimsShortcut(shortcut, read.platform) && defaultOn(DEFAULT_KEYBINDINGS, command, chord, read.platform) === undefined) return CHORD_WORDS.tabKeeps(formatShortcutLabel(shortcut, read.platform));
  return null;
}
