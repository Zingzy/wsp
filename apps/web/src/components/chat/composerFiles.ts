// SPDX-License-Identifier: AGPL-3.0-only
// The files a composer is holding, the files a queued message waits with, the
// files it turned away, and the files a send carried, all in memory only. Nothing here is persisted: the draft store writes to local
// storage and a file would fill it; the stash alone keeps bytes there, under
// its own cap. The bytes go to the host on the send and, for an image, to an
// object URL for the thumbnail, and both go when the tab does. The bank keyed
// by request id is what lets the transcript draw the images of a message this
// browser sent; a transcript replayed after a reload has the records the
// runtime kept and draws their words instead.
import { create } from "zustand";
import { IMAGE_TYPES, filesRefusal, imageTypeOf, isImage, UNTYPED_FILE, type Attachment, type AttachmentRecord } from "@wsp/protocol";
import { newId } from "./composerDraftStore";
import type { StashedFile } from "./promptStashStore";

export interface ComposerFile {
  readonly id: string;
  readonly mediaType: string;
  readonly name: string;
  /** The file's bytes, base64, exactly what the wire carries. */
  readonly bytes: string;
  /** For an image, an in-memory URL over the same bytes, for the thumbnail and the full-size view; revoked when the
   * image leaves. A file that is not an image draws as a chip and holds none. */
  readonly url?: string;
  /** What the file weighs, so the row and the transcript say it without decoding the base64 again. */
  readonly size: number;
}

const NONE: ReadonlyArray<ComposerFile> = [];

const revoke = (file: ComposerFile): void => {
  if (file.url !== undefined) URL.revokeObjectURL(file.url);
};

/** How many sends of one tab keep their images in memory. Beyond this the oldest let go and their rows read as any
 * other client's do. A message at both caps is fifty megabytes, so this bounds what one tab holds. */
const SENT_KEPT = 10;

/** Base64 in chunks: one spread of ten million bytes into fromCharCode overflows the argument stack. */
const CHUNK = 0x8000;
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return btoa(binary);
}

/** The record form of a file the composer holds, for the one refusal rule the whole product shares. */
export const recordOf = (file: ComposerFile): AttachmentRecord => ({ mediaType: file.mediaType, bytes: file.size, name: file.name });

/** What the wire carries for a file the composer holds. */
export const attachmentOf = (file: ComposerFile): Attachment => ({ mediaType: file.mediaType, bytes: file.bytes, name: file.name });

/** A blob's bytes through FileReader, the one road every browser has; Blob.arrayBuffer is newer than the oldest
 * engine the app runs in and than the jsdom the component tests run under. */
function bytesOf(blob: Blob): Promise<{ bytes: Uint8Array; buffer: ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      resolve({ bytes: new Uint8Array(buffer), buffer });
    };
    reader.onerror = () => reject(reader.error ?? new Error("that file could not be read"));
    reader.readAsArrayBuffer(blob);
  });
}

/** The head every image type is told apart by; the longest of the four is twelve bytes. */
const HEAD_BYTES = 12;

/** What one file the person pasted, dropped or picked is, without reading it whole: an image by its own first bytes
 * rather than its name, anything else by the type the browser gave it, and its weight off the file, so naming a
 * video does not pull it into memory to be refused. The same reading the command line does. */
export async function fileFactsOf(file: File): Promise<AttachmentRecord> {
  const { bytes } = await bytesOf(file.slice(0, HEAD_BYTES));
  const image = imageTypeOf(bytes);
  // A type the browser gave is taken for anything but an image, which only its own bytes can make one.
  const mediaType = image ?? (file.type === "" || isImage(file.type) ? UNTYPED_FILE : file.type);
  const unnamed = image !== null ? `pasted.${IMAGE_TYPES[image]?.ext ?? "png"}` : "pasted-file";
  return { mediaType, bytes: file.size, name: file.name === "" ? unnamed : file.name };
}

/** One file read whole, once its facts have passed the caps. */
export async function fileOf(file: File, facts: AttachmentRecord): Promise<ComposerFile> {
  const { bytes, buffer } = await bytesOf(file);
  return {
    id: newId(),
    mediaType: facts.mediaType,
    name: facts.name ?? file.name,
    bytes: toBase64(bytes),
    ...(isImage(facts.mediaType) ? { url: URL.createObjectURL(new Blob([buffer], { type: facts.mediaType })) } : {}),
    size: bytes.length,
  };
}

/** What the stash keeps of a file the composer holds: everything but its object URL, which dies with the tab. */
export const stashedOf = (file: ComposerFile): StashedFile => ({ mediaType: file.mediaType, name: file.name, bytes: file.bytes, size: file.size });

