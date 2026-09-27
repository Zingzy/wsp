// SPDX-License-Identifier: AGPL-3.0-only
// The files a composer is holding, and the files a send carried, both in
// memory only. Nothing here is persisted: the draft store writes to local
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

interface FilesState {
  /** Keyed by workspace, as the draft is: what the composer will send next. */
  pending: Record<string, ReadonlyArray<ComposerFile>>;
  /** Keyed by the request id the composer minted for a send: what that message carried, for this tab's lifetime. */
  sent: Record<string, ReadonlyArray<ComposerFile>>;
  /** Adds what the person gave, answering with the refusal that turned them away, or null when every one was taken.
   * `noImages` is the line for an agent that reads no image, which turns an image away before it is read whole. */
  add(workspaceId: string, files: readonly File[], noImages?: string): Promise<string | null>;
  remove(workspaceId: string, id: string): void;
  /** Puts files the composer already read back in front of what it holds: a stash restored. */
  put(workspaceId: string, files: ReadonlyArray<ComposerFile>): void;
  /** Takes every file this workspace's composer holds, which the composer no longer shows: a stash taken. */
  take(workspaceId: string): ReadonlyArray<ComposerFile>;
  /** Moves this workspace's files onto the request id its send carried; the composer opens empty. */
  sendAs(workspaceId: string, requestId: string): void;
  /** Puts back what a refused send took, so the person's files are not lost with the request. */
  restore(workspaceId: string, requestId: string): void;
}

export const useComposerFilesStore = create<FilesState>()((set, get) => ({
  pending: {},
  sent: {},
  async add(workspaceId, files, noImages) {
    // The heads first, so a file over the cap is turned away before it is read whole.
    const facts = await Promise.all(files.map(fileFactsOf));
    if (noImages !== undefined && facts.some(f => isImage(f.mediaType))) return noImages;
    const held = get().pending[workspaceId] ?? NONE;
    const refusal = filesRefusal([...held.map(recordOf), ...facts]);
    if (refusal !== null) return refusal;
    const taken = await Promise.all(files.map((file, at) => fileOf(file, facts[at]!)));
    let dropped = false;
    set(s => {
      const now = s.pending[workspaceId] ?? NONE;
      // Two adds can be in flight (a paste while a drop is still reading); the second checks the caps again against
      // what the first left, and gives its own bytes back rather than putting the composer over them.
      if (filesRefusal([...now.map(recordOf), ...facts]) !== null) {
        dropped = true;
        return s;
      }
      return { pending: { ...s.pending, [workspaceId]: [...now, ...taken] } };
    });
    if (!dropped) return null;
    for (const file of taken) revoke(file);
    return filesRefusal([...(get().pending[workspaceId] ?? NONE).map(recordOf), ...facts]);
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
  sendAs(workspaceId, requestId) {
    set(s => {
      const rows = s.pending[workspaceId] ?? NONE;
      if (rows.length === 0) return s;
      const { [workspaceId]: _gone, ...rest } = s.pending;
      // A tab left open all day would otherwise hold every file it ever sent; the oldest sends let go of theirs,
      // and their rows in the transcript fall back to the runtime's records, as another client's already do.
      const sent = { ...s.sent, [requestId]: rows };
      const keys = Object.keys(sent);
      for (const old of keys.slice(0, Math.max(0, keys.length - SENT_KEPT))) {
        for (const file of sent[old] ?? NONE) revoke(file);
        delete sent[old];
      }
      return { pending: rest, sent };
    });
  },
  restore(workspaceId, requestId) {
    set(s => {
      const rows = s.sent[requestId];
      if (rows === undefined) return s;
      const { [requestId]: _gone, ...rest } = s.sent;
      return { sent: rest, pending: { ...s.pending, [workspaceId]: [...rows, ...(s.pending[workspaceId] ?? NONE)] } };
    });
  },
}));

export function useComposerFiles(workspaceId: string): ReadonlyArray<ComposerFile> {
  return useComposerFilesStore(s => s.pending[workspaceId] ?? NONE);
}

/** The files this tab sent under that request id, or none when the message came from another client or a reload. */
export function useSentFiles(requestId: string | undefined): ReadonlyArray<ComposerFile> {
  return useComposerFilesStore(s => (requestId === undefined ? NONE : s.sent[requestId] ?? NONE));
}
