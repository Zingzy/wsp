// SPDX-License-Identifier: AGPL-3.0-only
import { Github } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";
import { INSTALL, RELEASES, REPO } from "@/links";

export function Wordmark() {
  return (
    <a href="#top" className="flex items-baseline gap-1 font-display text-[28px] leading-none text-foreground">
      <span aria-hidden="true" className="text-sky">
        ~
      </span>
      <span>wsp</span>
    </a>
  );
}

const LINKS = [
  { href: "#story", label: "How it works" },
  { href: "#agents", label: "For your agent" },
  { href: "#compare", label: "Compare" },
  { href: "#machines", label: "Machines" },
  { href: "#faq", label: "Questions" },
  { href: RELEASES, label: "Releases" },
];

export function Nav() {
  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
        <Wordmark />
        <ul className="hidden items-center gap-7 text-[15px] text-muted-foreground md:flex">
          {LINKS.map(link => (
            <li key={link.href}>
              <a href={link.href} className="transition-colors hover:text-foreground">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <a
            href={REPO}
            aria-label="wsp on GitHub"
            className="flex size-9 items-center justify-center border border-input text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            <Github className="size-4" />
          </a>
          <CopyCommand command={INSTALL} className="hidden sm:inline-flex" />
        </div>
      </nav>
    </header>
  );
}
