// SPDX-License-Identifier: AGPL-3.0-only
// The chart kinds and the shaped diagram, drawn over a link shortener's traffic with figures of the size such a site
// serves.
import type { SlateJson } from "@wsp/protocol/slate";

/** A smooth day: lowest near 03:00 UTC, highest near 15:00, with a fixed wobble so every run draws the same. */
const day = (h: number): number => 0.55 + 0.45 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
const wobble = (i: number, k: number): number => 1 + 0.09 * Math.sin(i * 1.7 + k) + 0.05 * Math.cos(i * 3.1 + k * 2);
const iso = (start: number, minutes: number): string => new Date(start + minutes * 60_000).toISOString();
const START = Date.parse("2026-10-07T06:00:00Z");

const hours = Array.from({ length: 24 }, (_, i) => {
  const h = (6 + i) % 24;
  const blip = i === 17 ? 9 : i === 18 ? 4 : 0;
  return {
    at: iso(START, i * 60),
    r3: Math.round(7400 * day(h) * wobble(i, 1)),
    r2: Math.round(1650 * day(h) * wobble(i, 2)),
    r4: Math.round(520 * (0.7 + 0.3 * day(h)) * wobble(i, 3)),
    r5: Math.round(6 * wobble(i, 4)) + blip * 38,
  };
});

const latency = Array.from({ length: 37 }, (_, i) => {
  const spike = i >= 22 && i <= 25 ? [1.6, 2.4, 1.9, 1.3][i - 22]! : 1;
  return {
    at: iso(START + 18 * 3_600_000, i * 10),
    p50: Math.round(19 * wobble(i, 5) * (spike > 1 ? 1.15 : 1)),
    p95: Math.round(74 * wobble(i, 6) * Math.sqrt(spike)),
    p99: Math.round(210 * wobble(i, 7) * spike),
  };
});

const countries = [
  { name: "India", n: 41230 },
  { name: "United States", n: 18904 },
  { name: "Brazil", n: 7615 },
  { name: "Germany", n: 5388 },
  { name: "Indonesia", n: 4902 },
  { name: "United Kingdom", n: 3770 },
  { name: "France", n: 2410 },
  { name: "Nigeria", n: 1988 },
  { name: "Japan", n: 1306 },
];

const CI = Date.parse("2026-10-07T14:02:10Z");
const t = (base: number, m: number, sec: number): string => new Date(base + (m * 60 + sec) * 1000).toISOString();
const ciSteps: SlateJson[] = [
  { job: "Setup", name: "Install", start: t(CI, 0, 0), end: t(CI, 1, 12) },
  { job: "Build", name: "Web app", start: t(CI, 1, 12), end: t(CI, 3, 5) },
  { job: "Build", name: "Daemon", start: t(CI, 1, 12), end: t(CI, 4, 40) },
  { job: "Test", name: "Shard 1 of 3", start: t(CI, 3, 5), end: t(CI, 6, 20) },
  { job: "Test", name: "Shard 2 of 3", start: t(CI, 3, 5), end: t(CI, 7, 2) },
  { job: "Test", name: "Shard 3 of 3", start: t(CI, 3, 5), state: "running" },
  { job: "Checks", name: "Types", start: t(CI, 3, 5), end: t(CI, 4, 31) },
  { job: "Checks", name: "Lint", start: t(CI, 3, 5), end: t(CI, 3, 58) },
  { job: "Deploy", name: "Preview", state: "waiting" },
];
const DEPLOY = Date.parse("2026-10-07T09:40:00Z");
const phases = [
  { name: "Build image", start: t(DEPLOY, 0, 0), end: t(DEPLOY, 2, 40) },
  { name: "Push to registry", start: t(DEPLOY, 2, 40), end: t(DEPLOY, 3, 25) },
  { name: "Migrate database", start: t(DEPLOY, 3, 25), end: t(DEPLOY, 3, 58) },
  { name: "Canary at 10%", start: t(DEPLOY, 3, 58), end: t(DEPLOY, 8, 58) },
  { name: "Roll out to all", start: t(DEPLOY, 8, 58), end: t(DEPLOY, 11, 30) },
  { name: "Health checks", start: t(DEPLOY, 11, 30), end: t(DEPLOY, 12, 10) },
];
const KB = 1024;
const modules = [
  { pkg: "mermaid", name: "core", bytes: 226 * KB },
  { pkg: "mermaid", name: "flowchart", bytes: 186 * KB },
  { pkg: "mermaid", name: "dagre", bytes: 58 * KB },
  { pkg: "shiki", name: "grammars", bytes: 148 * KB },
  { pkg: "shiki", name: "engine", bytes: 52 * KB },
  { pkg: "react-dom", name: "client", bytes: 131 * KB },
  { pkg: "app", name: "chat", bytes: 92 * KB },
  { pkg: "app", name: "slate", bytes: 74 * KB },
  { pkg: "app", name: "settings", bytes: 61 * KB },
  { pkg: "app", name: "sidebar", bytes: 38 * KB },
  { pkg: "lucide-react", name: "icons", bytes: 29 * KB },
  { pkg: "zustand", name: "store", bytes: 4 * KB },
];