/** A stashed file back in the composer, an image with a fresh URL over its bytes. */
export function fileFromStash(stashed: StashedFile): ComposerFile {
  const url = isImage(stashed.mediaType) ? URL.createObjectURL(new Blob([Uint8Array.from(atob(stashed.bytes), c => c.charCodeAt(0))], { type: stashed.mediaType })) : undefined;
  return { id: newId(), mediaType: stashed.mediaType, name: stashed.name, bytes: stashed.bytes, size: stashed.size, ...(url !== undefined ? { url } : {}) };
}

/** Lets go of the URLs of files the composer no longer holds. */
export const releaseFiles = (files: ReadonlyArray<ComposerFile>): void => files.forEach(revoke);

/** A file the composer turned away, drawn as a chip beside the ones it holds until removed or a send clears it. */
export interface RefusedFile {
  readonly id: string;
  readonly name: string;
  /** The sentence why, which rides the chip's hover. */
  readonly why: string;
}

const NO_REFUSALS: ReadonlyArray<RefusedFile> = [];

interface FilesState {
  /** Keyed by workspace, as the draft is: what the composer will send next. */
  pending: Record<string, ReadonlyArray<ComposerFile>>;
  /** Keyed by workspace: the files the last adds turned away. */
  refused: Record<string, ReadonlyArray<RefusedFile>>;
  /** Keyed by the queued message's id: the files it goes with when its turn comes. */
  queued: Record<string, ReadonlyArray<ComposerFile>>;
  /** Keyed by the request id the composer minted for a send: what that message carried, for this tab's lifetime. */
  sent: Record<string, ReadonlyArray<ComposerFile>>;
  /** Adds what the person gave. A file empty or over its own cap lands in `refused` alone, a chip with its own
   * sentence; the count cap and `noImages` (the line for an agent that reads no image, which turns an image away
   * before it is read whole) turn the whole batch away. */
  add(workspaceId: string, files: readonly File[], noImages?: string): Promise<void>;
  remove(workspaceId: string, id: string): void;
  /** Drops one refused chip, or every one of the workspace's when no id is named. */
  dismiss(workspaceId: string, id?: string): void;
  /** Moves this workspace's files onto a queued message, which the composer no longer shows. */
  queue(workspaceId: string, rowId: string): void;
  /** Takes a queued message's files back, as its edit puts them back in the box. */
  unqueue(rowId: string): ReadonlyArray<ComposerFile>;
  /** Lets go of a removed queued message's files. */
  drop(rowId: string): void;
  /** Puts files the composer already read back in front of what it holds: a stash restored. */
  put(workspaceId: string, files: ReadonlyArray<ComposerFile>): void;
  /** Takes every file this workspace's composer holds, which the composer no longer shows: a stash taken. */
  take(workspaceId: string): ReadonlyArray<ComposerFile>;
  /** Moves this workspace's files, or a queued message's when `rowId` names one, onto the request id the send
   * carried; the composer opens empty. */
  sendAs(workspaceId: string, requestId: string, rowId?: string): void;
  /** Puts back what a refused send took, onto the queued message it came off when `rowId` names one, so the person's
   * files are not lost with the request. */
  restore(workspaceId: string, requestId: string, rowId?: string): void;
}

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

