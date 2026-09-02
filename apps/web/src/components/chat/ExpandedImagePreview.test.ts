// Adapted from pingdotgg/t3code apps/web/src/components/chat/ExpandedImagePreview.test.ts at 57a66608 (MIT).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildExpandedImagePreview, type ComposerFileAttachment } from "./ExpandedImagePreview";

describe("buildExpandedImagePreview", () => {
  // jsdom has no blob URL store, so the object URL pair is stubbed here.
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock/demo"),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a video preview for a local video attachment", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "demo.mp4", { type: "video/mp4" });
    const attachment: ComposerFileAttachment = {
      type: "file",
      id: "video-1",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };

    const preview = buildExpandedImagePreview([attachment], attachment.id);

    expect(preview).toMatchObject({
      images: [{ name: "demo.mp4", type: "video" }],
      index: 0,
    });
    expect(preview?.images[0]?.src).toMatch(/^blob:/);
    URL.revokeObjectURL(preview?.images[0]?.src ?? "");
  });

  it("returns null when the selected attachment has no preview", () => {
    expect(
      buildExpandedImagePreview(
        [{ type: "image", id: "img-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 }],
        "img-1",
      ),
    ).toBeNull();
  });

  it("indexes the selected image among the previewable ones", () => {
    const preview = buildExpandedImagePreview(
      [
        { type: "image", id: "a", name: "a.png", mimeType: "image/png", sizeBytes: 1, previewUrl: "data:a" },
        { type: "image", id: "b", name: "b.png", mimeType: "image/png", sizeBytes: 1 },
        { type: "image", id: "c", name: "c.png", mimeType: "image/png", sizeBytes: 1, previewUrl: "data:c" },
      ],
      "c",
    );

    expect(preview).toEqual({
      images: [
        { src: "data:a", name: "a.png" },
        { src: "data:c", name: "c.png" },
      ],
      index: 1,
    });
  });
});
