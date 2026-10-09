// SPDX-License-Identifier: AGPL-3.0-only
import { Agents } from "./sections/agents";
import { Close, Footer, Questions } from "./sections/close";
import { Computers } from "./sections/computers";
import { Handoff } from "./sections/handoff";
import { Hero } from "./sections/hero";
import { Nav } from "./sections/nav";
import { Slate } from "./sections/slate";
import { Features } from "./sections/features";

export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Agents />
        <Handoff />
        <Computers />
        <Slate />
        <Features />
        <Questions />
        <Close />
      </main>
      <Footer />
    </>
  );
}
