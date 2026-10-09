// SPDX-License-Identifier: AGPL-3.0-only
// The two tables on the Add a computer page: the steps after the first, from ADD_STEPS, STEP_TITLES and stepLine() in
// addFlow.ts, and the rows the setup shows while it runs, from setupRows() and SETUP_ROWS in setup.ts.
import { ADD_STEPS, STEP_TITLES, stepLine, stepsFor } from "../../../apps/web/src/settings/add/addFlow.js";
import { SETUP_ROWS, setupRows } from "../../../apps/web/src/settings/add/setup.js";
import { cell, table, within, type Generated } from "./generated.js";

export default function addAComputer(): Generated[] {
  // The page's own prose says Start from shows only once a recipe is saved; any other step that hides needs a sentence too.
  const hidden = ADD_STEPS.filter(step => !stepsFor(0).includes(step));
  if (hidden.join() !== "startfrom") throw new Error(`steps shown only with a saved recipe are ${hidden.join(", ")}; the page names Start from alone`);
  // The first step is the page's Start the add section.
  const steps = ADD_STEPS.filter(step => step !== "where").map(step => [STEP_TITLES[step], cell(stepLine(step, "the new computer", "your computer"))]);
  const [install] = setupRows({});
  const rows = [[install!.name, cell(install!.note ?? "")], ...SETUP_ROWS.map(row => [row.name, row.doing?.verb ?? ""])];
  return [
    within("content/features/add-a-computer.mdx", {
      "add-steps": table(["Step", "What it does"], steps),
      "setup-rows": table(["Row", "What it says"], rows),
    }),
  ];
}
