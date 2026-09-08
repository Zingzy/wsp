## What it does

Two sentences.

## Ticket

Zingzy/wsp-map#

## How it was proven

The test that was red before the change and is green after, or why there is none. For anything a person sees, what you ran and what you saw.

## Laws checked

- [ ] Every fact has one home: no second copy of a type, a predicate, a path rule or a size rule.
- [ ] Anything that varies by kind sits behind its registry, with one module per variant and no id switch outside it.
- [ ] Bytes, durations, costs, sizes and shell text are formatted through `packages/protocol/src/format.ts`.
- [ ] Comments are one line and state a constraint the code cannot show.
- [ ] No em-dashes in code, comments, docs or the commit message.
- [ ] Every place this departs from the ticket is named above, with the reason.
