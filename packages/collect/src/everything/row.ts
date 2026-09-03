// SPDX-License-Identifier: AGPL-3.0-only
// One row per thing found under HOME that no rung knows by name. The init
// screen lists these unticked; the catalog (#89) and the person decide.
import { z } from "zod";

export const KINDS = ["config", "state", "cache", "credential", "device-bound-login", "unknown"] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

export const FLAGS = ["credential", "large", "stale"] as const;
export const Flag = z.enum(FLAGS);
export type Flag = z.infer<typeof Flag>;

export const Row = z.object({
  name: z.string().min(1),
  kind: Kind,
  /** `~`-relative on the laptop; empty for a Keychain item, whose location is never recorded. */
  paths: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  /** Newest file under the row, epoch ms; 0 when nothing on disk backs it. */
  mtime: z.number().int().nonnegative(),
  /** Who installed the binary this row belongs to, from the provenance pass. */
  owner: z.string().optional(),
  flags: z.array(Flag),
  ticked: z.boolean(),
});
export type Row = z.infer<typeof Row>;

export const Rows = z.array(Row);
