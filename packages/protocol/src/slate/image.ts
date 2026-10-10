// SPDX-License-Identifier: AGPL-3.0-only
// Where a slate's image comes from and the sentences that refuse one. A path names a file on the thread's computer,
// anywhere on it, read by the host or by that computer's daemon; an http(s) address is fetched by the host once the
// person allows its domain for the thread, never by the window. Either way the bytes must say one of the image types
// and weigh at most the cap, so a key or an environment file never shows: it is not an image.
import { IMAGE_MAX_BYTES, IMAGE_TYPE_WORDS } from "../attachments.js";
import { fmtBytes, fmtBytesOver } from "../format.js";
import { slateProblem } from "./problems.js";
import type { SlateProblem } from "./types.js";

export const SLATE_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;

/** The layouts of several images. */
export const SLATE_IMAGE_LAYOUTS = ["strip", "gallery", "compare"] as const;

export type SlateImageSource = { path: string } | { url: string; domain: string } | { problem: SlateProblem };

/** A src read as a path on the thread's computer or an http(s) address with its domain, or the problem that refuses
 * it. A relative path is read under the thread's folder; `~` is not expanded, since the host and the thread's
 * computer may not share a home. */
export function slateImageSource(src: string): SlateImageSource {
  const said = src.trim();
  if (said === "") return { problem: slateProblem("R900", "an image names no file; give a path such as /tmp/home.png or an https address") };
  if (/^[a-z][a-z0-9+.-]*:/i.test(said) && !/^[a-z]:[\\/]/i.test(said)) {
    let url: URL;
    try {
      url = new URL(said);
    } catch {
      return { problem: slateAddressRefused(said, "is not an address wsp can read") };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: slateAddressRefused(said, "is not an http or https address; an image is a path on the thread's computer or a web address") };
    if (url.username !== "" || url.password !== "") return { problem: slateAddressRefused(said, "carries a login, which wsp never sends") };
    return { url: url.href, domain: url.hostname.toLowerCase() };
  }
  if (said.startsWith("~")) return { problem: slateProblem("R900", `${said} starts at a home folder, which wsp does not guess; write the whole path`) };
  return { path: said };
}

/** The refusal of a file over the cap, said with its size, or with the cap alone where the bytes stopped coming at it. */
export const slateImageTooBig = (where: string, bytes?: number): SlateProblem =>
  slateProblem("R915", `${where} is ${bytes === undefined ? "more than" : `${fmtBytesOver(bytes)}, over`} the ${fmtBytes(SLATE_IMAGE_MAX_BYTES)} an image may weigh; save it smaller, or show a part of it`);

/** The refusal of bytes that are none of the image types: an SVG is named, since it is a document that can load
 * other things, and the fix is a picture of it. */
export const slateNotAnImage = (where: string, svg = false): SlateProblem =>
  slateProblem("R916", svg ? `${where} is an SVG, which a slate does not show since it can load other things; save it as a PNG` : `${where} is not a ${IMAGE_TYPE_WORDS} image`);

/** Whether the first bytes of something that is not an image read as an SVG document. */
export function slateLooksSvg(where: string, head: Uint8Array): boolean {
  if (/\.svgz?$/i.test(where.split(/[?#]/)[0] ?? "")) return true;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(0, 1024)).toLowerCase();
  return /<svg[\s>]/.test(text);
}

/** A path that names nothing. */
export const slateImageMissing = (path: string): SlateProblem => slateProblem("R900", `no file at ${path}`);

/** A path that names a folder, a device, a pipe or a socket. */
export const slateImageNotAFile = (path: string): SlateProblem => slateProblem("R914", `${path} is not a file; an image is a regular file`);

/** An address the host will not fetch, with why. */
export const slateAddressRefused = (url: string, why: string): SlateProblem => slateProblem("R917", `${url} ${why}`);

/** A list longer than its piece draws, which draws none of it; bind names the list where it is bound. */
export const slateListTooLong = (count: number, most: number, noun: string, bind?: string): SlateProblem =>
  slateProblem("R905", `this list holds ${count} ${noun} and a slate shows at most ${most}, so it shows none; show a page of them${bind === undefined ? "" : `, like items={${bind} | take(${most})}`}`);
