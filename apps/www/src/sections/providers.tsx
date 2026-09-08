// SPDX-License-Identifier: AGPL-3.0-only
// What the Solari backend reports in packages/engine/src/solari-backend.ts, as the page states it.
import { Check, Minus } from "lucide-react";
import { SOLARI, SOLARI_PRICING } from "@/links";

// The sizes and rates in packages/engine/src/solari-backend.ts: 3.5 cents per vCPU hour plus 1 cent per GB hour.
const SIZES = [
  { cpu: 2, gb: 4, rate: "$0.11" },
  { cpu: 2, gb: 8, rate: "$0.15" },
];

const FLAGS: { name: string; on: boolean; why: string }[] = [
  { name: "liveCloneForks", on: true, why: "a fork comes up in about twenty seconds" },
  { name: "ramPreservingPause", on: true, why: "a nap keeps RAM and costs nothing" },
  { name: "previewUrls", on: true, why: "every port reaches your browser through a signed URL" },
  { name: "callbackRelay", on: true, why: "sign-ins open on your computer and tunnel back" },
  { name: "templates", on: true, why: "a sealed version survives the provider's restarts" },
  { name: "snapshotListing", on: true, why: "storage is counted and priced" },
  { name: "containers", on: false, why: "the guest kernel has no overlayfs, so services install natively" },
];

export function Providers() {
  return (
    <section id="machines" className="scroll-mt-16">
      <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 lg:py-32">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="rise lg:col-span-5">
            <h2 className="font-display-mid text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.02]">Machines from Solari, today.</h2>
            <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
              Every workspace is a{" "}
              <a href={SOLARI} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
                Solari
              </a>{" "}
              sandbox on your own account: two vCPUs with 4 or 8 GB, billed by the hour while awake and nothing while
              napping. You bring the key; wsp never sees a bill.
            </p>
            <table className="mt-8 w-full max-w-sm border-collapse text-left text-[15px]">
              <thead>
                <tr className="border-b border-border font-mono text-[12.5px] text-muted-foreground">
                  <th className="py-2 pr-4 font-normal">machine</th>
                  <th className="py-2 pr-4 font-normal">awake</th>
                  <th className="py-2 font-normal">napping</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[14px]">
                {SIZES.map(size => (
                  <tr key={size.gb} className="border-b border-border">
                    <td className="py-2.5 pr-4 text-foreground">
                      {size.cpu} vCPU, {size.gb} GB
                    </td>
                    <td className="py-2.5 pr-4 text-foreground">{size.rate}/hr</td>
                    <td className="py-2.5 text-muted-foreground">$0.00/hr</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-[15px] text-muted-foreground">
              The plans behind these machines are on{" "}
              <a href={SOLARI_PRICING} className="text-foreground underline decoration-input underline-offset-4 hover:decoration-foreground">
                Solari's pricing page
              </a>
              .
            </p>
          </div>
          <div className="rise lg:col-span-7">
            <h2 className="font-display-mid text-[clamp(2rem,4.6vw,3.25rem)] leading-[1.02]">One interface. More providers to come.</h2>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              wsp talks to a provider through one interface and reads a list of capabilities instead of assuming. The
              app and the command line degrade on what a provider lacks rather than pretending. A second provider is one
              module and a registry entry, and your own computer as a workspace is next, so agents can start each other
              locally too.
            </p>
          </div>
        </div>

        <div className="rise mt-16">
          <p className="font-mono text-[13px] text-muted-foreground">what Solari reports to wsp</p>
          <ul className="mt-5 grid gap-x-10 gap-y-4 sm:grid-cols-2">
            {FLAGS.map(flag => (
              <li key={flag.name} className="flex items-start gap-3">
                {flag.on ? (
                  <Check aria-label="yes" className="mt-[3px] size-4 shrink-0 text-run" />
                ) : (
                  <Minus aria-label="no" className="mt-[3px] size-4 shrink-0 text-muted-foreground/50" />
                )}
                <div>
                  <span className="font-mono text-[14px] text-foreground">{flag.name}</span>
                  <span className="text-[15px] text-muted-foreground"> {flag.why}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
