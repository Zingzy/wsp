// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture provenance: hand-written in the proc(5) layouts. A fake /proc tree is
// built per test so the sampler's real read path runs on darwin; the uid comes
// from the directories' owner, which is whoever runs the test.

export interface FakeProc {
  pid: number;
  ppid?: number;
  comm?: string;
  state?: string;
  /** utime and stime in clock ticks. */
  ticks?: [number, number];
  threads?: number;
  /** Clock ticks after boot. */
  starttime?: number;
  /** Resident pages. */
  rss?: number;
  cmdline?: string[];
  cwd?: string;
  socketInodes?: number[];
}

export const BTIME = 1_757_000_000;
const AT_PAGESZ = 6;

export function auxv(pageSize: number): Buffer {
  const b = Buffer.alloc(48);
  b.writeBigUInt64LE(BigInt(33), 0);
  b.writeBigUInt64LE(BigInt(0x7fff), 8);
  b.writeBigUInt64LE(BigInt(AT_PAGESZ), 16);
  b.writeBigUInt64LE(BigInt(pageSize), 24);
  return b;
}

function statLine(p: FakeProc): string {
  const [utime, stime] = p.ticks ?? [0, 0];
  const head = [p.state ?? "S", p.ppid ?? 0, 1, 1, 0, -1, 4194560, 10, 0, 0, 0, utime, stime, 0, 0, 20, 0, p.threads ?? 1, 0, p.starttime ?? 100, 1_000_000, p.rss ?? 10];
  const tail = new Array(28).fill(0);
  return `${p.pid} (${p.comm ?? `p${p.pid}`}) ${[...head, ...tail].join(" ")}\n`;
}

export function writeProc(root: string, p: FakeProc): void {
  const dir = join(root, String(p.pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stat"), statLine(p));
  writeFileSync(join(dir, "cmdline"), (p.cmdline ?? [p.comm ?? `p${p.pid}`]).join("\0") + "\0");
  if (p.cwd !== undefined) {
    rmSync(join(dir, "cwd"), { force: true });
    symlinkSync(p.cwd, join(dir, "cwd"));
  }
  if (p.socketInodes) {
    mkdirSync(join(dir, "fd"), { recursive: true });
    p.socketInodes.forEach((inode, i) => symlinkSync(`socket:[${inode}]`, join(dir, "fd", String(3 + i))));
  }
}

export function fakeProcTree(procs: FakeProc[], pageSize = 4096): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-fake-proc-"));
  writeFileSync(join(root, "stat"), `cpu  1 2 3 4 5 6 7 8 0 0\nbtime ${BTIME}\nprocesses 100\n`);
  mkdirSync(join(root, "self"));
  writeFileSync(join(root, "self", "auxv"), auxv(pageSize));
  mkdirSync(join(root, "net"));
  writeFileSync(join(root, "net", "tcp"), "");
  writeFileSync(join(root, "net", "tcp6"), "");
  for (const p of procs) writeProc(root, p);
  return root;
}

const uid = process.getuid?.() ?? 0;
export function fakePasswd(): string {
  const path = join(mkdtempSync(join(tmpdir(), "wsp-fake-passwd-")), "passwd");
  writeFileSync(path, `root:x:0:0:root:/root:/bin/bash\ntester:x:${uid}:${uid}::/home/tester:/bin/sh\n`);
  return path;
}
