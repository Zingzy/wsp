// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { refusal, sharedLibrariesNamed } from "../scripts/daemon-binary.mjs";

interface Shape {
  /** The libraries the dynamic segment names as needed. */
  needed?: string[];
  /** Whether the file carries a dynamic segment at all; a plain static binary carries none. */
  dynamic?: boolean;
  /** Whether the file carries a section header table; a strip may leave the header's section fields at zero. */
  sections?: boolean;
}

/** A 64-bit little-endian ELF file laid out as the loader reads it: a program header table with one PT_LOAD over
 * the whole file and, when it is dynamic, a PT_DYNAMIC segment whose entries name the string table and the needed
 * libraries. The section header table, when there is one, describes the same string table and dynamic array. */
function elf({ needed = [], dynamic = true, sections = true }: Shape = {}): Buffer {
  const headerSize = 64;
  const segmentCount = dynamic ? 2 : 1;
  const programAt = headerSize;
  const stringsAt = programAt + 56 * segmentCount;
  const strings = Buffer.from(`\0${needed.map(n => `${n}\0`).join("")}`);
  const dynamicAt = stringsAt + strings.length;
  const entries: [bigint, bigint][] = [];
  let offset = 1;
  for (const name of needed) {
    entries.push([1n, BigInt(offset)]);
    offset += name.length + 1;
  }
  entries.push([5n, BigInt(stringsAt)], [0n, 0n]);
  const dynamicBytes = Buffer.alloc(dynamic ? 16 * entries.length : 0);
  entries.forEach(([tag, value], i) => {
    if (!dynamic) return;
    dynamicBytes.writeBigInt64LE(tag, i * 16);
    dynamicBytes.writeBigUInt64LE(value, i * 16 + 8);
  });
  const sectionsAt = dynamicAt + dynamicBytes.length;
  const sectionBytes = Buffer.alloc(sections ? 64 * 3 : 0);
  const total = sectionsAt + sectionBytes.length;
  const program = Buffer.alloc(56 * segmentCount);
  const segment = (i: number, type: number, at: number, size: number) => {
    program.writeUInt32LE(type, i * 56);
    program.writeBigUInt64LE(BigInt(at), i * 56 + 8);
    program.writeBigUInt64LE(BigInt(at), i * 56 + 16);
    program.writeBigUInt64LE(BigInt(size), i * 56 + 32);
  };
  segment(0, 1, 0, total);
  if (dynamic) segment(1, 2, dynamicAt, dynamicBytes.length);
  if (sections) {
    const section = (i: number, type: number, at: number, size: number, link: number) => {
      sectionBytes.writeUInt32LE(type, i * 64 + 4);
      sectionBytes.writeBigUInt64LE(BigInt(at), i * 64 + 0x18);
      sectionBytes.writeBigUInt64LE(BigInt(size), i * 64 + 0x20);
      sectionBytes.writeUInt32LE(link, i * 64 + 0x28);
    };
    section(1, 3, stringsAt, strings.length, 0);
    if (dynamic) section(2, 6, dynamicAt, dynamicBytes.length, 1);
  }
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2;
  header[5] = 1;
  header.writeBigUInt64LE(BigInt(programAt), 0x20);
  header.writeUInt16LE(56, 0x36);
  header.writeUInt16LE(segmentCount, 0x38);
  if (sections) {
    header.writeBigUInt64LE(BigInt(sectionsAt), 0x28);
    header.writeUInt16LE(64, 0x3a);
    header.writeUInt16LE(3, 0x3c);
  }
  return Buffer.concat([header, program, strings, dynamicBytes, sectionBytes]);
}

describe("the daemon binary staged for a Linux target is static", () => {
  it("reads the shared libraries a binary names off its dynamic segment, and none off a static one", () => {
    expect(sharedLibrariesNamed(elf({ needed: ["libseccomp.so.2", "libc.so.6"] }))).toEqual(["libseccomp.so.2", "libc.so.6"]);
    expect(sharedLibrariesNamed(elf({ needed: [] }))).toEqual([]);
    expect(sharedLibrariesNamed(elf({ dynamic: false }))).toEqual([]);
    expect(() => sharedLibrariesNamed(Buffer.from("#!/bin/sh\n"))).toThrow("not a 64-bit little-endian ELF file");
  });

  it("reads the loader's headers, so a binary stripped of its section table still names what it loads", () => {
    const stripped = elf({ needed: ["libseccomp.so.2"], sections: false });
    expect(stripped.readBigUInt64LE(0x28)).toBe(0n);
    expect(stripped.readUInt16LE(0x3c)).toBe(0);
    expect(sharedLibrariesNamed(stripped)).toEqual(["libseccomp.so.2"]);
  });

  it("refuses a musl binary that names a shared library, in a sentence naming the library and where to build", () => {
    const why = refusal("/build/wsp-daemon", "x86_64-unknown-linux-musl", elf({ needed: ["libseccomp.so.2"] }));
    expect(why).toBe("/build/wsp-daemon names shared libraries (libseccomp.so.2) and the Linux daemon is one static binary that loads none: build it in daemon/, where libseccomp links statically");
    expect(refusal("/build/wsp-daemon", "aarch64-unknown-linux-musl", elf({ needed: ["libseccomp.so.2"], sections: false }))).toContain("libseccomp.so.2");
  });

  it("places a plain static binary, one whose dynamic segment names nothing, and a Mac binary without reading it as ELF", () => {
    expect(refusal("/build/wsp-daemon", "x86_64-unknown-linux-musl", elf({ dynamic: false }))).toBeUndefined();
    expect(refusal("/build/wsp-daemon", "x86_64-unknown-linux-musl", elf({ needed: [] }))).toBeUndefined();
    expect(refusal("/build/wsp-daemon", "aarch64-apple-darwin", Buffer.from("\xcf\xfa\xed\xfe"))).toBeUndefined();
  });
});
