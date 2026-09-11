// SPDX-License-Identifier: AGPL-3.0-only
// One refusal shape for every route: the status the person or the command line
// reads, and one sentence saying what to do about it.

export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const refuse = (status: number, message: string): Refusal => new Refusal(status, message);
