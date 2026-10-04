# Slate syntax bake-off

Each prompt written once per syntax per agent from the reference alone; a refused write gets the validator's errors once. Tokens are the first write's slate, characters / 4; API tokens are what the agent reported for that call, thinking included.

| syntax | agent | first try valid | valid within two | mean slate tokens | mean API output tokens | reference tokens |
|---|---|---|---|---|---|---|
| jsx | claude (claude-opus-5-5) | 7/10 | 9/10 | 430 | 1063 | 4749 |
| jsx | codex (gpt-5.6-sol (high)) | 9/10 | 9/10 | 285 | 429 | 4749 |
| lines | claude (claude-opus-5-5) | 6/10 | 9/10 | 352 | 1002 | 4471 |
| lines | codex (gpt-5.6-sol (high)) | 8/10 | 8/10 | 256 | 608 | 4471 |

## Error codes, every write

- lines: X400 expr-syntax x5, P102 unknown-flag x2, X409 item-outside-scope x2, X407 expr-limit x1
- jsx: X400 expr-syntax x4, X409 item-outside-scope x3, P102 unknown-flag x1, T303 prop-type x1

## Every run

| prompt | agent | syntax | first write | second write | slate tokens | does it do what was asked |
|---|---|---|---|---|---|---|
| 01-pr | claude | jsx | valid |  | 589 | Yes: state, review, mergeable, checks with a send on each failing row, fix-all button; adds the subject and branch. |
| 01-pr | claude | lines | valid |  | 487 | Yes: every asked part, plus the subject and a behind-base fact. |
| 01-pr | codex | jsx | valid |  | 356 | Yes: every asked part; drops the duration column. |
| 01-pr | codex | lines | valid |  | 306 | Yes: every asked part, close to the reference's own example. |
| 02-tracker | claude | jsx | X400 X400 | valid | 768 | Yes (second write): five toggle buttons beside the steps, a done meter, go-on button hidden once all are ticked. |
| 02-tracker | claude | lines | valid |  | 526 | Yes: five toggle buttons beside the steps, a done meter, go-on button hidden once all are ticked. |
| 02-tracker | codex | jsx | valid |  | 436 | Yes: five toggle buttons with the tick in the label, a done count, a go-on button. |
| 02-tracker | codex | lines | valid |  | 522 | Yes: toggle buttons beside the steps, a count and a meter, a go-on button. |
| 03-usage | claude | jsx | valid |  | 473 | Yes: context meter, 5-hour and weekly with reset times, warning tone over 80 on all three. |
| 03-usage | claude | lines | valid |  | 367 | Yes: context meter, 5-hour and weekly with reset times, warning tone over 80 on all three. |
| 03-usage | codex | jsx | valid |  | 373 | Yes: context meter, both windows with resets, warning tone over 80 on all three. |
| 03-usage | codex | lines | valid |  | 184 | Yes: three meters with resets and warnings over 80, the smallest of the four. |
| 04-setup | claude | jsx | valid |  | 542 | Yes: three explained steps, two inputs, the send button shows only once both are filled. |
| 04-setup | claude | lines | X400 | valid | 525 | Yes (second write): three explained steps, two inputs, button held until both are filled, clears the secret after. |
| 04-setup | codex | jsx | valid |  | 365 | No: the button has a literal held, so it is always disabled and can never send. |
| 04-setup | codex | lines | valid |  | 293 | Yes: three steps, two inputs, button held until both are pasted; the explanations are thin. |
| 05-files | claude | jsx | valid |  | 189 | Yes: path, added, removed, an Explain row action sending the file, a totals line. |
| 05-files | claude | lines | valid |  | 170 | Yes: path, added, removed, an Explain row action sending the file, a totals line. |
| 05-files | codex | jsx | valid |  | 130 | Yes: path, added, removed, an Explain row action sending the file. |
| 05-files | codex | lines | valid |  | 120 | Yes: path, added, removed, an Explain row action sending the file. |
| 06-playful | claude | jsx | valid |  | 388 | Yes: coffee meter on context, captions switching at 50 and 80, break button queued after the turn. |
| 06-playful | claude | lines | valid |  | 313 | Yes: coffee meter on context, captions switching at 50 and 80, break button. |
| 06-playful | codex | jsx | valid |  | 283 | Yes: coffee meter, captions switching at 50 and 80, break button. |
| 06-playful | codex | lines | valid |  | 190 | Yes: coffee meter, captions switching at 50 and 80, break button. |
| 07-cost | claude | jsx | X400 X400 | valid | 250 | Yes (second write): cost, input and output tokens, hourly rate, last turn's duration. |
| 07-cost | claude | lines | X400 | valid | 190 | Yes (second write): cost, input and output tokens, hourly rate, last turn's duration. |
| 07-cost | codex | jsx | valid |  | 152 | Yes: cost, input and output tokens, hourly rate, last turn's duration. |
| 07-cost | codex | lines | valid |  | 113 | Yes: every asked figure; the rate's note repeats per hour. |
| 08-git | claude | jsx | valid |  | 332 | Yes: branch, ahead, behind, changed, rebase button only when behind; handles unknown counts. |
| 08-git | claude | lines | X400 X400 | valid | 260 | Yes (second write): branch, ahead, behind, changed, rebase button only when behind; handles unknown counts. |
| 08-git | codex | jsx | valid |  | 172 | Yes: branch, ahead, behind, changed, rebase button only when behind. |
| 08-git | codex | lines | valid |  | 136 | Yes: branch, ahead, behind, changed, rebase button only when behind. |
| 09-plan | claude | jsx | valid |  | 423 | Yes, by a trick: the done count reads the length of the joined state words (pending and working are both 7 letters); correct, fragile. |
| 09-plan | claude | lines | valid |  | 355 | Yes, by the same word-length trick for the done count; correct, fragile. |
| 09-plan | codex | jsx | valid |  | 214 | No: count(pluck(...) == 'done') compares a list to a string and always shows 0; the validator let it through. |
| 09-plan | codex | lines | X407 | X400 | 421 | Never valid: summed twelve indexed steps (over 500 characters), then a list literal the language lacks. |
| 10-choose | claude | jsx | P102 | X409 | 349 | Never valid: picking a row with set(state.pick, item.name) is refused as X409. |
| 10-choose | claude | lines | P102 | X409 | 328 | Never valid: picking a row with set ... value={item.name} is refused as X409. |
| 10-choose | codex | jsx | X409 | T303 X409 | 365 | Never valid: X409 on the row pick; the error pointed at the table's line, so it changed key to a string. |
| 10-choose | codex | lines | P102 | X409 | 276 | Never valid: picking a row with set ... value={item.name} is refused as X409. |
