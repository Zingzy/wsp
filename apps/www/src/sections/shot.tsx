// SPDX-License-Identifier: AGPL-3.0-only
import appShot from "@/assets/app.webp";
import appShot1x from "@/assets/app-1x.webp";

export function Shot() {
  return (
    <section className="relative px-3 pt-24 sm:px-6 lg:pt-32">
      <figure className="shot-in mx-auto max-w-[1520px]">
        <img
          src={appShot}
          srcSet={`${appShot1x} 1503w, ${appShot} 3006w`}
          sizes="(min-width: 1424px) 1400px, calc(100vw - 24px)"
          width={3006}
          height={1768}
          alt="The wsp app. Left: workspaces b1 and b2 and their threads. Center: a finished review thread and its composer. Right: the machine's shell and a port it serves, open as a tab."
          className="submerge w-full"
          fetchPriority="high"
        />
      </figure>
    </section>
  );
}
