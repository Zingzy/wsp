// SPDX-License-Identifier: AGPL-3.0-only
import { Agents } from "@/sections/agents";
import { Close, Questions } from "@/sections/close";
import { Computers } from "@/sections/computers";
import { Features } from "@/sections/features";
import { Handoff } from "@/sections/handoff";
import { Hero } from "@/sections/hero";
import { Slate } from "@/sections/slate";

export function Home() {
  return (
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
  );
}
