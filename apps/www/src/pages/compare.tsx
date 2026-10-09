// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment } from "react";
import { Lockup } from "@/components/brand";
import { Install } from "@/components/download";
import { Section } from "@/components/section";
import { AHEAD, COLUMNS, KINDS, LIT, READ, sources, VENDORS_BRING, WSP, type Cell, type Tool } from "@/compare";
import { REPO } from "@/links";
import { cn } from "@/lib/utils";

const SOURCES = sources();
const OTHERS = COLUMNS.filter(c => c.key !== LIT);
const LIT_LABEL = COLUMNS.find(c => c.key === LIT)!.label;
const shown = (url: string): string => url.replace(/^https:\/\/(www\.)?/, "").replace(/\/blob\/[0-9a-f]{40}\//, "/");

/** A cell's words, then a numbered link to each page they were read from. */
function Cited({ cell }: { cell: Cell }) {
  const [text, ...from] = cell;
  return (
    <>
      {text}
      {from.map(url => {
        const n = SOURCES.indexOf(url) + 1;
        return (
          <a
            key={url}
            href={url}
            title={shown(url)}
            aria-label={`Source ${n}`}
            className="ml-0.5 px-0.5 font-mono text-[11px] text-faint tabular-nums underline decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-foreground"
          >
            {n}
          </a>
        );
      })}
    </>
  );
}

const Name = ({ tool }: { tool: Tool }) => (tool === WSP ? <Lockup className="text-[17px]" /> : <>{tool.name}</>);

function Row({ tool }: { tool: Tool }) {
  const us = tool === WSP;
  return (
    <tr className={cn("border-t border-rule align-top", us && "bg-raised")}>
      <th scope="row" className="px-4 py-4 text-left text-[14px] font-semibold text-foreground">
        <Name tool={tool} />
      </th>
      {COLUMNS.map(c => (
        <td key={c.key} className={cn("border-l border-rule px-4 py-4", c.key === LIT ? "bg-raised text-foreground" : us ? "text-foreground" : "text-muted-foreground")}>
          <Cited cell={tool.cells[c.key]} />
        </td>
      ))}
    </tr>
  );
}

function Table() {
  return (
    <div className="hidden overflow-hidden rounded-[14px] border border-border xl:block">
      <table className="w-full table-fixed border-collapse text-[14px] leading-[1.5]">
        <colgroup>
          <col className="w-[12%]" />
          <col className="w-[13%]" />
          <col className="w-[12%]" />
          <col className="w-[20%]" />
          <col className="w-[12%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[9%]" />
        </colgroup>
        <thead>
          <tr className="align-bottom">
            <th scope="col" className="px-4 py-3.5 text-left text-[13px] font-medium text-muted-foreground">
              Tool
            </th>
            {COLUMNS.map(c => (
              <th key={c.key} scope="col" className={cn("border-l border-rule px-4 py-3.5 text-left text-[13px] font-medium", c.key === LIT ? "bg-raised text-foreground" : "text-muted-foreground")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Row tool={WSP} />
        </tbody>
        {KINDS.map(kind => (
          <tbody key={kind.name}>
            <tr className="border-t border-rule">
              <th scope="rowgroup" colSpan={COLUMNS.length + 1} className="px-4 pt-6 pb-2 text-left font-mono text-[12px] font-normal text-faint">
                {kind.name}
              </th>
            </tr>
            {kind.tools.map(tool => (
              <Row key={tool.name} tool={tool} />
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** The table below xl: one block per tool, the lit column first, beside the rest from md. wsp's name is an h2 like
 * the kinds', so the headings run h1, h2, h3 on every width. */
function Stack() {
  const block = (tool: Tool) => {
    const Heading = tool === WSP ? "h2" : "h3";
    return (
      <div key={tool.name} className={cn("border-t border-rule py-5 md:grid md:grid-cols-2 md:gap-x-10 md:py-7", tool === WSP && "-mx-4 bg-raised px-4 sm:-mx-6 sm:px-6")}>
        <Heading className="text-[17px] font-semibold text-foreground md:col-span-2">
          <Name tool={tool} />
        </Heading>
        <div>
          <p className="mt-3 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{LIT_LABEL}</p>
          <p className="mt-1 text-[15px] leading-relaxed text-foreground">
            <Cited cell={tool.cells[LIT]} />
          </p>
        </div>
        <dl className="mt-4 grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px] leading-[1.5] md:mt-3">
          {OTHERS.map(c => (
            <Fragment key={c.key}>
              <dt className="text-faint">{c.label}</dt>
              <dd className={tool === WSP ? "text-foreground" : "text-muted-foreground"}>
                <Cited cell={tool.cells[c.key]} />
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
    );
  };
  return (
    <div className="xl:hidden">
      {block(WSP)}
      {KINDS.map(kind => (
        <Fragment key={kind.name}>
          <h2 className="border-t border-rule pt-7 pb-1 font-mono text-[12px] font-normal text-faint">{kind.name}</h2>
          {kind.tools.map(block)}
        </Fragment>
      ))}
    </div>
  );
}

export function Compare() {
  return (
    <main>
      <header className="mx-auto max-w-[1200px] px-4 pt-32 pb-12 sm:px-6 sm:pt-40 sm:pb-16">
        <p className="font-mono text-[13px] text-faint">Compare</p>
        <h1 className="display mt-4 text-[40px] sm:text-[64px]">Where wsp sits.</h1>
        <p className="lede mt-6 max-w-[640px] text-[17px] sm:text-[18px]">
          Most of these run agents on the computer you sit at. Most can also reach a second computer over ssh or a relay, and you set that computer up by hand. {`The vendors run agents on their own machines, from ${VENDORS_BRING}. wsp runs them on computers you own, and sets each one up from yours.`}
        </p>
        <p className="mt-5 font-mono text-[13px] text-faint">Read from each product's own site, docs and repo on {READ}. Every cell links its source.</p>
      </header>

      <div className="mx-auto max-w-[1320px] px-4 sm:px-6">
        <Table />
        <Stack />
        <p className="mt-6 max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">
          {`"${LIT_LABEL}" sorts the field. Most of these can start an agent on another computer. What differs is what is on it when the agent gets there.`}
        </p>
      </div>

      <Section id="ahead">
        <h2 className="heading text-[32px] sm:text-[44px]">What wsp does not do yet.</h2>
        <dl className="mt-12 grid gap-x-12 gap-y-10 md:grid-cols-3">
          {AHEAD.map(({ title, body }) => (
            <div key={title} className="border-t border-rule pt-6">
              <dt className="text-[17px] font-medium tracking-[-0.01em] text-foreground">{title}</dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                <Cited cell={body} />
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="sources" className="pt-0 sm:pt-0">
        <h2 className="text-[17px] font-medium tracking-[-0.01em] text-foreground">Sources, read {READ}</h2>
        <ol className="mt-6 gap-x-10 font-mono text-[12.5px] leading-[1.9] text-muted-foreground md:columns-2">
          {SOURCES.map((url, i) => (
            <li key={url} className="flex gap-3 break-inside-avoid">
              <span className="w-6 shrink-0 text-right text-faint tabular-nums">{i + 1}</span>
              <a href={url} className="min-w-0 break-all transition-colors duration-150 hover:text-foreground">
                {shown(url)}
              </a>
            </li>
          ))}
        </ol>
      </Section>

      <div className="border-t border-rule">
        <Section className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="heading text-[32px] sm:text-[44px]">Try it on a computer you own.</h2>
            <p className="lede mt-4 text-[17px]">
              Something here wrong or out of date?{" "}
              <a href={`${REPO}/issues/new`} className="text-foreground underline decoration-faint underline-offset-4 transition-colors duration-150 hover:decoration-foreground">
                Open an issue
              </a>{" "}
              with the page that says so.
            </p>
          </div>
          <Install />
        </Section>
      </div>
    </main>
  );
}