export const CLICK_FLOW = `flowchart TD
  open([Click on a short link]) --> req[/GET with slug, referrer, IP/]
  req --> edge{Cached at the edge?}
  edge -->|yes| send[Send 302 to the long URL]
  edge -->|no| find[Look up the slug]
  find --> mongo[(MongoDB urls)]
  mongo --> found{Slug exists?}
  found -->|no| gone([404 page])
  found -->|yes| guard{{Check expiry, password, max clicks}}
  guard --> send
  guard --> event((Click))
  event --> redis[(Redis click stream)]
  send --> lands([Visitor lands])`;

export const VIZ_CASES: Readonly<Record<string, { text: string; values?: Record<string, SlateJson> }>> = {
  "viz-stacked": {
    text: `<slate><value name="hours" start={[]} /><column><section title="Responses by status" note="acme.link, last 24 hours"><chart id="status" label="Requests an hour, by status class" items={$hours} x={item.at} format="integer" stack>
  <series label="3xx redirects" value={item.r3} tone="accent" />
  <series label="2xx pages and API" value={item.r2} tone="muted" />
  <series label="4xx" value={item.r4} tone="warning" />
  <series label="5xx" value={item.r5} tone="bad" />
</chart></section></column></slate>`,
    values: { hours },
  },
  "viz-lines": {
    text: `<slate><value name="lat" start={[]} /><column><section title="Redirect latency" note="acme.link, last 6 hours"><chart id="lat" label="Latency, every 10 minutes" items={$lat} x={item.at} unit="ms" format="integer">
  <series label="p50" value={item.p50} />
  <series label="p95" value={item.p95} />
  <series label="p99" value={item.p99} />
</chart></section></column></slate>`,
    values: { lat: latency },
  },
  "viz-timeline-ci": {
    text: `<slate><value name="steps" start={[]} /><column><section title="CI run 4812" note="ticket/1848, 7 of 9 steps done"><timeline id="ci" label="Jobs and steps, by clock" items={$steps} name={item.name} start={item.start} end={item.end} state={item.state} group={item.job} now="${t(CI, 8, 15)}" /></section></column></slate>`,
    values: { steps: ciSteps },
  },
  "viz-timeline-deploy": {
    text: `<slate><value name="phases" start={[]} /><column><section title="Deploy to acme.link" note="v2.14.0, done in 12m 10s"><timeline id="deploy" label="Phases" items={$phases} name={item.name} start={item.start} end={item.end} /></section></column></slate>`,
    values: { phases },
  },
  "viz-timeline-seconds": {
    text: `<slate><value name="steps" start={[]} /><column><section title="Nightly"><timeline id="secs" label="A start in seconds" items={$steps} name={item.name} start={item.start} end={item.end} /></section></column></slate>`,
    values: { steps: [{ name: "Build", start: 1_759_900_000, end: t(CI, 4, 0) }, { name: "Test", start: t(CI, 0, 0), end: t(CI, 6, 0) }] },
  },
  "viz-timeline-days": {
    text: `<slate><value name="steps" start={[]} /><column><section title="Backfill"><timeline id="days" label="Two days of jobs" items={$steps} name={item.name} start={item.start} end={item.end} /></section></column></slate>`,
    values: { steps: [{ name: "Import", start: t(CI, 0, 0), end: t(CI, 1500, 0) }, { name: "Reindex", start: t(CI, 1500, 0), end: t(CI, 2880, 0) }] },
  },
  "viz-treemap": {
    text: `<slate><value name="mods" start={[]} /><column><section title="Web bundle" note="main, gzip off"><treemap id="bundle" label="Size by module, by package" items={$mods} name={item.name} value={item.bytes} group={item.pkg} format="bytes" /></section></column></slate>`,
    values: { mods: modules },
  },
  "viz-donut": {
    text: `<slate><value name="countries" start={[]} /><column><section title="Where clicks come from" note="last 7 days"><donut id="countries" label="Clicks by country" items={$countries} name={item.name} value={item.n} format="integer" unit="clicks" /></section></column></slate>`,
    values: { countries },
  },
  "viz-donut-six": {
    text: `<slate><value name="countries" start={[]} /><column><section title="Where clicks come from"><donut id="six" label="Six parts" items={$countries} name={item.name} value={item.n} format="integer" /></section></column></slate>`,
    values: { countries: countries.slice(0, 6) },
  },
  "viz-diagram": {
    text: `<slate><column><section title="A click on a short link"><diagram id="flow" label="From the click to the long URL">${CLICK_FLOW}</diagram></section></column></slate>`,
  },
};
