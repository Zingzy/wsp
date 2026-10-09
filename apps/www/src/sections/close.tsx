// SPDX-License-Identifier: AGPL-3.0-only
import { Lockup } from "@/components/brand";
import { Install } from "@/components/download";
import { Field } from "@/components/field";
import { Section } from "@/components/section";
import { DOCS, EMAIL, REPO, X } from "@/links";

export const QUESTIONS = [
  { q: "Do I need API keys?", a: "Not for most agents. Claude Code, Codex and Cursor use the subscriptions you're already signed in to. OpenCode uses a key from the model provider you pick." },
  { q: "Which agents does it run?", a: "Claude Code, Codex, OpenCode and Cursor today. A thread can use any of them, and one thread can start another on a different one." },
  { q: "Which computers?", a: "Your Mac, and any Linux computer you can reach over ssh or that can dial out to you: a server you rent, an old laptop, a desktop under the desk." },
  { q: "Does my code go through your servers?", a: "Only if you turn on the relay. Threads run on your computers, and the app reaches them over your own network or SSH. If you link the relay to reach a computer from anywhere, that connection runs through Cloudflare, which can read it on the way. Running your own relay takes us out of it, but it still goes through Cloudflare. To keep Cloudflare out too, skip the relay and stay on your own network." },
  { q: "What does it cost?", a: "Nothing. wsp is free and open source." },
];

export function Questions() {
  return (
    <Section id="questions">
      <h2 className="heading text-[32px] sm:text-[44px]">Questions</h2>
      <dl className="mt-12 grid gap-x-16 gap-y-10 md:grid-cols-2">
        {QUESTIONS.map(({ q, a }) => (
          <div key={q} className="border-t border-rule pt-6">
            <dt className="text-[17px] font-medium tracking-[-0.01em] text-foreground">{q}</dt>
            <dd className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{a}</dd>
          </div>
        ))}
      </dl>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: QUESTIONS.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }),
        }}
      />
    </Section>
  );
}

export function Close() {
  return (
    <div id="get" className="relative isolate overflow-hidden border-t border-rule">
      <div className="absolute inset-0 -z-10 [mask-image:radial-gradient(70%_80%_at_50%_100%,black_20%,transparent_75%)]">
        <Field seed={13} />
      </div>
      <Section className="py-32 text-center sm:py-44">
        <h2 className="display mx-auto max-w-[14ch] text-[40px] sm:text-[64px]">Put your other computers to work.</h2>
        <Install align="center" className="mt-10" />
      </Section>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-rule">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 px-4 py-10 text-[14px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <span className="text-[18px]">
            <Lockup />
          </span>
          <span className="text-faint">Say it wisp.</span>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          <a className="transition-colors hover:text-foreground" href={DOCS}>
            Docs
          </a>
          <a className="transition-colors hover:text-foreground" href="/compare">
            Compare
          </a>
          <a className="transition-colors hover:text-foreground" href={REPO}>
            GitHub
          </a>
          <a className="transition-colors hover:text-foreground" href={X}>
            X
          </a>
          <a className="transition-colors hover:text-foreground" href="/privacy">
            Privacy
          </a>
          <a className="transition-colors hover:text-foreground" href="/terms">
            Terms
          </a>
          <a className="transition-colors hover:text-foreground" href="/security">
            Security
          </a>
          <a className="transition-colors hover:text-foreground" href={`mailto:${EMAIL}`}>
            {EMAIL}
          </a>
        </nav>
      </div>
    </footer>
  );
}
