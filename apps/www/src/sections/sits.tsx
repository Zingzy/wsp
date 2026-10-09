// SPDX-License-Identifier: AGPL-3.0-only
// /compare cut to three questions against two kinds of tool. Each cell sums the rows of that kind there, so a change
// to a fact there may change a word here.
import { ArrowRight } from "lucide-react";
import { Lockup } from "@/components/brand";
import { Head, Section } from "@/components/section";
import { VENDORS_BRING } from "@/compare";
import { cn } from "@/lib/utils";

const QUESTIONS = ["Runs agents on", "What a new computer has on it", "Price"] as const;

const KINDS = [
  { name: "Apps on the computer you sit at", says: ["Your computer; most reach a second computer over ssh or a relay", "What you install and sign in to by hand", "Free to $50 a month"] },
  { name: "The vendors' clouds", says: ["Their VM", VENDORS_BRING[0]!.toUpperCase() + VENDORS_BRING.slice(1), "From a $20 a month plan"] },
  { name: "wsp", says: ["Your computer, and Linux computers you own", "Your agents signed in, MCP servers, CLIs and skills", "Free, AGPL-3.0"] },
] as const;

const isUs = (name: string): boolean => name === "wsp";
const Name = ({ name }: { name: string }) => (isUs(name) ? <Lockup className="text-[18px]" /> : <>{name}</>);

export function Sits() {
  return (
    <Section id="compare">
      <Head title="Other tools reach your other computers too.">
        {`What differs is what is on that computer when the agent gets there. Most leave it to you. The vendors bring ${VENDORS_BRING}. wsp brings your setup.`}
      </Head>

      <div className="mt-12 hidden overflow-hidden rounded-[14px] border border-border sm:block">
        <table className="w-full table-fixed border-collapse text-[15px] leading-[1.5]">
          <colgroup>
            <col className="w-[24%]" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <td />
              {KINDS.map(k => (
                <th key={k.name} scope="col" className={cn("border-l border-rule px-5 py-4 text-left text-[14px] font-medium", isUs(k.name) ? "bg-raised text-foreground" : "text-muted-foreground")}>
                  <Name name={k.name} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {QUESTIONS.map((q, i) => (
              <tr key={q} className="border-t border-rule align-top">
                <th scope="row" className="px-5 py-4 text-left font-normal text-muted-foreground">
                  {q}
                </th>
                {KINDS.map(k => (
                  <td key={k.name} className={cn("border-l border-rule px-5 py-4", isUs(k.name) ? "bg-raised font-medium text-foreground" : "text-muted-foreground")}>
                    {k.says[i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-10 sm:hidden">
        {KINDS.map(k => (
          <div key={k.name} className={cn("border-t border-rule py-5", isUs(k.name) && "-mx-4 bg-raised px-4")}>
            <h3 className="text-[16px] font-medium text-foreground">
              <Name name={k.name} />
            </h3>
            <dl className="mt-3 grid grid-cols-[136px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px] leading-[1.5]">
              {QUESTIONS.map((q, i) => (
                <div key={q} className="contents">
                  <dt className="text-faint">{q}</dt>
                  <dd className={isUs(k.name) ? "text-foreground" : "text-muted-foreground"}>{k.says[i]}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <a href="/compare" className="mt-8 inline-flex items-center gap-2 border-b border-faint pb-0.5 text-[15px] font-medium text-foreground transition-colors duration-150 hover:border-foreground">
        Compare with Conductor, herdr, Orca, Claude Code on the web and others <ArrowRight className="size-4 shrink-0" />
      </a>
    </Section>
  );
}
