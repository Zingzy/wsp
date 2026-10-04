// SPDX-License-Identifier: AGPL-3.0-only
// Ten things a person might ask a thread for, from the brief's six and four more.
export interface BakeoffPrompt { id: string; text: string }

export const PROMPTS: readonly BakeoffPrompt[] = [
  { id: "01-pr", text: "Put this branch's pull request beside the chat: its state, the review and whether it can merge, every check with how it is doing, a way to hand one failing check to you, and a button that asks you to fix all the failing ones." },
  { id: "02-tracker", text: "You're about to do a five-step refactor of the auth module (extract the token store, move session checks into middleware, delete the old cookie path, update the tests, write the migration note). Give me a tracker: the five steps with checkboxes I can tick, how many are done, and a button that tells you to go on to the next step." },
  { id: "03-usage", text: "I keep losing track of limits. Show how full this thread's context is, my plan's 5-hour and weekly usage with when each resets, and make anything over 80% look like a warning." },
  { id: "04-setup", text: "Walk me through setting up the Stripe webhook in three short explained steps. I need to paste the webhook signing secret and the endpoint URL somewhere, then press one button that sends both to you so you can write the config." },
  { id: "05-files", text: "List the files this thread changed with the lines added and removed for each, and on every row a button that asks you to explain that file's change." },
  { id: "06-playful", text: "Make me something fun: a coffee meter that fills as this thread's context fills, a cheeky caption that changes at 50% and again at 80%, and a button that tells you to take a break and summarise where we are." },
  { id: "07-cost", text: "Show what this thread has cost so far, its input and output tokens, what the workspace costs per hour, and how long the last turn took." },
  { id: "08-git", text: "Show the branch, how far it is ahead of and behind upstream, and how many files are changed. When it is behind, show a button asking you to rebase onto upstream." },
  { id: "09-plan", text: "Show your current plan's steps with the state of each and a count of how many are done. Add a text box where I can type an extra step and send it to you." },
  { id: "10-choose", text: "You suggested three databases for the job queue: Postgres (already running, row locks), SQLite (zero setup, one writer) and DynamoDB (managed, costs money). Show them as a small comparison table, let me pick one with a button on its row, and give me a note box that goes along with my pick." },
];
