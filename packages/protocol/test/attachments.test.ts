// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachedFilesPrompt,
  attachmentBytes,
  attachmentLine,
  attachmentRecord,
  FILE_MAX_BYTES,
  FILE_MAX_WORDS,
  FILES_DIR,
  FILES_MAX,
  filePathIn,
  filesBlocked,
  filesRefusal,
  IMAGE_MAX_BYTES,
  IMAGE_TYPES,
  IMAGE_MAX_WORDS,
  IMAGE_TYPE_WORDS,
  imagePathIn,
  imageTypeOf,
  dropFilesLine,
  landFilesLine,
  noImagesLine,
  notAFileLine,
  safeFileName,
  sendFilesDir,
  threadFilesDir,
  threadImagesDir,
  turnImagesDir,
} from "../src/index.js";

const b64 = (bytes: number): string => Buffer.alloc(bytes).toString("base64");
const png = (bytes = 1024) => ({ mediaType: "image/png", bytes: b64(bytes) });
const pdf = (bytes = 1024, name = "report.pdf") => ({ mediaType: "application/pdf", bytes: b64(bytes), name });

describe("what an attachment weighs, from the base64 the wire carries", () => {
  it("counts the bytes back out of the base64 without decoding it, padding and all", () => {
    for (const size of [1, 2, 3, 4, 5, 1023, 1024, 1_048_577]) {
      expect(attachmentBytes({ bytes: b64(size) })).toBe(size);
    }
    expect(attachmentBytes({ bytes: "" })).toBe(0);
  });
});

