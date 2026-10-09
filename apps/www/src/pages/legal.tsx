// SPDX-License-Identifier: AGPL-3.0-only
// The privacy, terms and security pages. Every line is checked against the audit of what wsp sends and keeps
// (wsp-map #1915) and the owner's rulings on #1917; a change to what wsp sends changes these pages too.
import type { ReactNode } from "react";
import { Section } from "@/components/section";
import { REPO } from "@/links";

export const LEGAL_EMAIL = "aditya@usewsp.com";
export const LEGAL_UPDATED = "9 October 2026";
const MAIL = <a href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>;
const REPORT = `${REPO}/security/advisories/new`;

function Page({ title, lede, children }: { title: string; lede: ReactNode; children: ReactNode }) {
  return (
    <main>
      <Section className="pt-36 sm:pt-44">
        <article className="mx-auto max-w-[680px]">
          <p className="font-mono text-[13px] text-faint">Updated {LEGAL_UPDATED}</p>
          <h1 className="heading mt-4 text-[36px] sm:text-[48px]">{title}</h1>
          <p className="lede mt-5 text-[17px] sm:text-[18px] [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-[3px]">{lede}</p>
          <div className="legal mt-12">{children}</div>
        </article>
      </Section>
    </main>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy" lede={<>wsp runs coding agents on computers you own. This page says what wsp itself collects or sends, and where it goes. For a question, a copy of your data or a deletion, write to {MAIL}.</>}>
      <h2>The short version</h2>
      <ul>
        <li>Your code, prompts, transcripts and keys stay on your computers. wsp has no account and keeps none of them, unless you link the relay described below.</li>
        <li>Your agents talk to their own companies, such as Anthropic, OpenAI or Cursor, under your sign-in and their terms. wsp does not sit in between.</li>
        <li>The app sends anonymous usage counts to PostHog. You can turn them off.</li>
      </ul>

      <h2>This website</h2>
      <ul>
        <li>usewsp.com is served by Cloudflare, which sees each request (address, browser, page) as any host does.</li>
        <li>PostHog counts visits in its cookieless mode: page views, clicks and the page you came from, processed in PostHog's EU cloud. Nothing is stored in your browser, and usewsp.com sets no cookies.</li>
        <li>If you join the Windows waitlist, your email goes to Resend. We keep it until we announce Windows, then delete it. Ask and we remove it sooner.</li>
        <li>The docs are hosted by Scalar, which may set one cookie the docs need to work.</li>
      </ul>

      <h2>The app and the command line</h2>
      <ul>
        <li>
          <strong>Usage counts</strong> go to PostHog's EU cloud: which agent and model a thread used, how its turns ended, their length, tokens and cost, how many projects and computers you have, your wsp version and system. Each carries a random install ID, never a path, prompt, file, name or key. Turn them off in Settings, Privacy,
          or with <code>WSP_ANALYTICS=0</code>.
        </li>
        <li>
          <strong>Update checks</strong> ask GitHub for new wsp releases, and npm, GitHub and Anthropic for each agent's newest version. <code>WSP_UPDATE_CHECK=0</code> stops them. The app downloads its own updates from GitHub.
        </li>
        <li>
          <strong>Icons.</strong> To draw an icon, the host name of a remote tool server, and of a link in an agent's reply, is sent to Google's icon service. Settings, Privacy turns off the tool server icons.
        </li>
        <li>The Usage page downloads a model price table from GitHub. Searching for skills sends your search words to skills.sh. Images in replies and pull request avatars load from wherever they are hosted.</li>
      </ul>

      <h2>Computers you add</h2>
      <p>Setup copies what you pick over SSH to your own computer: agent settings, tool servers, skills, and git and shell settings. Sign-in files are never copied; you sign in on that computer. Your GitHub token is copied unless you choose to sign in there or skip GitHub. Removing a computer deletes wsp's own files there; your work folder and the sign-ins you made there stay.</p>

      <h2>The relay, if you use it</h2>
      <p>The relay lets you reach a computer from anywhere. If you link it, we keep your GitHub user ID and login on Cloudflare until you ask us to delete them, and your computers' names, key fingerprints and when each was last seen until you unlink them. A connection through the relay passes through Cloudflare, which can read it on the way. Write to us to delete your relay account, or run your own relay.</p>

      <h2>On your own computers</h2>
      <p>wsp keeps transcripts, settings and usage history in its folder, and your keys in a file only your user can read. The keys are not encrypted and wsp never writes to your Keychain. Deleting a thread removes wsp's copy; the agent's own session files stay in the agent's folder.</p>

      <h2>Companies involved</h2>
      <ul>
        <li>
          <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare</a>: this website, its DNS, the relay.
        </li>
        <li>
          <a href="https://posthog.com/privacy">PostHog</a>: usage counts and website visits, in the EU.
        </li>
        <li>
          <a href="https://resend.com/legal/privacy-policy">Resend</a>: the Windows waitlist.
        </li>
        <li>
          <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub</a> and <a href="https://docs.npmjs.com/policies/privacy">npm</a>: downloads, releases, update checks, relay sign-in.
        </li>
        <li>
          <a href="https://policies.google.com/privacy">Google</a>: icons, and email at usewsp.com.
        </li>
        <li>
          <a href="https://scalar.com/privacy-policy">Scalar</a>: the docs.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>You can ask for a copy of what we hold about you, for a correction, or for deletion, by writing to {MAIL}. We answer within 30 days. wsp is not meant for anyone under 16.</p>

      <h2>Changes</h2>
      <p>When this page changes, the date at the top changes with it.</p>
    </Page>
  );
}

