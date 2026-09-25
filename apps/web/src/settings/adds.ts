// SPDX-License-Identifier: AGPL-3.0-only
// The adds over ssh as the host keeps them: read off places.list whenever the
// store binds, kept current by the steps that ride place.stage, and settled
// by an add's own answer in the window that asked. The sheet draws the job
// from here, so a reload, another page or a second window reads the same
// install.
import { create } from "zustand";
import { PLACE_LOGIN_REFUSED_KIND, withPlaceStage, type PlaceAddJob, type PlaceStageEvent } from "@wsp/protocol";
import type { Api, SshLogin } from "../protocol/client.js";
import { failureOf } from "../protocol/failure.js";
import { ADD_COMPUTER_WORDS } from "./format.js";

interface AddsState {
  jobs: Record<string, PlaceAddJob>;
  /** The finished add the person put away with Add another: the form stands empty over it. */
  putAway: string | null;
}

export const useAdds = create<AddsState>(() => ({ jobs: {}, putAway: null }));

const put = (job: PlaceAddJob): void => useAdds.setState(s => ({ jobs: { ...s.jobs, [job.addId]: job } }));

let reading = false;
let again = false;

/** One read at a time; a read asked for while one is out goes after it, since the one out may predate what asked. */
export function readAdds(api: Api): void {
  if (api.addsList === undefined) return;
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  void api
    .addsList()
    .then(
      // A read that left before an add ended never takes the end back.
      list => useAdds.setState(s => ({ jobs: { ...s.jobs, ...Object.fromEntries(list.map(job => [job.addId, job.state === "running" && s.jobs[job.addId] !== undefined && s.jobs[job.addId]!.state !== "running" ? s.jobs[job.addId]! : job])) } })),
      // The adds ride places.list, whose refusal the Computers page already draws and says.
      () => undefined,
    )
    .finally(() => {
      reading = false;
      if (again) {
        again = false;
        readAdds(api);
      }
    });
}

/** One step onto its job. A stream this app has not seen is an add another window started, read off the host; a
 * failed step is read again for the fix and the kind its one-line note does not carry. */
export function applyAddStage(api: Api | null, e: PlaceStageEvent): void {
  if (e.step === "provision") return;
  const job = useAdds.getState().jobs[e.addId];
  if (job !== undefined) put(withPlaceStage(job, e));
  if (api !== null && (job === undefined || e.state === "failed")) readAdds(api);
}

const mintAddId = (): string => `a_${[...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("")}`;

/** Asks the host to add a computer over ssh under a stream minted here, since its steps arrive before the answer. A
 * lost socket leaves the job running: the host goes on installing, and the read on reconnect says how it ended. */
export function addOverSsh(api: Api, login: SshLogin): void {
  if (api.addComputerOverSsh === undefined) return;
  const addId = mintAddId();
  put({ addId, address: login.address, ...(login.port === undefined ? {} : { sshPort: login.port }), startedAt: new Date().toISOString(), state: "running", steps: [] });
  const settle = (next: (job: PlaceAddJob) => PlaceAddJob): void => {
    const job = useAdds.getState().jobs[addId];
    if (job !== undefined) put(next(job));
  };
  api.addComputerOverSsh(login, addId).then(
    place => settle(job => ({ ...job, state: "done", placeId: place.id })),
    (e: unknown) => {
      const failure = failureOf(e);
      if (failure.disconnected) return;
      settle(job => ({ ...job, state: "failed", said: failure.said, ...(failure.fix === undefined ? {} : { fix: failure.fix }), ...(failure.kind === undefined ? {} : { kind: failure.kind }) }));
    },
  );
}

/** The fix under a failed add: the host's own, else the login fix for a login ssh refused, else none. */
export const addFix = (job: PlaceAddJob): string | undefined => job.fix ?? (job.kind === PLACE_LOGIN_REFUSED_KIND ? ADD_COMPUTER_WORDS.refusedFix : undefined);

/** The add the sheet draws: the one this app heard of last, unless the person put it away. Read by the order jobs
 * arrived in, not their stamps: an add asked here is stamped by this clock and one read off the host by its own. */
export function useShownAdd(): PlaceAddJob | undefined {
  return useAdds(s => {
    const newest = Object.values(s.jobs).at(-1);
    return newest?.addId === s.putAway ? undefined : newest;
  });
}
