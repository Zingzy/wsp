// SPDX-License-Identifier: AGPL-3.0-only
// The build in the setup sheet: the rows every client draws, in the sheet's
// frame. The count beside the list; while the sign-in stage runs the screen is
// a slide with room to act, the stage list folded to one line over the
// sign-ins, and the list comes back when the last sign-in settles. Closing the
// screen hides it and the build goes on; the one link stops the job after
// asking once.
import { useState } from "react";
import { CLOUD_SETUP_WORDS, initJobBuilding, initStageCountLine, type InitJob } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { SignInSlide, StageList, buildView } from "../../settings/recipe/BuildRows.js";
import { META } from "../../settings/recipe/rows.js";
import { SetupScreen, type ScreenAction } from "./SetupScreen.js";

export function SetupBuild({ job, onCancel, onRetry, onCode, onOpenWorkspace, onAgain, onChangeKey, refusal }: { job: InitJob; onCancel: () => void; onRetry: (tool: string) => void; onCode: (o: { tool: string; code: string }) => void; onOpenWorkspace: () => void; onAgain: () => void; onChangeKey: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.build;
  const [asking, setAsking] = useState(false);
  const building = initJobBuilding(job.phase);
  const view = buildView(job);
  const acts = { onRetry, onCode };
  // A saved key the provider refused offers the step that fixes it, not another build off the same key.
  const primary: ScreenAction | undefined =
    job.phase === "done" && job.workspace !== undefined ? { word: words.keycap, onPress: onOpenWorkspace } : job.keyRefused === true ? { word: CLOUD_SETUP_WORDS.keys.changeKey, onPress: onChangeKey } : job.phase === "failed" || job.phase === "cancelled" ? { word: words.again, onPress: onAgain } : undefined;
  const secondary: ScreenAction | undefined = building
    ? asking
      ? { word: words.cancelSure, onPress: onCancel, destructive: true, confirm: true }
      : { word: words.cancel, onPress: () => setAsking(true), destructive: true, disabled: !job.stoppable, ...(job.stoppable ? {} : { title: words.cannotStop }) }
    : undefined;
  // The question is one block in the footer: the sentence above, Stop the build and Keep building side by side under it.
  const aside: ScreenAction | undefined = asking && building ? { word: words.cancelKeep, onPress: () => setAsking(false) } : undefined;
  const footer = { ...(secondary !== undefined ? { secondary } : {}), ...(aside !== undefined ? { aside } : {}) };
  if (view.slide) {
    return (
      <SetupScreen k="build" headline={view.headline} top={words.slideTop} refusal={refusal} {...footer} note={asking ? words.cancelWhy : words.keeps}>
        <p data-k="stages-folded" className={cn(META, "mb-2 w-full text-right")}>
          {words.headline} · {initStageCountLine(view.count)}
        </p>
        <SignInSlide view={view} acts={acts} contained />
      </SetupScreen>
    );
  }
  return (
    <SetupScreen k="build" headline={view.headline} top={job.error ?? (job.phase === "done" ? words.doneTop : words.top)} refusal={refusal} {...(primary !== undefined ? { primary } : {})} {...footer} {...(building ? { note: asking ? words.cancelWhy : words.keeps } : {})}>
      <p data-k="count" className={cn(META, "mb-2 w-full text-right")}>
        {initStageCountLine(view.count)}
      </p>
      <StageList job={job} view={view} acts={acts} contained />
    </SetupScreen>
  );
}
