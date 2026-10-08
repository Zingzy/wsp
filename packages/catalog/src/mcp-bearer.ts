// SPDX-License-Identifier: AGPL-3.0-only
// The name Codex reads a bearer header by, scheme and all, since it sends a
// header's variable as it holds it. The vault keeps the token alone under the
// header's own name, which every other agent writes after the scheme, and this
// one is read off it wherever the vault's values are read, so one stored value
// serves every agent's copy and a rotation through one reaches the others.

export const mcpBearerVariable = (variable: string): string => `${variable}_BEARER`;

const headerToken = (name: string): boolean => /^WSP_MCP_.+_AUTHORIZATION$/.test(name);

/** The header token a bearer name is read off; nothing for any other name. */
export const bearerOf = (name: string): string | undefined => {
  const token = name.slice(0, -"_BEARER".length);
  return name === mcpBearerVariable(token) && headerToken(token) ? token : undefined;
};

/** The values with each header token's bearer name beside it, a name held itself standing. */
export const withBearerVariables = (values: Readonly<Record<string, string>>): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(values).flatMap(([name, v]) => (headerToken(name) ? [[mcpBearerVariable(name), `Bearer ${v}`]] : []))),
  ...values,
});
