// SPDX-License-Identifier: AGPL-3.0-only
// The window's own fit of a project's image, on a page with nothing else on it, for the browser test to hand files
// to: bytes in as base64, the fitted PNG or the refusal out, and the pixels of a PNG read back where it asks. It also
// draws a number of projects' marks the way the sidebar, the palette, a page head and New thread do, each wearing an
// image the window reads through its own cache or the glyph alone, so the window's memory can be read both ways.
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, ProjectIcon } from "@wsp/protocol";
import type { Api } from "../../src/protocol/client.js";
import { useStore } from "../../src/protocol/store.js";
import { followProjectIcons, useProjectIcons } from "../../src/projects/images.js";
import { ProjectGlyph } from "../../src/projects/look.js";
import { base64Of, fitProjectIcon } from "../../src/projects/imageFile.js";

const bytesOf = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

declare global {
  interface Window {
    fit(b64: string): Promise<{ png: string } | { refusal: { said: string; fix: string } }>;
    source(type: string, width: number, height: number): Promise<string>;
    pixels(b64: string, at: readonly [number, number][]): Promise<{ width: number; height: number; rgba: number[][] }>;
    marks(count: number, images: Record<string, string> | null, draw?: boolean, sizes?: readonly string[]): Promise<{ drawn: number; urls: number }>;
    unwear(): Promise<{ revoked: number; urls: number }>;
    ready: boolean;
  }
}

window.fit = async b64 => {
  const fit = await fitProjectIcon(new Blob([bytesOf(b64)]));
  return "refusal" in fit ? fit : { png: await base64Of(fit.png) };
};

/** A picture made here: red on its left half and blue on its right, opaque, in the type asked. */
window.source = async (type, width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, Math.ceil(width / 2), height);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(Math.ceil(width / 2), 0, width, height);
  const blob = await new Promise<Blob>(done => canvas.toBlob(b => done(b!), type, 0.95));
  if (blob.type !== type) throw new Error(`this browser made ${blob.type} for ${type}`);
  return base64Of(blob);
};

window.pixels = async (b64, at) => {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([bytesOf(b64)], { type: "image/png" }));
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);
  return { width: img.naturalWidth, height: img.naturalHeight, rgba: at.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) };
};

let revoked = 0;
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = url => {
  revoked += 1;
  revoke(url);
};

/** `count` projects each drawn at the sidebar's 12 px, a row's 16 px, a switcher card's 24 px and New thread's 40 px;
 * with `images` (hash to data url) project n wears the nth, read through the window's own cache. */
window.marks = async (count, images, draw = true, sizes = ["size-3", "size-4", "size-6", "size-10"]) => {
  const ids = Array.from({ length: count }, (_, i) => `pr_${i}`);
  const hashes = images === null ? [] : Object.keys(images);
  const projectIcon = Object.fromEntries(hashes.slice(0, count).map((hash, i) => [ids[i]!, hash]));
  const projectLook = Object.fromEntries(ids.map((id, i) => [id, { icon: ProjectIcon.options[i % ProjectIcon.options.length]!, hue: "teal" as const }]));
  // Each answer is handed over once and not kept, as the host's reply is once the socket has parsed it.
  const held = new Map(Object.entries(images ?? {}));
  const api = {
    projectIcons: async (asked: readonly string[]) =>
      Object.fromEntries(
        asked.map(h => {
          const url = held.get(h) ?? null;
          held.delete(h);
          return [h, url];
        }),
      ),
  } as unknown as Api;
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false, projectLook, projectIcon } });
  followProjectIcons({ api, projectIcon });
  if (!draw) {
    for (let i = 0; i < 400 && Object.keys(useProjectIcons.getState().urls).length < hashes.length; i++) await new Promise(r => setTimeout(r, 25));
    return { drawn: 0, urls: Object.keys(useProjectIcons.getState().urls).length };
  }
  const root = document.createElement("div");
  root.style.cssText = "display:grid;grid-template-columns:repeat(10,1fr);gap:8px;padding:8px";
  document.body.append(root);
  createRoot(root).render(
    <>
      {ids.map(id => (
        <div key={id} style={{ display: "flex", gap: 4, alignItems: "end" }}>
          {sizes.map(size => (
            <ProjectGlyph key={size} projectId={id} className={size} />
          ))}
        </div>
      ))}
    </>,
  );
  const want = hashes.length === 0 ? 0 : count * sizes.length;
  for (let i = 0; i < 400 && document.querySelectorAll("img[data-project-icon]").length < want; i++) await new Promise(r => setTimeout(r, 25));
  await Promise.all([...document.querySelectorAll("img")].map(img => img.decode().catch(() => undefined)));
  return { drawn: document.querySelectorAll("img[data-project-icon]").length, urls: Object.keys(useProjectIcons.getState().urls).length };
};

/** Every project takes its image off, as a reset would: the window lets each URL go. */
window.unwear = async () => {
  const before = revoked;
  useStore.setState(s => ({ preferences: { ...s.preferences, projectIcon: {} } }));
  followProjectIcons({ api: null, projectIcon: {} });
  await new Promise(r => setTimeout(r, 50));
  return { revoked: revoked - before, urls: Object.keys(useProjectIcons.getState().urls).length };
};

window.ready = true;
