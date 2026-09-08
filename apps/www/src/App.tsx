// SPDX-License-Identifier: AGPL-3.0-only
import { AgentSetup } from "./sections/agent";
import { Closing } from "./sections/closing";
import { Compare } from "./sections/compare";
import { Faq } from "./sections/faq";
import { Hero } from "./sections/hero";
import { Nav } from "./sections/nav";
import { Providers } from "./sections/providers";
import { Shot } from "./sections/shot";
import { Story } from "./sections/story";
import { Tree } from "./sections/tree";

export function App() {
  return (
    <div className="relative">
      <Nav />
      <main>
        <Hero />
        <Shot />
        <Story />
        <Tree />
        <Compare />
        <Providers />
        <AgentSetup />
        <Faq />
        <Closing />
      </main>
    </div>
  );
}