export const useComposerFilesStore = create<FilesState>()((set, get) => ({
  pending: {},
  refused: {},
  queued: {},
  sent: {},
  async add(workspaceId, files, noImages) {
    const refuse = (facts: ReadonlyArray<AttachmentRecord>, why: (fact: AttachmentRecord) => string): void => {
      if (facts.length > 0) set(s => ({ refused: { ...s.refused, [workspaceId]: [...(s.refused[workspaceId] ?? NO_REFUSALS), ...facts.map(f => ({ id: newId(), name: f.name ?? "", why: why(f) }))] } }));
    };
    // The heads first, so a file over the cap is turned away before it is read whole.
    const facts = await Promise.all(files.map(fileFactsOf));
    if (noImages !== undefined && facts.some(f => isImage(f.mediaType))) return refuse(facts, () => noImages);
    // A file empty or over its own cap is refused alone, under its own sentence; the rest go on.
    const own = facts.map(f => filesRefusal([f]));
    refuse(facts.filter((_, at) => own[at] !== null), f => own[facts.indexOf(f)]!);
    const fit = files.flatMap((file, at) => (own[at] === null ? [{ file, fact: facts[at]! }] : []));
    if (fit.length === 0) return;
    const fitFacts = fit.map(f => f.fact);
    // The count is the batch's: one message carries so many files, so every file of the batch that would pass it
    // is turned away together.
    const counted = filesRefusal([...(get().pending[workspaceId] ?? NONE).map(recordOf), ...fitFacts]);
    if (counted !== null) return refuse(fitFacts, () => counted);
    const taken = await Promise.all(fit.map(({ file, fact }) => fileOf(file, fact)));
    let dropped = false;
    set(s => {
      const now = s.pending[workspaceId] ?? NONE;
      // Two adds can be in flight (a paste while a drop is still reading); the second checks the count again against
      // what the first left, and gives its own bytes back rather than putting the composer over it.
      if (filesRefusal([...now.map(recordOf), ...fitFacts]) !== null) {
        dropped = true;
        return s;
      }
      return { pending: { ...s.pending, [workspaceId]: [...now, ...taken] } };
    });
    if (!dropped) return;
    for (const file of taken) revoke(file);
    const late = filesRefusal([...(get().pending[workspaceId] ?? NONE).map(recordOf), ...fitFacts]);
    if (late !== null) refuse(fitFacts, () => late);
  },
  remove(workspaceId, id) {
    set(s => {
      const rows = s.pending[workspaceId] ?? NONE;
      const going = rows.find(r => r.id === id);
      if (going === undefined) return s;
      revoke(going);
      const kept = rows.filter(r => r.id !== id);
      const { [workspaceId]: _gone, ...rest } = s.pending;
      return { pending: kept.length === 0 ? rest : { ...s.pending, [workspaceId]: kept } };
    });
  },
  dismiss(workspaceId, id) {
    set(s => {
      const rows = s.refused[workspaceId];
      if (rows === undefined) return s;
      const kept = id === undefined ? [] : rows.filter(r => r.id !== id);
      return { refused: kept.length === 0 ? without(s.refused, workspaceId) : { ...s.refused, [workspaceId]: kept } };
    });
  },
  queue(workspaceId, rowId) {
    set(s => {
      const rows = s.pending[workspaceId] ?? NONE;
      if (rows.length === 0) return s;
      return { pending: without(s.pending, workspaceId), queued: { ...s.queued, [rowId]: rows } };
    });
  },
  unqueue(rowId) {
    const rows = get().queued[rowId] ?? NONE;
    if (rows.length > 0) set(s => ({ queued: without(s.queued, rowId) }));
    return rows;
  },
  drop(rowId) {
    releaseFiles(get().unqueue(rowId));
  },
  put(workspaceId, files) {
    if (files.length === 0) return;
    set(s => ({ pending: { ...s.pending, [workspaceId]: [...files, ...(s.pending[workspaceId] ?? NONE)] } }));
  },
  take(workspaceId) {
    const rows = get().pending[workspaceId] ?? NONE;
    if (rows.length > 0) {
      set(s => {
        const { [workspaceId]: _gone, ...rest } = s.pending;
        return { pending: rest };
      });
    }
    return rows;
  },
  sendAs(workspaceId, requestId, rowId) {
    set(s => {
      const rows = (rowId === undefined ? s.pending[workspaceId] : s.queued[rowId]) ?? NONE;
      if (rows.length === 0) return s;
      const left = rowId === undefined ? { pending: without(s.pending, workspaceId) } : { queued: without(s.queued, rowId) };
      // A tab left open all day would otherwise hold every file it ever sent; the oldest sends let go of theirs,
      // and their rows in the transcript fall back to the runtime's records, as another client's already do.
      const sent = { ...s.sent, [requestId]: rows };
      const keys = Object.keys(sent);
      for (const old of keys.slice(0, Math.max(0, keys.length - SENT_KEPT))) {
        for (const file of sent[old] ?? NONE) revoke(file);
        delete sent[old];
      }
      return { ...left, sent };
    });
  },
  restore(workspaceId, requestId, rowId) {
    set(s => {
      const rows = s.sent[requestId];
      if (rows === undefined) return s;
      const sent = without(s.sent, requestId);
      if (rowId !== undefined) return { sent, queued: { ...s.queued, [rowId]: rows } };
      return { sent, pending: { ...s.pending, [workspaceId]: [...rows, ...(s.pending[workspaceId] ?? NONE)] } };
    });
  },
}));

export function useComposerFiles(workspaceId: string): ReadonlyArray<ComposerFile> {
  return useComposerFilesStore(s => s.pending[workspaceId] ?? NONE);
}

export function useRefusedFiles(workspaceId: string): ReadonlyArray<RefusedFile> {
  return useComposerFilesStore(s => s.refused[workspaceId] ?? NO_REFUSALS);
}

/** Every queued message's files, keyed by its id. */
export function useQueuedFiles(): Readonly<Record<string, ReadonlyArray<ComposerFile>>> {
  return useComposerFilesStore(s => s.queued);
}

/** The files this tab sent under that request id, or none when the message came from another client or a reload. */
export function useSentFiles(requestId: string | undefined): ReadonlyArray<ComposerFile> {
  return useComposerFilesStore(s => (requestId === undefined ? NONE : s.sent[requestId] ?? NONE));
}