describe("the caps, in the person's words", () => {
  it("a 12 MB image is refused with its weight and the cap in the sentence", () => {
    const refusal = filesRefusal([attachmentRecord(png(12 * 1024 * 1024))]);
    expect(refusal).toBe("image 1 is 12 MB, over the 10 MB an image may be");
    // The cap itself is the one in the sentence, so the words cannot drift from the rule.
    expect(refusal).toContain("10 MB");
    expect(IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("a file the person named is refused by its own name, not by its place in the message", () => {
    expect(filesRefusal([attachmentRecord({ ...png(12 * 1024 * 1024), name: "screenshot.png" })])).toBe(
      "screenshot.png is 12 MB, over the 10 MB an image may be",
    );
  });

  it("one image under the cap goes", () => {
    expect(filesRefusal([attachmentRecord(png(10 * 1024 * 1024))])).toBeNull();
    expect(filesRefusal([])).toBeNull();
  });

  it("six files are refused with both counts, images and the rest counted together", () => {
    const six = [...Array.from({ length: FILES_MAX }, () => attachmentRecord(png())), attachmentRecord(pdf())];
    expect(filesRefusal(six)).toBe("only 5 files fit one message; this one carries 6");
  });

  it("a file over its cap is refused in one sentence naming it, its weight and the cap", () => {
    const refusal = filesRefusal([attachmentRecord(pdf(FILE_MAX_BYTES + 2 * 1024 * 1024, "manual.pdf"))]);
    expect(refusal).toBe(`manual.pdf is 12 MB, over the ${FILE_MAX_WORDS} a file may be`);
    expect(refusal?.split(/[.;]\s/)).toHaveLength(1);
    expect(filesRefusal([attachmentRecord(pdf(FILE_MAX_BYTES))])).toBeNull();
  });

  it("any type travels as a file, and one with no name is called by its place", () => {
    expect(filesRefusal([attachmentRecord(pdf()), attachmentRecord({ mediaType: "", bytes: b64(10) })])).toBeNull();
    expect(filesRefusal([attachmentRecord({ mediaType: "text/plain", bytes: "" })])).toBe("file 1 is empty");
  });

  it("an empty image is refused rather than sent as nothing", () => {
    expect(filesRefusal([attachmentRecord({ mediaType: "image/png", bytes: "" })])).toBe("image 1 is empty");
  });

  it("the first thing wrong is the whole answer: the count before any one image", () => {
    const rows = [attachmentRecord(png(12 * 1024 * 1024)), ...Array.from({ length: FILES_MAX }, () => attachmentRecord(png()))];
    expect(filesRefusal(rows)).toContain("only 5 files fit one message");
  });
});

describe("an agent that reads no image is named before the machine is asked", () => {
  it("names the agent when its adapter declared no road", () => {
    expect(filesBlocked([attachmentRecord(png())], undefined, "gemini")).toBe(noImagesLine("gemini"));
    expect(noImagesLine("gemini")).toContain("gemini");
  });

  it("says nothing when the message carries no image, whatever the agent reads", () => {
    expect(filesBlocked([], undefined, "gemini")).toBeNull();
    // A file that is not an image lands in the thread's folder, which every agent reads.
    expect(filesBlocked([attachmentRecord(pdf())], undefined, "gemini")).toBeNull();
  });

  it("the caps come first, so a person fixes the image rather than the agent", () => {
    expect(filesBlocked([attachmentRecord(png(12 * 1024 * 1024))], undefined, "gemini")).toContain("over the 10 MB");
  });

  it("an agent on either road takes them", () => {
    expect(filesBlocked([attachmentRecord(png())], "inline", "claude")).toBeNull();
    expect(filesBlocked([attachmentRecord(png())], "file", "codex")).toBeNull();
  });
});

describe("what a transcript prints in place of an attachment", () => {
  it("a file is its weight and its name in one bracket", () => {
    expect(attachmentLine({ mediaType: "application/pdf", bytes: 4096, name: "report.pdf" })).toBe("[file 4 KB report.pdf]");
    expect(attachmentLine({ mediaType: "text/plain", bytes: 900 })).toBe("[file 900 B]");
  });

  it("an image is the weight and the type in one bracket", () => {
    expect(attachmentLine({ mediaType: "image/png", bytes: 1_258_291 })).toBe("[image 1 MB png]");
    expect(attachmentLine({ mediaType: "image/jpeg", bytes: 4096 })).toBe("[image 4 KB jpeg]");
    expect(attachmentLine({ mediaType: "image/webp", bytes: 900 })).toBe("[image 900 B webp]");
  });

});

describe("the type read off the bytes, never off the name", () => {
  const head = (...bytes: number[]) => new Uint8Array([...bytes, ...Array.from({ length: 16 }, () => 0)]);

  it("tells the four apart by their own first bytes", () => {
    expect(imageTypeOf(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(imageTypeOf(head(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(imageTypeOf(head(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(imageTypeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
  });

  it("a RIFF that is not WebP, and anything else, is none of them", () => {
    expect(imageTypeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
    expect(imageTypeOf(head(0x25, 0x50, 0x44, 0x46))).toBeNull();
    expect(imageTypeOf(new Uint8Array([]))).toBeNull();
  });

});

describe("where a thread's copies live on a machine", () => {
  it("one folder per send under the thread's own, and one name per image by its place and its type", () => {
    expect(threadImagesDir("thr_1")).toBe("/root/.wsp/threads/thr_1/images");
    const dir = turnImagesDir("thr_1", "req_a", "minted");
    expect(dir).toBe("/root/.wsp/threads/thr_1/images/req_a");
    expect(imagePathIn(dir, 0, "image/png")).toBe("/root/.wsp/threads/thr_1/images/req_a/1.png");
    expect(imagePathIn(dir, 1, "image/jpeg")).toBe("/root/.wsp/threads/thr_1/images/req_a/2.jpg");
    expect(imagePathIn(turnImagesDir("thr_2", "req_b", "minted"), 0, "image/webp")).toBe("/root/.wsp/threads/thr_2/images/req_b/1.webp");
  });

  it("two sends of one thread never share a folder, and every send's folder is under the thread's", () => {
    expect(turnImagesDir("thr_1", "req_a", "m")).not.toBe(turnImagesDir("thr_1", "req_b", "m"));
    for (const requestId of ["req_a", undefined]) {
      expect(turnImagesDir("thr_1", requestId, "minted").startsWith(`${threadImagesDir("thr_1")}/`)).toBe(true);
    }
  });

  it("a send with no request id takes the minted name, since a shared folder would lose one send's picture", () => {
    expect(turnImagesDir("thr_1", undefined, "minted")).toBe("/root/.wsp/threads/thr_1/images/minted");
  });

  it("a request id shaped like a path is not used as one: it is a client's string and this is a path on a machine", () => {
    for (const nasty of ["../../../etc", "a/b", "..", "", ".ssh/../..", "-rf"]) {
      expect(turnImagesDir("thr_1", nasty, "minted")).toBe("/root/.wsp/threads/thr_1/images/minted");
    }
    // A plain id, whatever its shape otherwise, is the folder's name.
    expect(turnImagesDir("thr_1", "a.b-c_1", "minted")).toBe("/root/.wsp/threads/thr_1/images/a.b-c_1");
  });

  it("a type outside the table has no name here; the caps refusal is what turns it away", () => {
    expect(() => imagePathIn("/tmp/x", 0, "application/pdf")).toThrow(/not an image type/);
  });
});

describe("the words every road reads rather than spelling again", () => {
  it("the four types and the caps are each one export, and the refusals are built from them", () => {
    expect(IMAGE_TYPE_WORDS).toBe("PNG, JPEG, GIF or WebP");
    expect(Object.keys(IMAGE_TYPES)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    expect(IMAGE_MAX_WORDS).toBe("10 MB");
    expect(FILE_MAX_WORDS).toBe("10 MB");
    expect(filesRefusal([attachmentRecord({ mediaType: "image/png", bytes: b64(12 * 1024 * 1024) })])).toContain(IMAGE_MAX_WORDS);
  });

  it("a path this computer has no file at answers in a sentence, not in the reader's own error", () => {
    expect(notAFileLine("/tmp/nope.png")).toBe("there is no file at /tmp/nope.png on this computer");
  });
});

describe("where a file the person attached lands: inside the thread's own folder, and nowhere else", () => {
  it("one folder per thread under the folder's .wsp-files and one per send inside it, each named by its id where that is a plain one", () => {
    expect(FILES_DIR).toBe(".wsp-files");
    expect(threadFilesDir("/root/spoo", "thr_1")).toBe("/root/spoo/.wsp-files/thr_1");
    expect(sendFilesDir("/root/spoo", "thr_1", "req_a", "minted")).toBe("/root/spoo/.wsp-files/thr_1/req_a");
    for (const nasty of ["../../../etc", "a/b", "..", "", "-rf"]) {
      expect(sendFilesDir("/root/spoo", "thr_1", nasty, "minted")).toBe("/root/spoo/.wsp-files/thr_1/minted");
      expect(threadFilesDir("/root/spoo", nasty)).toBe("/root/spoo/.wsp-files/thread");
    }
  });

  it("a name is one plain path segment, whatever the client sent", () => {
    expect(safeFileName("report.pdf")).toBe("report.pdf");
    expect(safeFileName("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(safeFileName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName(".bashrc")).toBe("bashrc");
    expect(safeFileName("a b\u0000c$(rm).txt")).toBe("a-b-c--rm-.txt");
    expect(safeFileName(undefined)).toBe("file");
    expect(safeFileName(`${"x".repeat(300)}.log`)).toBe(`${"x".repeat(116)}.log`);
  });

  it("two files of one name in one send each keep their own path", () => {
    const dir = "/root/spoo/.wsp-files/req_a";
    const taken = new Set<string>();
    expect(filePathIn(dir, "notes.txt", taken)).toBe(`${dir}/notes.txt`);
    expect(filePathIn(dir, "notes.txt", taken)).toBe(`${dir}/2-notes.txt`);
    for (const name of ["../x", "/etc/passwd", "..", "a/../../b"]) expect(filePathIn(dir, name, taken).startsWith(`${dir}/`)).toBe(true);
  });

  it("run for real in a checkout, the landing keeps git's status clean through the copy's own exclude, never a .gitignore", () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-files-"));
    try {
      const copy = join(root, "my copy");
      mkdirSync(copy);
      const git = (...args: string[]) => spawnSync("git", args, { cwd: copy, encoding: "utf8" });
      git("init", "-q");
      const run = (dir: string) => spawnSync("bash", ["-c", landFilesLine(copy, dir)]).status;
      expect(run(sendFilesDir(copy, "thr_1", "req_a", "m"))).toBe(0);
      expect(run(sendFilesDir(copy, "thr_1", "req_b", "m"))).toBe(0);
      writeFileSync(join(sendFilesDir(copy, "thr_1", "req_a", "m"), "report.pdf"), "%PDF");
      expect(git("status", "--porcelain").stdout).toBe("");
      expect(readFileSync(join(copy, ".git", "info", "exclude"), "utf8").split("\n").filter(line => line === ".wsp-files/")).toHaveLength(1);
      expect(existsSync(join(copy, ".gitignore"))).toBe(false);
      expect(existsSync(join(copy, ".wsp-files", ".gitignore"))).toBe(false);
      // The same send's folder is never reused: a second landing into it is refused.
      expect(run(sendFilesDir(copy, "thr_1", "req_a", "m"))).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run for real, it lands in a folder that is no checkout, and refuses every link that would carry the files out of the copy", () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-files-"));
    try {
      const plain = join(root, "plain");
      mkdirSync(plain);
      expect(spawnSync("bash", ["-c", landFilesLine(plain, sendFilesDir(plain, "thr_1", "req_a", "m"))]).status).toBe(0);
      const outside = join(root, "outside");
      mkdirSync(outside);
      const planted = join(root, "planted");
      mkdirSync(planted);
      symlinkSync(outside, join(planted, ".wsp-files"));
      expect(spawnSync("bash", ["-c", landFilesLine(planted, sendFilesDir(planted, "thr_1", "req_b", "m"))]).status).not.toBe(0);
      const thread = join(root, "thread");
      mkdirSync(join(thread, ".wsp-files"), { recursive: true });
      symlinkSync(outside, join(thread, ".wsp-files", "thr_1"));
      expect(spawnSync("bash", ["-c", landFilesLine(thread, sendFilesDir(thread, "thr_1", "req_c", "m"))]).status).not.toBe(0);
      // An exclude file planted as a link is not written through.
      const linked = join(root, "linked");
      mkdirSync(linked);
      spawnSync("git", ["init", "-q"], { cwd: linked });
      const bait = join(outside, "bait");
      writeFileSync(bait, "");
      rmSync(join(linked, ".git", "info", "exclude"), { force: true });
      symlinkSync(bait, join(linked, ".git", "info", "exclude"));
      spawnSync("bash", ["-c", landFilesLine(linked, sendFilesDir(linked, "thr_1", "req_d", "m"))]);
      expect(readFileSync(bait, "utf8")).toBe("");
      expect(readdirSync(outside).sort()).toEqual(["bait"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run for real, dropping a thread's files takes its folder alone, and a .wsp-files that is a link is left untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-files-"));
    try {
      const copy = join(root, "copy");
      for (const thread of ["thr_1", "thr_2"]) mkdirSync(sendFilesDir(copy, thread, "req_a", "m"), { recursive: true });
      expect(spawnSync("bash", ["-c", dropFilesLine(copy, ["thr_1", "../../outside"])]).status).toBe(0);
      expect(readdirSync(join(copy, ".wsp-files"))).toEqual(["thr_2"]);
      const outside = join(root, "outside");
      mkdirSync(join(outside, "thr_2"), { recursive: true });
      const planted = join(root, "planted");
      mkdirSync(planted);
      symlinkSync(outside, join(planted, ".wsp-files"));
      spawnSync("bash", ["-c", dropFilesLine(planted, ["thr_2"])]);
      expect(existsSync(join(outside, "thr_2"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the agent's prompt names every landed path under the words the person typed", () => {
    expect(attachedFilesPrompt("what is in these?", ["/root/spoo/.wsp-files/req_a/report.pdf", "/root/spoo/.wsp-files/req_a/pasted-text-1.txt"])).toBe(
      "what is in these?\n\nAttached files:\n- /root/spoo/.wsp-files/req_a/report.pdf\n- /root/spoo/.wsp-files/req_a/pasted-text-1.txt",
    );
    expect(attachedFilesPrompt("hi", [])).toBe("hi");
  });
});

describe("what a transcript keeps of an attachment", () => {
  it("its type, its weight and its name, never its pixels", () => {
    expect(attachmentRecord({ mediaType: "image/png", bytes: b64(2048), name: "shot.png" })).toEqual({
      mediaType: "image/png",
      bytes: 2048,
      name: "shot.png",
    });
    expect(attachmentRecord({ mediaType: "image/png", bytes: b64(2048) })).toEqual({ mediaType: "image/png", bytes: 2048 });
  });
});
