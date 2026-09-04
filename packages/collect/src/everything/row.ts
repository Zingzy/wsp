// SPDX-License-Identifier: AGPL-3.0-only
// One row per thing found under HOME that no rung knows by name. The init
// screen lists these unticked; the catalog and the person decide.
import { z } from "zod";

export const KINDS = ["config", "state", "cache", "credential", "device-bound-login", "unknown"] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

/** partial: the credential check of this row stopped at its cap, so a secret inside may have been missed.
 * history: a git repository, every version of every file ever committed. exports: secret-shaped exports under a name the copy does not strip. */
export const FLAGS = ["credential", "large", "stale", "partial", "history", "exports"] as const;
export const Flag = z.enum(FLAGS);
export type Flag = z.infer<typeof Flag>;

/** The dotfiles manager whose home a row is. */
export const MANAGERS = ["chezmoi", "yadm", "stow", "dotfiles"] as const;
export const Manager = z.enum(MANAGERS);
export type Manager = z.infer<typeof Manager>;

export const MEASURED = ["exact", "lower-bound", "none"] as const;
export const Measured = z.enum(MEASURED);
export type Measured = z.infer<typeof Measured>;

export const Row = z.object({
  /** Stable across runs: the primary path relative to HOME, `bin:<name>` for a binary alone, `keychain:<service>` for a Keychain item. */
  id: z.string().min(1),
  name: z.string().min(1),
  kind: Kind,
  /** `~`-relative files that may travel; empty for a Keychain item, whose location is never recorded, and for a binary alone. */
  paths: z.array(z.string()),
  /** `~`-relative paths under `paths` that are not this row's to carry: split-out cache and state, credentials, what another rung already holds. A copier uploads paths minus excludes. */
  excludes: z.array(z.string()),
  /** `~`-relative binary this row belongs to when nothing recorded how it was installed; reinstalled on the machine, never copied. */
  binary: z.string().optional(),
  /** `~`-relative target when the primary path is a symlink; the tree was measured there. */
  linkTarget: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  /** Newest file under the row, epoch ms; 0 when nothing on disk backs it. */
  mtime: z.number().int().nonnegative(),
  /** lower-bound when the walk stopped at its cap, none when the tree was not walked at all. */
  measured: Measured,
  /** Who installed the binary this row belongs to, from the provenance pass. */
  owner: z.string().optional(),
  flags: z.array(Flag),
  ticked: z.boolean(),
  /** Set on the row that is a dotfiles manager's home. */
  manager: Manager.optional(),
  /** Files under a manager home that stand for an rc file, relative to it; the pack strips them by the same mapping. */
  rcCopies: z.array(z.string()).optional(),
  /** Those of rcCopies that carry secret-shaped exports. */
  rcSecrets: z.array(z.string()).optional(),
});
export type Row = z.infer<typeof Row>;

export const Rows = z.array(Row);
