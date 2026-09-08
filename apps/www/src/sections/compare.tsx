// SPDX-License-Identifier: AGPL-3.0-only
import { Check, Minus } from "lucide-react";
import { cn } from "cn";

type Cell = { text: string; good?: boolean };

const COLUMNS = ["Worktrees on your Mac", "A hosted agent cloud"] as const;

const ROWS: { label: string; others: readonly [Cell, Cell]; wsp: Cell }[] = [
  {
    label: "What the machine has on it",
    others: [{ text: "Your setup", good: true }, { text: "Their image, your repo" }],
    wsp: { text: "Your setup, cloned", good: true },
  },
  {
    label: "Where your keys and sign-ins live",
    others: [{ text: "Your disk", good: true }, { text: "Their servers" }],
    wsp: { text: "Your disk and your machines", good: true },
  },
  {
    label: "How many run at once",
    others: [{ text: "Until the fan gives up" }, { text: "Their quota" }],
    wsp: { text: "As many machines as you pay for", good: true },
  },
  {
    label: "Who can drive it",
    others: [{ text: "You" }, { text: "You, in their web app" }],
    wsp: { text: "You, the CLI, or an agent over MCP", good: true },
  },
  {
    label: "Which agents",
    others: [{ text: "Any", good: true }, { text: "Theirs" }],
    wsp: { text: "Claude Code and Codex, more coming" },
  },
  {
    label: "Cost when idle",
    others: [{ text: "Your electricity" }, { text: "A seat" }],
    wsp: { text: "Nothing while it naps", good: true },
  },
  {
    label: "Source",
    others: [{ text: "Yours" }, { text: "Closed" }],
    wsp: { text: "AGPL-3.0", good: true },
  },
];

function Mark({ good }: { good: boolean | undefined }) {
  return good ? (
    <Check aria-label="yes" className="mt-[3px] size-4 shrink-0 text-run" />
  ) : (
    <Minus aria-label="no" className="mt-[3px] size-4 shrink-0 text-muted-foreground/50" />
  );
}

export function Compare() {
  return (
    <section id="compare" className="dots scroll-mt-16">
      <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 lg:py-32">
        <div className="rise max-w-3xl">
          <h2 className="font-display-mid text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.02]">Where it sits.</h2>
          <p className="mt-5 text-lg text-muted-foreground">
            Worktrees keep your setup but share one laptop. Hosted clouds scale but hold your keys and pick your image.
            wsp keeps your setup and your keys, and scales to whatever you rent.
          </p>
        </div>
        <div className="rise mt-12 overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse border border-input bg-background text-left text-[15px]">
            <thead>
              <tr>
                <th scope="col" className="w-[26%] border-b border-r border-input px-5 py-4 align-bottom">
                  <span className="sr-only">Question</span>
                </th>
                {COLUMNS.map(column => (
                  <th key={column} scope="col" className="w-[22%] border-r border-b border-input px-5 py-4 align-bottom text-[15px] font-medium text-muted-foreground">
                    {column}
                  </th>
                ))}
                <th scope="col" className="border-b border-input bg-sky px-5 py-4 align-bottom text-sky-foreground">
                  <span className="flex items-baseline gap-1 font-display-low text-[22px] leading-none">
                    <span aria-hidden="true">~</span>wsp
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, index) => {
                const last = index === ROWS.length - 1;
                return (
                  <tr key={row.label}>
                    <th
                      scope="row"
                      className={cn("border-r border-input px-5 py-4 font-normal text-muted-foreground", !last && "border-b")}
                    >
                      {row.label}
                    </th>
                    {row.others.map((cell, i) => (
                      <td key={i} className={cn("border-r border-input px-5 py-4 text-foreground/80", !last && "border-b")}>
                        <span className="flex gap-2.5">
                          <Mark good={cell.good} />
                          {cell.text}
                        </span>
                      </td>
                    ))}
                    <td className={cn("bg-card px-5 py-4 font-medium text-foreground", !last && "border-b border-input")}>
                      <span className="flex gap-2.5">
                        <Mark good={row.wsp.good} />
                        {row.wsp.text}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-6 font-mono text-[12.5px] text-muted-foreground">
          Machines come from Solari today and cost money while they run. wsp reads the provider's capabilities instead of
          assuming them, so others can follow.
        </p>
      </div>
    </section>
  );
}