export function Terms() {
  return (
    <Page title="Terms" lede={<>These terms cover usewsp.com, the docs, the relay and the waitlist. Using them means you accept these terms. Questions go to {MAIL}.</>}>
      <h2>The software</h2>
      <p>
        wsp is open source under the <a href={`${REPO}/blob/main/LICENSE`}>GNU AGPL 3.0</a>. The licence governs the code, including its disclaimer of warranty.
      </p>

      <h2>Your agents and your accounts</h2>
      <p>wsp starts agents that act with your sign-ins on your computers. Each agent's company has its own terms, and its usage is yours to pay. What your agents do is your responsibility.</p>

      <h2>Computers you add</h2>
      <p>Add only computers you own or are allowed to run software on with administrator rights. wsp installs a background service there.</p>

      <h2>The relay</h2>
      <p>The relay is free and optional, and needs a GitHub account. It runs on a best-effort basis and may change or stop. Do not use it to break the law or to attack anyone; we may close accounts that do.</p>

      <h2>No warranty</h2>
      <p>wsp and its services are provided as they are, without warranty of any kind. As far as the law allows, we are not liable for lost data, lost work, or anything your agents do.</p>

      <h2>The name</h2>
      <p>Do not use the wsp name or logo in a way that suggests we made or endorse something we did not.</p>

      <h2>Age and changes</h2>
      <p>You must be 16 or older to use wsp. When these terms change, the date at the top changes with them.</p>
    </Page>
  );
}

export function Security() {
  return (
    <Page title="Security" lede="How the parts of wsp trust each other, what it does with your keys, and how to tell us about a problem.">
      <h2>Report a problem</h2>
      <p>
        Use <a href={REPORT}>GitHub's private vulnerability reporting</a> or write to {MAIL}. Say which version, how to reproduce it and what it lets someone do. We reply within a week. Please do not open a public issue first. Fixes go into the latest release.
      </p>
      <p>In scope: the desktop app, the host, the command line, the MCP server, the daemon on computers you add, the relay and usewsp.com.</p>

      <h2>How the parts connect</h2>
      <ul>
        <li>The host listens on 127.0.0.1 and asks for a token kept beside its state. Once you add a computer, it also listens on port 4420.</li>
        <li>The daemon on a computer you add listens only on that computer's loopback and dials out to your host. Each link opens with an ed25519 handshake against a pinned key, and every message after it is sealed with AES-256-GCM.</li>
        <li>The daemon runs as root on that computer, and every workspace there can read its home folder.</li>
      </ul>

      <h2>Keys</h2>
      <p>Your keys live in a file only your user can read. They are not encrypted, and wsp never writes them to your Keychain. wsp hands them to the threads that need them, on your Mac and on computers you add.</p>

      <h2>The relay</h2>
      <p>A connection through the relay passes through a Cloudflare Tunnel, which ends encryption at Cloudflare and lets Cloudflare read it. Reach your computers over your own network or SSH to avoid it. Your own relay takes us out of the path, not Cloudflare.</p>

      <h2>Releases</h2>
      <p>Releases are built by GitHub Actions from tags. The install script and the app's self-update check each download's sha256, and the npm package carries provenance. The Mac app is signed ad hoc and the Linux AppImage is unsigned for now.</p>
    </Page>
  );
}
