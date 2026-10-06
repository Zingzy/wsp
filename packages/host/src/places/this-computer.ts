// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { type MacKind, macKindOf } from "@wsp/protocol";
import { keyFingerprint } from "@wsp/engine";
import { newPlaceKeyPair, type HerePlace, type PlaceKeyPair } from "@wsp/runtime";
import { writeOwn } from "@wsp/own-file";
import { placeFacts } from "../place-report.js";

/** What this computer is called when the person named no name: its own name lowercased, which is what they would
 * type for it on a command line. The one reading, so the row for this computer and the name a join writes agree. */
export const placeNameHere = (): string => hostname().toLowerCase();

/** What this computer calls itself to a computer that joins it: its own name without the .local a Mac's mDNS name
 * carries, which is the word a person reads on the joined computer from then on. */
export const hostNameHere = (): string => hostname().replace(/\.local$/i, "");

/** Where the host keeps its own ed25519 pair: beside the state file it serves, at the person's own mode, so a
 * second state file on one computer is a second wsp with a key of its own. */
export const hostPlaceKeyPath = (statePath: string): string => join(dirname(statePath), "place-host-key.json");

const isKeyPair = (v: unknown): v is PlaceKeyPair => {
  const k = v as PlaceKeyPair | undefined;
  return typeof k === "object" && k !== null && typeof k.publicKey === "string" && typeof k.privateKeyPem === "string";
};

/** The host's pair, made on the first read and kept. It is the key every place on this host pinned at its join, so
 * losing it means every one of them has to be removed and joined again: it is written once and never rotated here. */
export function hostPlaceKey(statePath: string): PlaceKeyPair {
  const path = hostPlaceKeyPath(statePath);
  if (existsSync(path)) {
    try {
      const held: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isKeyPair(held)) return held;
    } catch {
      // A file that is there and is not a pair is not one this host wrote; a fresh pair goes over it, and every
      // place that pinned the old one refuses the link and says to join again.
    }
  }
  const made = newPlaceKeyPair();
  writeOwn(dirname(path), basename(path), `${JSON.stringify(made, null, 2)}\n`);
  return made;
}

/** The fingerprint of the key the host on this computer proves at a join, read off the pair it signs with. The
 * join line carries it so the computer being joined can tell that host from anything else that answers at the
 * address it dials. */
export const hostKeyHere = (statePath: string): string => keyFingerprint(hostPlaceKey(statePath).publicKey);

/** What this computer is, as a row of the list of everywhere work can run: read off the same report a place sends
 * about itself. The one reading, so the row a host keeps for the computer it runs on and the facts a computer is
 * shown right after it joined somebody else's wsp cannot describe the same computer differently. */
/** The name the person gave this Mac in System Settings, read once; elsewhere a computer keeps none worth drawing. */
let labelHere: string | undefined | null = null;
export function placeLabelHere(): string | undefined {
  if (labelHere !== null) return labelHere;
  labelHere = undefined;
  if (platform() !== "darwin") return labelHere;
  try {
    const said = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
    if (said !== "") labelHere = said;
  } catch {
    labelHere = undefined;
  }
  return labelHere;
}

/** The product name out of `ioreg -arc IOPlatformDevice -k product-name`, whose plist carries it as base64 bytes. */
export function productNameOf(ioreg: string): string | undefined {
  const data = /<key>product-name<\/key>\s*<data>\s*([A-Za-z0-9+/=\s]+?)\s*<\/data>/.exec(ioreg)?.[1];
  if (data === undefined) return undefined;
  const name = Buffer.from(data.replace(/\s+/g, ""), "base64").toString("utf8").replace(/\0+$/, "").trim();
  return name === "" ? undefined : name;
}

/** Which Mac this is, read once: an Intel Mac's registry names no product, and its model identifier says it. */
let macHere: MacKind | undefined | null = null;
export function placeMacHere(): MacKind | undefined {
  if (macHere !== null) return macHere;
  macHere = undefined;
  if (platform() !== "darwin") return macHere;
  const read = (file: string, args: string[]): string => {
    try {
      return execFileSync(file, args, { encoding: "utf8", timeout: 2000 });
    } catch {
      return "";
    }
  };
  macHere = macKindOf(productNameOf(read("ioreg", ["-arc", "IOPlatformDevice", "-k", "product-name"])) ?? "") ?? macKindOf(read("sysctl", ["-n", "hw.model"]).trim());
  return macHere;
}

/** What a window names this computer by: the name its owner gave it, else its hostname, the one reading the host's
 * own row of the places list gives the app. */
export const computerNameHere = (): string => placeLabelHere() ?? placeNameHere();

export function placeHere(name: string = placeNameHere()): HerePlace {
  const report = placeFacts({ name });
  const label = placeLabelHere();
  const mac = placeMacHere();
  return { name: report.name, ...(label !== undefined ? { label } : {}), ...(mac !== undefined ? { mac } : {}), os: report.os, shape: report.shape, engine: report.engine, ...(report.diskFreeBytes !== undefined ? { diskFreeBytes: report.diskFreeBytes } : {}) };
}
