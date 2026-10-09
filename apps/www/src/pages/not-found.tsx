// SPDX-License-Identifier: AGPL-3.0-only
import { ArrowRight } from "lucide-react";
import { Field } from "@/components/field";
import { Section } from "@/components/section";

export function NotFound() {
  return (
    <main className="relative isolate overflow-hidden">
      <div className="absolute inset-0 -z-10 [mask-image:radial-gradient(70%_80%_at_50%_100%,black_20%,transparent_75%)]">
        <Field seed={7} />
      </div>
      <Section className="flex min-h-[78vh] flex-col items-center justify-center pt-40 text-center">
        <p className="font-mono text-[13px] text-faint">404</p>
        <h1 className="display mx-auto mt-4 max-w-[14ch] text-[40px] sm:text-[64px]">Nothing lives at this address.</h1>
        <p className="lede mx-auto mt-6 max-w-[440px] text-[17px] sm:text-[18px]">The link may be old, or mistyped.</p>
        <a
          href="/"
          className="key mt-10 inline-flex h-11 items-center gap-2 rounded-[10px] px-4.5 text-[15px] font-medium transition-opacity duration-150 hover:opacity-90"
        >
          Go to usewsp.com <ArrowRight className="size-4" />
        </a>
      </Section>
    </main>
  );
}
