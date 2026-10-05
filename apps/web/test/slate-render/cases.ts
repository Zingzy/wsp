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
  "rate-chart": {
    text: `<slate><value name="hist" start={[]} /><column><section title="Per minute"><chart id="rate" label="Requests" items={$hist} x={item.at} value={item.n} unit="req/min" format="integer" /></section></column></slate>`,
    values: { hist: Array.from({ length: 30 }, (_, i) => ({ at: `2026-10-05T05:${String(10 + i).padStart(2, "0")}:00Z`, n: 180 + ((i * 37) % 160) })) },
  },
  "empty-table": {
    text: `<slate><value name="rows" start={[]} /><column><section title="Latest 5xx errors"><table id="errors" items={$rows}><col title="Time" value={item.t} /><col title="Status" value={item.s} /><col title="Method" value={item.m} /><col title="Path" value={item.p} /><col title="Duration (ms)" value={item.d} /><col title="Request" value={item.r} /></table></section></column></slate>`,
  },
};
