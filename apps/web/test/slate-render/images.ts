// SPDX-License-Identifier: AGPL-3.0-only
// The image pieces over a thread folder of screenshots, laid out as the render test's folder holds them: a Playwright
// failure shot, the chart round's shots, settings screens, and one sidebar before and after a change. An address on
// images.acme.test reads the same folder once its domain is allowed.
import type { SlateJson } from "@wsp/protocol/slate";

export const REMOTE = "https://images.acme.test";

export const IMAGE_FILES = {
  failure: "test-results/settings-computer-open/failed.png",
  charts: ["shots/charts/donut.png", "shots/charts/treemap.png", "shots/charts/timeline.png", "shots/charts/latency.png", "shots/charts/diagram.png"],
  screens: ["shots/screens/sidebar.png", "shots/screens/appearance.png", "shots/screens/editor.png", "shots/screens/computer.png", "shots/screens/thread-menu.png", "shots/screens/computers.png"],
  before: "shots/sidebar/before.png",
  after: "shots/sidebar/after.png",
} as const;

const charts: SlateJson[] = [
  { path: IMAGE_FILES.charts[0], title: "Clicks by country, last 7 days" },
  { path: IMAGE_FILES.charts[1], title: "Web bundle by module" },
  { path: IMAGE_FILES.charts[2], title: "CI run 4812, jobs and steps" },
  { path: IMAGE_FILES.charts[3], title: "Redirect latency, p50 p95 p99" },
  { path: IMAGE_FILES.charts[4], title: "A click on a short link" },
];
const screens: SlateJson[] = [
  { path: IMAGE_FILES.screens[0], title: "Sidebar" },
  { path: IMAGE_FILES.screens[1], title: "Settings, Appearance" },
  { path: IMAGE_FILES.screens[2], title: "Settings, Editor" },
  { path: IMAGE_FILES.screens[3], title: "Settings, a computer" },
  { path: IMAGE_FILES.screens[4], title: "Thread menu" },
  { path: IMAGE_FILES.screens[5], title: "Settings, Computers" },
];
const pair: SlateJson[] = [
  { path: IMAGE_FILES.before, title: "Before" },
  { path: IMAGE_FILES.after, title: "After, ticket 1713" },
];

const several = (layout: string, title: string, note: string, list: string) =>
  `<slate><value name="shots" start={[]} /><column><section title="${title}" note="${note}"><images id="shots" layout="${layout}" items={${list}} src={item.path} caption={item.title} /></section></column></slate>`;

export const IMAGE_CASES: Readonly<Record<string, { text: string; values?: Record<string, SlateJson> }>> = {
  "img-single": {
    text: `<slate><column><section title="Playwright failure" note="settings.spec.ts, 1 of 42 failed"><image id="shot" src="${IMAGE_FILES.failure}" caption="Settings, a computer opened: the ssh login row is missing" /></section></column></slate>`,
  },
  "img-strip-3": { text: several("strip", "Chart round 2", "3 shots", "$shots"), values: { shots: charts.slice(0, 3) } },
  "img-strip-6": { text: several("strip", "Settings screens", "6 shots, 1440 px", "$shots"), values: { shots: screens } },
  "img-gallery": { text: several("gallery", "Settings screens", "6 shots, 1440 px", "$shots"), values: { shots: screens } },
  "img-slider": { text: several("compare", "Sidebar, before and after", "ticket 1713", "$shots"), values: { shots: pair } },
  "img-states": {
    text: `<slate><value name="away" start="${REMOTE}/${IMAGE_FILES.screens[0]}" /><column>
  <section title="Loading"><image id="loading" src="loading/plot.png" caption="Latency plot, saved by bench.py" /></section>
  <section title="Missing file"><image id="missing" src="plots/latency.png" caption="Latency plot, saved by bench.py" /></section>
  <section title="Too big to show"><image id="big" src="too-big/trace.png" caption="Full page trace" /></section>
  <section title="Not an image"><image id="text" src="text/notes.png" caption="A text file named like a picture" /></section>
  <section title="Waiting on its domain"><image id="asking" src={$away} caption="The sidebar, from the docs site" /></section>
</column></slate>`,
  },
  "img-remote": {
    text: `<slate><value name="shots" start={[]} /><column>
  <section title="From the docs site"><image id="one" src="${REMOTE}/${IMAGE_FILES.failure}" caption="Settings, a computer opened" /></section>
  <section title="Its screens" note="3 shots"><images id="row" layout="strip" items={$shots} src={item.path} caption={item.title} /></section>
</column></slate>`,
    values: { shots: screens.slice(0, 3).map(s => ({ ...(s as Record<string, SlateJson>), path: `${REMOTE}/${String((s as Record<string, SlateJson>)["path"])}` })) },
  },
  "img-gallery-60": { text: several("gallery", "Settings screens", "60 shots", "$shots"), values: { shots: Array.from({ length: 60 }, (_, i) => screens[i % screens.length]!) } },
  "img-strip-30": { text: several("strip", "Settings screens", "30 shots", "$shots"), values: { shots: Array.from({ length: 30 }, (_, i) => screens[i % screens.length]!) } },
  "img-gallery-61": { text: several("gallery", "Settings screens", "61 shots", "$shots"), values: { shots: Array.from({ length: 61 }, (_, i) => screens[i % screens.length]!) } },
  "img-gallery-states": {
    text: several("gallery", "Settings screens", "one still loading, one missing", "$shots"),
    values: { shots: [screens[0]!, { path: "loading/appearance.png", title: "Settings, Appearance" }, { path: "shots/screens/gone.png", title: "Settings, Editor" }, screens[3]!, { path: `${REMOTE}/${IMAGE_FILES.screens[4]}`, title: "Thread menu, from the docs site" }] },
  },
};
