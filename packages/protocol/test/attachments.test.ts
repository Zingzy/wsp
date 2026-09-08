// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  IMAGES_MAX,
  IMAGE_MAX_BYTES,
  imageBytes,
  imageLine,
  imagePathOn,
  imageRecord,
  imageTypeOf,
  imagesBlocked,
  imagesRefusal,
  noImagesLine,
  notAnImageLine,
  threadImagesDir,
} from "../src/index.js";

const b64 = (bytes: number): string => Buffer.alloc(bytes).toString("base64");
const png = (bytes = 1024) => ({ mediaType: "image/png", bytes: b64(bytes) });

describe("what an image weighs, from the base64 the wire carries", () => {
  it("counts the bytes back out of the base64 without decoding it, padding and all", () => {
    for (const size of [1, 2, 3, 4, 5, 1023, 1024, 1_048_577]) {
      expect(imageBytes({ bytes: b64(size) })).toBe(size);
    }
    expect(imageBytes({ bytes: "" })).toBe(0);
  });
});

describe("the caps, in the person's words", () => {
  it("a 12 MB image is refused with its weight and the cap in the sentence", () => {
    const refusal = imagesRefusal([imageRecord(png(12 * 1024 * 1024))]);
    expect(refusal).toBe("image 1 is 12.0 MB, over the 10.0 MB an image may be");
    // The cap itself is the one in the sentence, so the words cannot drift from the rule.
    expect(refusal).toContain("10.0 MB");
    expect(IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("a file the person named is refused by its own name, not by its place in the message", () => {
    expect(imagesRefusal([imageRecord({ ...png(12 * 1024 * 1024), name: "screenshot.png" })])).toBe(
      "screenshot.png is 12.0 MB, over the 10.0 MB an image may be",
    );
  });

  it("one image under the cap goes", () => {
    expect(imagesRefusal([imageRecord(png(10 * 1024 * 1024))])).toBeNull();
    expect(imagesRefusal([])).toBeNull();
  });

  it("six images are refused with both counts", () => {
    const six = Array.from({ length: IMAGES_MAX + 1 }, () => imageRecord(png()));
    expect(imagesRefusal(six)).toBe("only 5 images fit one message; this one carries 6");
  });

  it("a type no harness reads is refused naming the four that travel", () => {
    expect(imagesRefusal([imageRecord({ mediaType: "application/pdf", bytes: b64(10) })])).toBe(
      "image 1 is application/pdf; a message carries PNG, JPEG, GIF or WebP",
    );
    expect(imagesRefusal([imageRecord({ mediaType: "", bytes: b64(10) })])).toBe(
      "image 1 is of no stated type; a message carries PNG, JPEG, GIF or WebP",
    );
  });

  it("an empty image is refused rather than sent as nothing", () => {
    expect(imagesRefusal([imageRecord({ mediaType: "image/png", bytes: "" })])).toBe("image 1 is empty");
  });

  it("the first thing wrong is the whole answer: the count before any one image", () => {
    const rows = [imageRecord(png(12 * 1024 * 1024)), ...Array.from({ length: IMAGES_MAX }, () => imageRecord(png()))];
    expect(imagesRefusal(rows)).toContain("only 5 images fit one message");
  });
});

describe("an agent that reads no image is named before the machine is asked", () => {
  it("names the agent when its adapter declared no road", () => {
    expect(imagesBlocked([imageRecord(png())], undefined, "gemini")).toBe(noImagesLine("gemini"));
    expect(noImagesLine("gemini")).toContain("gemini");
  });

  it("says nothing when the message carries no image, whatever the agent reads", () => {
    expect(imagesBlocked([], undefined, "gemini")).toBeNull();
  });

  it("the caps come first, so a person fixes the image rather than the agent", () => {
    expect(imagesBlocked([imageRecord(png(12 * 1024 * 1024))], undefined, "gemini")).toContain("over the 10.0 MB");
  });

  it("an agent on either road takes them", () => {
    expect(imagesBlocked([imageRecord(png())], "inline", "claude")).toBeNull();
    expect(imagesBlocked([imageRecord(png())], "file", "codex")).toBeNull();
  });
});

describe("what a transcript prints in place of an image", () => {
  it("is the weight and the type in one bracket", () => {
    expect(imageLine({ mediaType: "image/png", bytes: 1_258_291 })).toBe("[image 1.2 MB png]");
    expect(imageLine({ mediaType: "image/jpeg", bytes: 4096 })).toBe("[image 4.0 KB jpeg]");
    expect(imageLine({ mediaType: "image/webp", bytes: 900 })).toBe("[image 900 B webp]");
  });

  it("a type outside the table still prints, by its own words", () => {
    expect(imageLine({ mediaType: "image/avif", bytes: 1024 })).toBe("[image 1.0 KB image/avif]");
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

  it("the refusal of a file that is not one of the four names the file", () => {
    expect(notAnImageLine("notes.pdf")).toBe("notes.pdf is not PNG, JPEG, GIF or WebP; a message carries those four");
  });
});

describe("where a thread's copies live on a machine", () => {
  it("one folder per thread, and one name per image by its place and its type", () => {
    expect(threadImagesDir("thr_1")).toBe("/root/.wsp/threads/thr_1/images");
    expect(imagePathOn("thr_1", 0, "image/png")).toBe("/root/.wsp/threads/thr_1/images/1.png");
    expect(imagePathOn("thr_1", 1, "image/jpeg")).toBe("/root/.wsp/threads/thr_1/images/2.jpg");
    expect(imagePathOn("thr_2", 0, "image/webp")).toBe("/root/.wsp/threads/thr_2/images/1.webp");
  });

  it("a type outside the table has no name here; the caps refusal is what turns it away", () => {
    expect(() => imagePathOn("thr_1", 0, "application/pdf")).toThrow(/not an image type/);
  });
});

describe("what a transcript keeps of an image", () => {
  it("its type, its weight and its name, never its pixels", () => {
    expect(imageRecord({ mediaType: "image/png", bytes: b64(2048), name: "shot.png" })).toEqual({
      mediaType: "image/png",
      bytes: 2048,
      name: "shot.png",
    });
    expect(imageRecord({ mediaType: "image/png", bytes: b64(2048) })).toEqual({ mediaType: "image/png", bytes: 2048 });
  });
});
