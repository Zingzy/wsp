// SPDX-License-Identifier: AGPL-3.0-only
// One file on its way from a person's clipboard to an agent's turn: what the
// wire carries, the types and caps every road checks it against, the words a
// refusal says, and the line a transcript prints for one. An image travels on
// the road its harness declared; any other file lands in the thread's own
// folder and the prompt names where. The composer, the command line and the
// MCP server check here before a byte leaves this computer, and the runtime
// checks again before it asks a machine, so a road that skipped the check
// cannot land a file on a machine. The image types a harness takes are the
// same four everywhere, so they sit here once and the adapters read them.
import { z } from "zod";
import type { AttachmentRoad } from "./adapter-port.js";
import { GUEST_WSP_HOME } from "./daemon-contract.js";
import { fmtBytes } from "./format.js";
import { shellQuote } from "./shell-quote.js";

/** The image types a message carries, each with the word a transcript prints and the extension its copy on a machine
 * lands under. A type outside this table is refused before it travels: the harnesses take these four. */
export const IMAGE_TYPES: Readonly<Record<string, { word: string; ext: string }>> = {
  "image/png": { word: "png", ext: "png" },
  "image/jpeg": { word: "jpeg", ext: "jpg" },
  "image/gif": { word: "gif", ext: "gif" },
  "image/webp": { word: "webp", ext: "webp" },
};

/** What one image may weigh. A harness reads an image whole into its request, and the bytes travel base64 on our own
 * wire, so the cap bounds both. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** What one file that is not an image may weigh. Five of them travel base64 in one message on the host's socket,
 * which takes 100 MiB a message, so the cap is the image's. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;

/** How many files one message carries, images among them. */
export const FILES_MAX = 5;

/** One file as the wire carries it: its type and the bytes themselves, base64. The name is what the person's file or
 * paste was called: the transcript's words for an image, and the name a file lands under, made plain first. */
