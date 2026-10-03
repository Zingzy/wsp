// SPDX-License-Identifier: AGPL-3.0-only
// The one reading of what a secret looks like in a recipe or a file it lands,
// so the recipe writer and the configs' cuts cannot disagree.

/** What a key or a token looks like, anywhere in a name or a value: OpenAI's and Anthropic's keys, Google's, GitHub's
 * and GitLab's tokens, Slack's, an AWS access key id, a JWT and any private key's header. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-(?:proj-|ant-)?(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}/,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9])gh[opsur]_[A-Za-z0-9]{20,}/,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const tokenShaped = (text: string): boolean => TOKEN_SHAPES.some(shape => shape.test(text));
