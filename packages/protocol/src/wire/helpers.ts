// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { HarnessOption } from "../index.js";

const optionWords = (options: ReadonlyArray<HarnessOption>): string => options.map(o => `${o.label} (${o.value})`).join(", ");

function listed(subject: string, word: string, options: ReadonlyArray<HarnessOption>, value: string | undefined, legacy: ReadonlyArray<HarnessOption> = [], hidden: ReadonlyArray<HarnessOption> = []): void {
  if (value === undefined || options.some(o => o.value === value) || legacy.some(o => o.value === value) || hidden.some(o => o.value === value)) return;
  const older = legacy.length === 0 ? "" : `; legacy: ${optionWords(legacy)}`;
  const said = options.length === 0 ? `${subject} takes no ${word}` : `${word} "${value}" is not one ${subject} takes; one of: ${optionWords(options)}${older}`;
  throw Object.assign(new Error(said), { kind: "usage", offered: options.length });
}

/** Who held the port when it closed, from the watcher's last row for it; at is the daemon's clock. */
const portCloseDetail = {
  pid: z.number().optional(),
  process: z.string().optional(),
  /** The holder's argv joined by spaces, from /proc/<pid>/cmdline; the daemon reads at most 512 bytes of it and a cut argv ends with an ellipsis. */
  command: z.string().optional(),
  /** Whether the holder's pid was gone when the close was seen; absent without a pid. */
  exited: z.boolean().optional(),
  /** The port still listens, held by a process no longer the watching workspace's: it left the view, not stopped. */
  left: z.boolean().optional(),
  at: z.string().optional(),
};

const channel = z.number().int().min(0).max(255);

/** Where the event sits in its runtime's stream: one counter per runtime process, monotonic from 1, so a client that
 * lost its socket can ask events.subscribe for everything after the last one it saw. Absent on events from an older
 * runtime and on sessions.history replies, which a client reads whole. */
const sequenced = { seq: z.number().int().positive().optional() };

const reqId = z.union([z.string(), z.number()]);

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** A schema kept for a parse, held to the type the protocol crate writes for the same frame: where the two differ
 * in any field, the build fails rather than the parse drifting from the wire. */
type Held<T extends true> = T;

/** The decoded byte length of a base64 string, worked out from the string itself: this package is bundled into the
 * browser, so nothing here decodes through Buffer. */
function base64Bytes(text: string): number {
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - pad;
}

/** How long the base64 of so many bytes is, its padding counted: what bytes cost on a road that carries them as
 * text, read by the schemas below and by whoever bounds a frame by what its bytes take to cross. */
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

const base64 = (bytes: number) =>
  z
    .string()
    .max(base64Length(bytes))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine(text => text.length % 4 === 0 && base64Bytes(text) === bytes, `must be ${bytes} bytes, base64`);

export { listed, portCloseDetail, channel, sequenced, reqId, base64 };
export type { Same, Held };