export const Attachment = z.object({
  mediaType: z.string(),
  bytes: z.string(),
  name: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

/** The type a file travels under where nothing says what it is: its own name is what the agent reads it by. */
export const UNTYPED_FILE = "application/octet-stream";

/** Whether this type travels as an image, on its harness's own road, rather than landing as a file. */
export const isImage = (mediaType: string): boolean => IMAGE_TYPES[mediaType] !== undefined;

/** What an attachment weighs, from the base64 the wire carries, without decoding it. */
export function attachmentBytes(image: { bytes: string }): number {
  const b64 = image.bytes;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
}

/** One file of a person's message as a transcript keeps it: what it was, what it weighed and what it was called.
 * The bytes are not here. They go to the machine and nowhere else, so a transcript costs the same however large the
 * file was, and none of it is written to this computer's disk. */
export const AttachmentRecord = z.object({
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
  name: z.string().optional(),
});
export type AttachmentRecord = z.infer<typeof AttachmentRecord>;

/** What a transcript keeps of one file the wire carried. */
export function attachmentRecord(file: Attachment): AttachmentRecord {
  return { mediaType: file.mediaType, bytes: attachmentBytes(file), ...(file.name !== undefined ? { name: file.name } : {}) };
}

/** The four types as a person reads them, in one string. Every sentence that names what a message carries reads this
 * rather than spelling the list again: a fifth type is then one row in IMAGE_TYPES and this line. */
export const IMAGE_TYPE_WORDS = "PNG, JPEG, GIF or WebP";

/** The size cap as a person reads it. Every sentence that names the cap reads this rather than spelling a number
 * beside it, so the words a person is told and the rule the code enforces cannot drift apart. */
export const IMAGE_MAX_WORDS = fmtBytes(IMAGE_MAX_BYTES);
export const FILE_MAX_WORDS = fmtBytes(FILE_MAX_BYTES);

/** The first bytes each of the four types starts with; WebP's is a RIFF header whose length comes before the word
 * that names the format, so its check is the head and a second run eight bytes in. */
const MAGIC: readonly { mediaType: string; head: readonly number[]; at8?: readonly number[] }[] = [
  { mediaType: "image/png", head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", head: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", head: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: "image/webp", head: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

/** What image these bytes are, read off the bytes themselves and never off a file's name, which lies; null when they
 * are none of the four. The command line and the MCP server read a person's file with this, so a screenshot saved
 * as .txt still travels as an image and a .png that is a PDF travels as a file. */
export function imageTypeOf(bytes: Uint8Array): string | null {
  const starts = (at: number, want: readonly number[]): boolean => want.every((byte, i) => bytes[at + i] === byte);
  return MAGIC.find(m => starts(0, m.head) && (m.at8 === undefined || starts(8, m.at8)))?.mediaType ?? null;
}

/** The refusal of a path the person named that this computer has no file at, or has something other than a file at:
 * the road answers in a sentence, as every other refusal on it does, rather than in the reader's own error. */
export function notAFileLine(path: string): string {
  return `there is no file at ${path} on this computer`;
}

/** What a transcript prints in place of an attachment, in one bracket: an image's weight and type, a file's weight
 * and name. The command line prints this on the person's turn, and the app wherever it has nothing of its own to
 * draw. */
export function attachmentLine(file: AttachmentRecord): string {
  const type = IMAGE_TYPES[file.mediaType];
  if (type !== undefined) return `[image ${fmtBytes(file.bytes)} ${type.word}]`;
  return `[file ${fmtBytes(file.bytes)}${file.name !== undefined ? ` ${file.name}` : ""}]`;
}

/** Why these files cannot travel, in the person's words, or null when they can: too many for one message, one over
 * its cap, or an empty one. The first thing wrong is the whole answer, since a person fixes one file at a time. Takes
 * the records, so a road that has the file's size and not its bytes yet (the command line reading a path) asks the
 * same question as one holding the bytes. */
export function filesRefusal(files: readonly AttachmentRecord[]): string | null {
  if (files.length > FILES_MAX) return `only ${FILES_MAX} files fit one message; this one carries ${files.length}`;
  for (const [index, file] of files.entries()) {
    const image = isImage(file.mediaType);
    const at = file.name ?? `${image ? "image" : "file"} ${index + 1}`;
    if (file.bytes === 0) return `${at} is empty`;
    if (image && file.bytes > IMAGE_MAX_BYTES) return `${at} is ${fmtBytes(file.bytes)}, over the ${IMAGE_MAX_WORDS} an image may be`;
    if (!image && file.bytes > FILE_MAX_BYTES) return `${at} is ${fmtBytes(file.bytes)}, over the ${FILE_MAX_WORDS} a file may be`;
  }
  return null;
}

/** The refusal of a message with a file while the thread's turn is still running: a queued row keeps only its words,
 * so the files would leave the composer and reach nothing. */
export const FILES_AFTER_TURN = "the thread's turn is still running; a file goes with a message that starts a turn, so wait for this one to end";

/** The refusal of a message with an image to an agent that takes none, said before the machine is asked. */
export function noImagesLine(harness: string): string {
  return `${harness} takes no image with a message; describe it in words, or open the thread on an agent that reads images`;
}

/** Why these files cannot go to this agent, or null when they can: the caps first, since a person fixes those
 * whatever the agent is, then the agent itself, whose adapter may read no image at all; a file that is not an image
 * lands in the thread's folder, which every agent reads. Every road that carries a file asks this before a machine is
 * asked for anything: the composer before the send, the command line and the MCP server before the request, and the
 * runtime again before the turn. */
export function filesBlocked(files: readonly AttachmentRecord[], road: AttachmentRoad | undefined, harness: string): string | null {
  if (files.length === 0) return null;
  return filesRefusal(files) ?? (road === undefined && files.some(f => isImage(f.mediaType)) ? noImagesLine(harness) : null);
}

/** Where one thread's image copies live on a machine: every send of that thread has a folder under this one, so a
 * thread's copies go together and removing the thread removes all of them at once. Under the folder the daemon
 * inside a machine keeps its own files in, which on a computer somebody joined is the workspace's own. */
export function threadImagesDir(threadId: string): string {
  return `${GUEST_WSP_HOME}/threads/${threadId}/images`;
}

/** A folder name that is one path segment and nothing else. A request id is a string a client chose, and it travels
 * into a path on a machine, so one shaped like anything else is not used. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Where one send's images live on a machine: its own folder under its thread's, named by the request id the client
 * minted for it, so two sends on one thread never write to the same path and the first turn cannot be handed the
 * second's picture. `minted` stands in when the send carried no request id, and when the one it carried is not a
 * plain id, since that string would otherwise be a path of the client's choosing. */
export function turnImagesDir(threadId: string, requestId: string | undefined, minted: string): string {
  const name = requestId !== undefined && PLAIN_ID.test(requestId) ? requestId : minted;
  return `${threadImagesDir(threadId)}/${name}`;
}

/** Where one image of a message lands inside its send's folder: named by its place in the message and its own type,
 * so the folder read in order is the message read in order. A type outside the table has no name here, since it
 * lands as a file, and this throws for a caller that never asked. */
export function imagePathIn(dir: string, index: number, mediaType: string): string {
  const type = IMAGE_TYPES[mediaType];
  if (type === undefined) throw new Error(`${mediaType} is not an image type a message carries`);
  return `${dir}/${index + 1}.${type.ext}`;
}

/** The folder a thread's attached files land in, under the folder the thread works in: inside the copy, where the
 * agent reads at any access, and ignored by git through the .gitignore the landing leaves in it. */
export const FILES_DIR = ".wsp-files";

/** Where one send's files land: its own folder under the thread folder's FILES_DIR, named by the request id the
 * client minted where that is a plain id, for the reason turnImagesDir gives. */
export function sendFilesDir(folder: string, requestId: string | undefined, minted: string): string {
  const name = requestId !== undefined && PLAIN_ID.test(requestId) ? requestId : minted;
  return `${folder.replace(/\/+$/, "")}/${FILES_DIR}/${name}`;
}

/** The longest name a file lands under, its extension kept. */
const FILE_NAME_MAX = 120;

/** A file's name as one plain path segment: the last segment of what the client sent, every character outside a
 * plain set made a dash and no leading dot, so it can name nothing outside its send's folder and no hidden file. */
export function safeFileName(name: string | undefined): string {
  const last = (name ?? "").split(/[\\/]/).at(-1) ?? "";
  const plain = last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  if (plain.replace(/[.-]/g, "") === "") return "file";
  if (plain.length <= FILE_NAME_MAX) return plain;
  const dot = plain.lastIndexOf(".");
  const ext = dot > 0 && plain.length - dot <= 10 ? plain.slice(dot) : "";
  return plain.slice(0, FILE_NAME_MAX - ext.length) + ext;
}

/** Where one file lands in its send's folder: under its own plain name, and a second file of the same name in that
 * send under that name led by its place, so neither overwrites the other. `taken` is the send's names so far. */
export function filePathIn(dir: string, name: string | undefined, taken: Set<string>): string {
  const plain = safeFileName(name);
  let landed = plain;
  for (let n = 2; taken.has(landed); n++) landed = `${n}-${plain}`;
  taken.add(landed);
  return `${dir}/${landed}`;
}

/** The one command that readies a send's folder before its files land: the thread folder's FILES_DIR is refused where
 * it is a link, since the bytes would follow it out of the copy, a .gitignore of * goes in once so git lists none of
 * it, and the send's own folder is made fresh, never one already there. */
export function landFilesLine(folder: string, dir: string): string {
  const ignore = `${FILES_DIR}/.gitignore`;
  return `cd ${shellQuote(folder)} && [ ! -L ${FILES_DIR} ] && mkdir -p ${FILES_DIR} && { [ -e ${ignore} ] || [ -L ${ignore} ] || printf '*\\n' > ${ignore}; } && mkdir ${shellQuote(dir)}`;
}

/** The refusal of a message whose files could not land in the thread's folder: its FILES_DIR is a link, or the
 * folder is not one this machine can write in. */
export function filesNotLandedLine(folder: string): string {
  return `the attached files could not land in ${folder}/${FILES_DIR}; make sure it is a folder the agent can write in, not a link, and send again`;
}

/** The prompt the agent is handed for a message with files: the person's words, then every landed path. */
export function attachedFilesPrompt(prompt: string, paths: readonly string[]): string {
  return paths.length === 0 ? prompt : `${prompt}\n\nAttached files:\n${paths.map(p => `- ${p}`).join("\n")}`;
}
