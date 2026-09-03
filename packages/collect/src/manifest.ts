// SPDX-License-Identifier: AGPL-3.0-only
// The manifest is one row per thing the collector found on the laptop that
// could be brought to a golden. wsp init reads it, the person ticks rows, and
// the same shape with bring and choice filled in is saved as the recipe file,
// so one schema covers both a fresh collection and a saved recipe.
import { z } from "zod";

export const RUNGS = ["identity", "shell", "editors", "toolchains", "tools", "agents", "logins"] as const;
export const Rung = z.enum(RUNGS);
export type Rung = z.infer<typeof Rung>;

/** What happens to a login: copied from this computer, signed in on the machine, or left out. */
export const LOGIN_CHOICES = ["copy", "machine", "skip"] as const;
export const LoginChoice = z.enum(LOGIN_CHOICES);
export type LoginChoice = z.infer<typeof LoginChoice>;

export const Default = z.enum(["bring", "skip"]);
export type Default = z.infer<typeof Default>;

/** Whether a tools row can be installed on the Linux machine; unknown when nothing on the laptop can tell. */
export const LINUX = ["yes", "no", "unknown"] as const;
export const Linux = z.enum(LINUX);
export type Linux = z.infer<typeof Linux>;

const Fields = z.object({
  rung: Rung,
  /** `<rung>/<name>`; the last segment looks up install and sign-in commands. */
  id: z.string().min(1),
  label: z.string(),
  /** Source paths on the laptop, `~`-relative; empty for a row that is a list item (a formula, an extension). */
  paths: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
  default: Default,
  /** Why the default is skip. With a reason the row renders locked off and cannot be ticked. */
  reason: z.string().optional(),
  /** Heading the row sits under inside its rung; the rung screen ticks a group as a unit. */
  group: z.string().optional(),
  /** Always brought, shown locked on. */
  required: z.boolean().optional(),
  /** The person's tick, written into the recipe file; absent on a fresh collection. */
  bring: z.boolean().optional(),
  /** The person's answer on a logins row; absent on a fresh collection. */
  choice: LoginChoice.optional(),
  /** Only on a tools row; the TUI greys out a "no". */
  linux: Linux.optional(),
  /** Only on a tools row: the version the laptop runs, which the machine installs by pin. */
  version: z.string().min(1).optional(),
});

export const ManifestEntry = Fields.superRefine((e, ctx) => {
  if (!e.id.startsWith(`${e.rung}/`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: `id must start with ${e.rung}/` });
  }
  if (e.choice !== undefined && e.rung !== "logins") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["choice"], message: "only a logins row carries a choice" });
  }
  if (e.linux !== undefined && e.rung !== "tools") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linux"], message: "only a tools row carries a linux marker" });
  }
  if (e.version !== undefined && e.rung !== "tools") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["version"], message: "only a tools row carries a version" });
  }
  if (e.required === true && e.default === "skip") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["required"], message: "a required row cannot default to skip" });
  }
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const Manifest = z.object({ entries: z.array(ManifestEntry) }).superRefine((m, ctx) => {
  const seen = new Set<string>();
  m.entries.forEach((e, i) => {
    if (seen.has(e.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "id"], message: `duplicate id ${e.id}` });
    }
    seen.add(e.id);
  });
});
export type Manifest = z.infer<typeof Manifest>;

/** Parses unknown data into a manifest; the error names the failing row and field (entries.3.rung). */
export function parseManifest(data: unknown): Manifest {
  const r = Manifest.safeParse(data);
  if (r.success) return r.data;
  const lines = r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
  throw new Error(`invalid manifest: ${lines.join("; ")}`);
}
