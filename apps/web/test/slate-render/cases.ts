// SPDX-License-Identifier: AGPL-3.0-only
// Slates the render tests open by name with ?doc=, each the smallest that shows one layout fault the matrix found.
import type { SlateJson } from "@wsp/protocol";

export const RENDER_CASES: Readonly<Record<string, { text: string; values?: Record<string, SlateJson> }>> = {
  "long-head": {
    text: `<slate><column>
  <section id="retail" title="Bengaluru retail" note="Indicative local jewellery-market rates; making charges and GST can vary by retailer"><status tone="good">Open</status></section>
  <section id="folded" title="Sources and how each is read" note="Indicative local jewellery-market rates; making charges and GST can vary" collapsible><status>x</status></section>
</column></slate>`,
  },
};
