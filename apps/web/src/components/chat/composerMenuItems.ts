// SPDX-License-Identifier: AGPL-3.0-only
// The rows each composer menu draws, grouped: the slash menu's announced
// commands by their source with the person's skills under Skills, the @
// menu's files, and the # menu's pull requests and issues. A skill the harness
// announced is drawn once, under Skills, and goes as the command the harness
// knows; one it did not announce goes as $name.
import type { HostItem, SkillRow } from "@wsp/protocol";
import type { ProviderSlashCommand } from "./adapt";
import { composerCommandGroups, SKILLS_SOURCE, type ComposerCommandGroup } from "./composerCommandGroups";
import type { ComposerCommandItem, ComposerSlashItem } from "./ComposerCommandMenu";
import { searchComposerFiles, searchHostItems, skillsForHarness } from "./composerMenuSearch";
import { slashCommandItemsForPromptPosition } from "./composerSlashCommandSearch";

export function slashGroups(input: {
  harness: string;
  announced: ReadonlyArray<ProviderSlashCommand>;
  skills: ReadonlyArray<SkillRow>;
  query: string;
  atPromptStart?: boolean;
}): ComposerCommandGroup[] {
  const skills = skillsForHarness(input.skills, input.harness);
  const skillNames = new Set(skills.map(skill => skill.name));
  const announcedNames = new Set(input.announced.map(command => command.name));
  const commands: ComposerSlashItem[] = input.announced
    .filter(command => !skillNames.has(command.name))
    .map(command => ({
      id: `provider-slash-command:${input.harness}:${command.name}`,
      type: "provider-slash-command",
      harness: input.harness,
      command,
      label: `/${command.name}`,
      description: command.description ?? command.input?.hint ?? "",
    }));
  const skillItems: ComposerSlashItem[] = skills.map(skill => {
    const announced = announcedNames.has(skill.name);
    return {
      id: `skill:${input.harness}:${skill.name}`,
      type: "skill",
      harness: input.harness,
      command: { name: skill.name, source: SKILLS_SOURCE, ...(skill.description !== undefined ? { description: skill.description } : {}) },
      announced,
      label: announced ? `/${skill.name}` : `$${skill.name}`,
      description: skill.description ?? "",
    };
  });
  return composerCommandGroups(slashCommandItemsForPromptPosition([...commands, ...skillItems], input.atPromptStart ?? true), input.query);
}

/** The $ menu: the skills alone, by what was typed after the $. */
export function skillGroups(input: { harness: string; skills: ReadonlyArray<SkillRow>; query: string }): ComposerCommandGroup[] {
  return slashGroups({ harness: input.harness, announced: [], skills: input.skills, query: input.query });
}

export function fileGroups(files: ReadonlyArray<string>, query: string): ComposerCommandGroup[] {
  const items: ComposerCommandItem[] = searchComposerFiles(files, query).map(path => {
    const cut = path.lastIndexOf("/");
    return { id: `path:${path}`, type: "path", path, label: path.slice(cut + 1), description: cut > 0 ? path.slice(0, cut) : "" };
  });
  return items.length > 0 ? [{ value: "files", label: "Files", items }] : [];
}

const REFERENCE_HEADINGS = [
  { kind: "pull-request", value: "pull-requests", label: "Pull requests" },
  { kind: "issue", value: "issues", label: "Issues" },
] as const;

export function referenceGroups(items: ReadonlyArray<HostItem>, query: string): ComposerCommandGroup[] {
  const matched = searchHostItems(items, query);
  return REFERENCE_HEADINGS.flatMap(({ kind, value, label }) => {
    const rows: ComposerCommandItem[] = matched
      .filter(item => item.kind === kind)
      .map(item => ({ id: `reference:${kind}:${item.number}`, type: "reference", item, label: `#${item.number} ${item.title}`, description: "" }));
    return rows.length > 0 ? [{ value, label, items: rows }] : [];
  });
}
