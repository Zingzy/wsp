// SPDX-License-Identifier: AGPL-3.0-only
import { Head, Section } from "@/components/section";
import { AgentTree } from "@/components/tree";

export function Handoff() {
  return (
    <Section id="agents">
      <Head center title="Your agents hand work to each other.">
        A Claude Code thread can start a Codex thread to review its branch, on your Mac or another computer, and read what it found when it's done. Those agents have the same tools, so they start threads too. Every one of them is in your sidebar.
      </Head>
      <AgentTree className="mx-auto mt-14 max-w-4xl" />
    </Section>
  );
}
