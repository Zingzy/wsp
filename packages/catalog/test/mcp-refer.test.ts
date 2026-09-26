// SPDX-License-Identifier: AGPL-3.0-only
// A server's definition as it lands on a machine: every header and every
// variable its command is given written as the name of a variable, in the
// syntax the agent's own file expands, and the values handed back for the
// vault. What the agent reads back is the same server with only names in it.
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { CODEX_TOML, GEMINI_SETTINGS_JSON, MCP_SERVERS_JSON, OPENCODE_JSON, mcpHeaderVariable, parseJsonc, serversByName, type McpFormat } from "../src/index.js";

const HOME = "/Users/dev";
const TOKEN = "lin_api_TESTONLY";
const NOTION = "ntn_TESTONLY";

describe("the name a header's value travels under", () => {
  it("is WSP_MCP_<SERVER>_<HEADER> in capitals, every other character an underscore", async () => {
    expect(mcpHeaderVariable("linear", "Authorization")).toBe("WSP_MCP_LINEAR_AUTHORIZATION");
    expect(mcpHeaderVariable("my-docs.v2", "X-Api-Key")).toBe("WSP_MCP_MY_DOCS_V2_X_API_KEY");
  });
});

describe("Claude Code's reference writer", () => {
  const file = JSON.stringify(
    {
      numStartups: 3,
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${TOKEN}`, "X-Team": "eng" } },
        notion: { command: "npx", args: ["-y", "notion-mcp"], env: { NOTION_TOKEN: NOTION, LOG: "${LOG_LEVEL:-info}" } },
        mine: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer ${MY_TOKEN}" } },
      },
      projects: { [HOME]: { mcpServers: { zomato: { type: "http", url: "https://z.example/mcp", headers: { "X-Key": "zk_TESTONLY" } } } } },
    },
    null,
    2,
  );

  it("writes ${NAME} in headers and env, the bearer's token alone in the vault, and leaves a name the person already wrote as they wrote it", async () => {
    const out = await MCP_SERVERS_JSON.refer(file);
    const root = parseJsonc(out.text) as { mcpServers: Record<string, { headers?: Record<string, string>; env?: Record<string, string> }>; projects: Record<string, { mcpServers: Record<string, { headers: Record<string, string> }> }> };
    expect(root.mcpServers.linear!.headers).toEqual({ Authorization: "Bearer ${WSP_MCP_LINEAR_AUTHORIZATION}", "X-Team": "${WSP_MCP_LINEAR_X_TEAM}" });
    expect(root.mcpServers.notion!.env).toEqual({ NOTION_TOKEN: "${NOTION_TOKEN}", LOG: "${LOG_LEVEL:-info}" });
    expect(root.mcpServers.mine!.headers).toEqual({ Authorization: "Bearer ${MY_TOKEN}" });
    expect(root.projects[HOME]!.mcpServers.zomato!.headers).toEqual({ "X-Key": "${WSP_MCP_ZOMATO_X_KEY}" });
    expect(out.servers).toEqual([
      { name: "linear", values: { WSP_MCP_LINEAR_AUTHORIZATION: TOKEN, WSP_MCP_LINEAR_X_TEAM: "eng" } },
      { name: "notion", values: { NOTION_TOKEN: NOTION } },
      { name: "mine", values: {} },
      { name: "zomato", project: HOME, values: { WSP_MCP_ZOMATO_X_KEY: "zk_TESTONLY" } },
    ]);
    for (const secret of [TOKEN, NOTION, "zk_TESTONLY"]) expect(out.text).not.toContain(secret);
    // The agent's own reader sees the names the definition now reads.
    expect(MCP_SERVERS_JSON.read(out.text, HOME).find(s => s.name === "linear")!.envRefs).toEqual(["WSP_MCP_LINEAR_AUTHORIZATION", "WSP_MCP_LINEAR_X_TEAM"]);
  });

  it("keeps every other key and comment of the file where it was", async () => {
    const text = '{\n  // mine\n  "theme": "dark",\n  "mcpServers": {\n    "a": { "command": "x", "env": { "K": "v1" } } // the a server\n  }\n}\n';
    const out = await MCP_SERVERS_JSON.refer(text);
    expect(out.text).toBe('{\n  // mine\n  "theme": "dark",\n  "mcpServers": {\n    "a": { "command": "x", "env": { "K": "${K}" } } // the a server\n  }\n}\n');
  });

  it("names one server alone when asked, and stands byte for byte where nothing holds a value", async () => {
    expect((await MCP_SERVERS_JSON.refer(file, "notion")).servers.map(s => s.name)).toEqual(["notion"]);
    expect((await MCP_SERVERS_JSON.refer(file, "notion")).text).toContain(TOKEN);
    const plain = '{ "mcpServers": { "a": { "command": "x" } } }';
    expect((await MCP_SERVERS_JSON.refer(plain)).text).toBe(plain);
  });
});

describe("the other JSON formats write their own syntax", () => {
  it("Gemini CLI writes ${NAME}, OpenCode {env:NAME}", async () => {
    const gemini = await GEMINI_SETTINGS_JSON.refer(JSON.stringify({ mcpServers: { l: { httpUrl: "https://l.example", headers: { Authorization: `Bearer ${TOKEN}` } } } }));
    expect(gemini.text).toContain('"Bearer ${WSP_MCP_L_AUTHORIZATION}"');
    const opencode = await OPENCODE_JSON.refer(JSON.stringify({ mcp: { l: { type: "remote", url: "https://l.example", headers: { Authorization: `Bearer ${TOKEN}` } }, n: { type: "local", command: ["npx"], environment: { NOTION_TOKEN: NOTION } } } }));
    const root = parseJsonc(opencode.text) as { mcp: { l: { headers: Record<string, string> }; n: { environment: Record<string, string> } } };
    expect(root.mcp.l.headers).toEqual({ Authorization: "Bearer {env:WSP_MCP_L_AUTHORIZATION}" });
    expect(root.mcp.n.environment).toEqual({ NOTION_TOKEN: "{env:NOTION_TOKEN}" });
    expect(opencode.servers).toEqual([
      { name: "l", values: { WSP_MCP_L_AUTHORIZATION: TOKEN } },
      { name: "n", values: { NOTION_TOKEN: NOTION } },
    ]);
  });
});

describe("Codex's reference writer", () => {
  it("writes bearer_token_env_var, env_http_headers and env_vars in place of the values, every other line as it was", async () => {
    const text = [
      'model = "gpt-5"',
      "",
      "# linear, added by hand",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      `http_headers = { "Authorization" = "Bearer ${TOKEN}", "X-Team" = "eng" }`,
      "startup_timeout_sec = 20",
      "",
      "[mcp_servers.notion]",
      'command = "npx"',
      'args = ["-y", "notion-mcp"]',
      "",
      "[mcp_servers.notion.env]",
      `NOTION_TOKEN = "${NOTION}"`,
      "",
      "[projects.\"/Users/dev\"]",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const out = await CODEX_TOML.refer(text);
    expect(out.text).toBe(
      [
        'model = "gpt-5"',
        "",
        "# linear, added by hand",
        "[mcp_servers.linear]",
        'bearer_token_env_var = "WSP_MCP_LINEAR_AUTHORIZATION"',
        'env_http_headers = { "X-Team" = "WSP_MCP_LINEAR_X_TEAM" }',
        'url = "https://mcp.linear.app/mcp"',
        "startup_timeout_sec = 20",
        "",
        "[mcp_servers.notion]",
        'env_vars = ["NOTION_TOKEN"]',
        'command = "npx"',
        'args = ["-y", "notion-mcp"]',
        "",
        "[projects.\"/Users/dev\"]",
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    expect(out.servers).toEqual([
      { name: "linear", values: { WSP_MCP_LINEAR_AUTHORIZATION: TOKEN, WSP_MCP_LINEAR_X_TEAM: "eng" } },
      { name: "notion", values: { NOTION_TOKEN: NOTION } },
    ]);
    const read = CODEX_TOML.read(out.text, HOME);
    expect(read.find(s => s.name === "linear")).toMatchObject({ transport: { kind: "http", headers: {} }, envRefs: ["WSP_MCP_LINEAR_AUTHORIZATION", "WSP_MCP_LINEAR_X_TEAM"] });
    expect(read.find(s => s.name === "notion")).toMatchObject({ transport: { kind: "stdio", env: {} } });
  });

  it("adds to the names a table already reads rather than writing a key twice", async () => {
    const text = ["[mcp_servers.a]", 'url = "https://a.example"', 'bearer_token_env_var = "A_TOKEN"', 'env_http_headers = { "X-One" = "ONE" }', 'http_headers = { "Authorization" = "Bearer x1", "X-Two" = "two" }', ""].join("\n");
    const out = await CODEX_TOML.refer(text);
    expect(out.text).toBe(["[mcp_servers.a]", 'url = "https://a.example"', 'bearer_token_env_var = "A_TOKEN"', 'env_http_headers = { "X-One" = "ONE", "Authorization" = "WSP_MCP_A_AUTHORIZATION", "X-Two" = "WSP_MCP_A_X_TWO" }', ""].join("\n"));
    expect(out.servers[0]!.values).toEqual({ WSP_MCP_A_AUTHORIZATION: "Bearer x1", WSP_MCP_A_X_TWO: "two" });
    const stdio = ["[mcp_servers.b]", 'command = "b"', 'env_vars = ["HOME_DIR"]', 'env = { K = "v" }', ""].join("\n");
    expect((await CODEX_TOML.refer(stdio)).text).toBe(["[mcp_servers.b]", 'command = "b"', 'env_vars = ["HOME_DIR", "K"]', ""].join("\n"));
  });
});

describe("a whole file's servers by name", () => {
  const claude = (servers: Record<string, unknown>): string => JSON.stringify({ mcpServers: servers }, null, 2);
  const rows = (name: string): string | undefined => (name === "GEMINI_API_KEY" ? "Gemini CLI" : undefined);

  it("hands every value to the vault once and takes out a server that sets a name another already holds with another value", async () => {
    const held = new Map<string, { value: string; by: string }>();
    const first = await serversByName(MCP_SERVERS_JSON, claude({ notion: { command: "a", env: { NOTION_TOKEN: NOTION } } }), held, rows);
    expect(first.dropped).toEqual([]);
    const second = await serversByName(CODEX_TOML, ["[mcp_servers.other]", 'command = "b"', `env = { NOTION_TOKEN = "ntn_OTHER" }`, "", "[mcp_servers.same]", 'command = "c"', `env = { NOTION_TOKEN = "${NOTION}" }`, ""].join("\n"), held, rows);
    expect(second.dropped).toEqual([{ name: "other", reason: "sets NOTION_TOKEN, which notion already sets to another value" }]);
    expect(second.text).not.toContain("ntn_OTHER");
    expect(second.text).toContain('[mcp_servers.same]\nenv_vars = ["NOTION_TOKEN"]');
    expect([...held]).toEqual([["NOTION_TOKEN", { value: NOTION, by: "notion" }]]);
  });

  it("takes out of the copy a server that sets a catalog row's own variable, or a value on more than one line, each with its reason", async () => {
    const held = new Map<string, { value: string; by: string }>();
    const out = await serversByName(MCP_SERVERS_JSON, claude({ gem: { command: "gem-mcp", env: { GEMINI_API_KEY: "gem_TESTONLY" } }, pem: { command: "p", env: { KEY: "-----BEGIN\nx\n-----END" } } }), held, rows);
    expect(out.dropped).toEqual([
      { name: "gem", reason: "GEMINI_API_KEY belongs to the Gemini CLI key, so set it there or give the variable another name" },
      { name: "pem", reason: "sets KEY to a value on more than one line, which cannot travel by name" },
    ]);
    expect(out.text).not.toContain("gem_TESTONLY");
    expect(out.text).not.toContain("BEGIN");
    expect(held.size).toBe(0);
  });

  it("throws the format's own words where a file is not the format, so a caller never copies it as it was", async () => {
    const formats: McpFormat[] = [MCP_SERVERS_JSON, GEMINI_SETTINGS_JSON, OPENCODE_JSON];
    for (const f of formats) await expect(serversByName(f, "not json", new Map(), rows)).rejects.toThrow("the file is not valid JSON");
  });
});

describe("what a reference writer refuses rather than guess", () => {
  it("Codex: every TOML spelling of a server's headers and variables reads as one tree, so none of them travels with its value", async () => {
    const spellings: [string, string, Record<string, string>][] = [
      ['mcp_servers.linear = { url = "https://l.example", http_headers = { Authorization = "Bearer tok_INLINE" } }\n', "tok_INLINE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_INLINE" }],
      ['[mcp_servers]\nlinear = { url = "https://l.example", http_headers = { Authorization = "Bearer tok_BARE" } }\n', "tok_BARE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_BARE" }],
      ['[mcp_servers]\nlinear.url = "https://l.example"\nlinear.http_headers.Authorization = "Bearer tok_DOTTEDBARE"\n', "tok_DOTTEDBARE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_DOTTEDBARE" }],
      ['[mcp_servers.linear]\nurl = "https://l.example"\nhttp_headers.Authorization = "Bearer tok_DOTTED"\n', "tok_DOTTED", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_DOTTED" }],
      ['[mcp_servers.notion]\ncommand = "npx"\nenv.NOTION_TOKEN = "ntn_DOTTED"\n', "ntn_DOTTED", { NOTION_TOKEN: "ntn_DOTTED" }],
      ['[mcp_servers.linear]\nurl = "https://l.example"\n\n[mcp_servers.linear."http_headers"]\nAuthorization = "Bearer tok_QUOTED"\n', "tok_QUOTED", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_QUOTED" }],
      ['[mcp_servers.linear]\nurl = "https://l.example"\nhttp_headers = { Authorization = """Bearer tok_MULTILINE""" }\n', "tok_MULTILINE", { WSP_MCP_LINEAR_AUTHORIZATION: "tok_MULTILINE" }],
    ];
    for (const [text, secret, values] of spellings) {
      const out = await CODEX_TOML.refer(text);
      expect(out.text, text).not.toContain(secret);
      expect(out.servers.map(s => s.values), text).toEqual([values]);
      const read = parseToml(out.text) as { mcp_servers: Record<string, Record<string, unknown>> };
      const def = Object.values(read.mcp_servers)[0]!;
      expect(def["http_headers"], text).toBeUndefined();
      expect(def["env"], text).toBeUndefined();
      expect(def["bearer_token_env_var"] ?? def["env_vars"], text).toEqual(Object.keys(values)[0] === "NOTION_TOKEN" ? ["NOTION_TOKEN"] : "WSP_MCP_LINEAR_AUTHORIZATION");
    }
  });

  it("Codex: refuses a server shape it cannot map, so the file stays on this computer rather than travel with its token", async () => {
    const shapes: [string, string][] = [
      ['[[mcp_servers.linear]]\nurl = "https://l.example"\nhttp_headers = { Authorization = "Bearer tok_ARRAYTABLE" }\n', "mcp_servers.linear"],
      ['[[mcp_servers]]\nurl = "https://l.example"\nhttp_headers = { Authorization = "Bearer tok_ARRAYROOT" }\n', "mcp_servers"],
      ['[mcp_servers.linear]\nurl = "https://l.example"\n\n[mcp_servers.linear.http_headers.Authorization]\nvalue = "Bearer tok_NESTED"\n', "mcp_servers.linear"],
    ];
    for (const [text, where] of shapes) await expect(CODEX_TOML.refer(text), text).rejects.toThrow(`${where} is written in a shape wsp does not read, so its values cannot be written by name`);
  });

  it("Codex: reads no variable for an OAuth client secret, so the file stays on this computer and the refusal names the key", async () => {
    const said = "linear keeps an OAuth client secret in mcp_servers.linear.oauth.client_secret, and Codex reads no variable there, so the file stays on this computer";
    const spellings = [
      '[mcp_servers.linear]\nurl = "https://l.example"\n\n[mcp_servers.linear.oauth]\nclient_id = "cid"\nclient_secret = "cs_TESTONLY_table"\n',
      '[mcp_servers.linear]\nurl = "https://l.example"\noauth = { client_id = "cid", client_secret = "cs_TESTONLY_inline" }\n',
      '[mcp_servers.linear]\nurl = "https://l.example"\noauth.client_id = "cid"\noauth.client_secret = "cs_TESTONLY_dotted"\nhttp_headers = { Authorization = "Bearer tok_TESTONLY" }\n',
      'mcp_servers.linear = { url = "https://l.example", oauth = { client_id = "cid", client_secret = "cs_TESTONLY_root" } }\n',
    ];
    for (const text of spellings) {
      await expect(CODEX_TOML.refer(text), text).rejects.toThrow(said);
      await expect(serversByName(CODEX_TOML, text, new Map(), () => undefined), text).rejects.toThrow(said);
    }
    await expect(CODEX_TOML.refer('[mcp_servers.linear]\nurl = "https://l.example"\noauth = "cs_TESTONLY_string"\n')).rejects.toThrow("mcp_servers.linear is written in a shape wsp does not read, so its values cannot be written by name");
    const clientOnly = '[mcp_servers.linear]\nurl = "https://l.example"\noauth = { client_id = "cid", callback_port = 5555 }\n';
    expect((await serversByName(CODEX_TOML, clientOnly, new Map(), () => undefined)).text).toBe(clientOnly);
    const beside = `${spellings[0]}\n[mcp_servers.other]\ncommand = "o"\nenv = { K = "k_TESTONLY" }\n`;
    const one = await CODEX_TOML.refer(beside, "other");
    expect(one.servers).toEqual([{ name: "other", values: { K: "k_TESTONLY" } }]);
  });

  it("the copy's last check refuses a server definition that still carries an OAuth client secret, whatever the format's writer let through", async () => {
    const lax: McpFormat = { ...CODEX_TOML, refer: async text => ({ text, servers: [{ name: "s", values: {} }], entries: [{ url: "https://s.example", oauth: { client_id: "cid", client_secret: "cs_TESTONLY" } }] }) };
    await expect(serversByName(lax, "[mcp_servers.s]\n", new Map(), () => undefined)).rejects.toThrow("a server still carries an OAuth client secret after it was written by name, and no agent reads one by name, so the file stays on this computer");
    const clean: McpFormat = { ...lax, refer: async text => ({ text, servers: [{ name: "s", values: {} }], entries: [{ url: "https://s.example", oauth: { client_id: "cid" } }] }) };
    expect((await serversByName(clean, "[mcp_servers.s]\n", new Map(), () => undefined)).dropped).toEqual([]);
  });

  it("copies an ordinary config whose unrelated keys and history hold the same short words as a server's values", async () => {
    const claude = JSON.stringify(
      {
        verbose: true,
        numStartups: 1,
        theme: "dev",
        history: ["deploy to production", "run dev with debug on", "true"],
        projects: { "/Users/dev/app": { lastSessionId: "1", allowedTools: ["debug"] } },
        mcpServers: { notion: { command: "npx", env: { DEBUG: "1", STAGE: "dev", NODE_ENV: "production", FLAG: "true" } } },
      },
      null,
      2,
    );
    const out = await MCP_SERVERS_JSON.refer(claude);
    expect(out.servers).toEqual([{ name: "notion", values: { DEBUG: "1", STAGE: "dev", NODE_ENV: "production", FLAG: "true" } }]);
    expect(out.text).toContain('"history": [');
    const codex = '# production box, dev notes\nmodel = "gpt-5"\n\n[mcp_servers.n]\ncommand = "npx"\nenv = { NODE_ENV = "production", DEBUG = "1" }\n';
    expect((await CODEX_TOML.refer(codex)).servers[0]!.values).toEqual({ NODE_ENV: "production", DEBUG: "1" });
  });

  it("refuses the copy where a value still stands in a server's entry, whole or after its scheme word, whatever its length", async () => {
    const said = "s's value still stands in the file after it was written by name, so the file stays on this computer";
    await expect(CODEX_TOML.refer('[mcp_servers.s]\nurl = "https://s.example"\nnote = "Bearer tok1"\nhttp_headers = { Authorization = "Bearer tok1" }\n')).rejects.toThrow(said);
    await expect(CODEX_TOML.refer('[mcp_servers.s]\ncommand = "x"\nargs = ["tok1"]\nenv = { K = "tok1" }\n')).rejects.toThrow(said);
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { command: "x", args: ["--auth", "token sk_TESTONLY_long_value"], env: { K: "sk_TESTONLY_long_value" } } } }))).rejects.toThrow(said);
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { Authorization: "Bearer t1" } }, o: { command: "x", args: ["Basic t1"] } } }))).rejects.toThrow("s's value still stands");
    // A header whose whole value keeps its scheme word, and the credential standing bare elsewhere.
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { "X-Auth": "Basic cred123" } }, o: { command: "x", args: ["cred123"] } } }))).rejects.toThrow("s's value still stands");
  });

  it("refuses the copy where a value still stands in an argument or an address, as a flag's value, a header line, a query key or base64, for every agent", async () => {
    const V = "sk_TESTONLY_arg";
    const b64 = btoa(V);
    type Leak = { args?: string[]; url?: string };
    const files: Record<string, [McpFormat, (leak: Leak) => string]> = {
      "Claude Code": [MCP_SERVERS_JSON, l => JSON.stringify({ mcpServers: { s: l.url !== undefined ? { type: "http", url: l.url, headers: { Authorization: `Bearer ${V}` } } : { command: "x", args: l.args, env: { TOKEN: V } } } })],
      "Gemini CLI": [GEMINI_SETTINGS_JSON, l => JSON.stringify({ mcpServers: { s: l.url !== undefined ? { httpUrl: l.url, headers: { Authorization: `Bearer ${V}` } } : { command: "x", args: l.args, env: { TOKEN: V } } } })],
      OpenCode: [OPENCODE_JSON, l => JSON.stringify({ mcp: { s: l.url !== undefined ? { type: "remote", url: l.url, headers: { Authorization: `Bearer ${V}` } } : { type: "local", command: ["x", ...l.args!], environment: { TOKEN: V } } } })],
      Codex: [CODEX_TOML, l => (l.url !== undefined ? `[mcp_servers.s]\nurl = ${JSON.stringify(l.url)}\nhttp_headers = { Authorization = "Bearer ${V}" }\n` : `[mcp_servers.s]\ncommand = "x"\nargs = ${JSON.stringify(l.args)}\nenv = { TOKEN = "${V}" }\n`)],
    };
    const leaks: [Leak, string][] = [
      [{ args: [`--token=${V}`] }, "the --token argument"],
      [{ args: ["-H", `Authorization: Bearer ${V}`] }, "the Authorization header"],
      [{ url: `https://s.example/mcp?team=eng&key=${V}` }, "the key parameter of an address"],
      [{ args: ["https://s.example/sse", "--header", `Authorization: Basic ${b64}`] }, "the Authorization header, as base64"],
    ];
    for (const [agent, [format, file]] of Object.entries(files)) {
      for (const [leak, where] of leaks) await expect(format.refer(file(leak)), `${agent}: ${where}`).rejects.toThrow(`s's value still stands in ${where} after it was written by name, so the file stays on this computer`);
    }
    // The same flags, keys and header lines carrying no value that left stand.
    expect((await MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { command: "x", args: ["--token=other", "-H", "Accept: text/plain", "https://s.example/?key=other"], env: { TOKEN: V } } } }))).servers).toEqual([{ name: "s", values: { TOKEN: V } }]);
  });

  it("two headers of one server that would travel under one name", async () => {
    const text = JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { "X-Api-Key": "a", X_Api_Key: "b" } } } });
    await expect(MCP_SERVERS_JSON.refer(text)).rejects.toThrow("s sends X-Api-Key and X_Api_Key, which would both travel as WSP_MCP_S_X_API_KEY; rename one");
    await expect(CODEX_TOML.refer('[mcp_servers.s]\nurl = "https://s.example"\nhttp_headers = { "X-Api-Key" = "a", "X_Api_Key" = "b" }\n')).rejects.toThrow("s sends X-Api-Key and X_Api_Key, which would both travel as WSP_MCP_S_X_API_KEY; rename one");
  });

  it("a value that mixes a literal with a variable, which cannot travel whole by name", async () => {
    await expect(MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { Authorization: "Bearer lit_${X}" } } } }))).rejects.toThrow("s's Authorization mixes a value with a variable, so it cannot travel by name; make it one or the other");
    await expect(GEMINI_SETTINGS_JSON.refer(JSON.stringify({ mcpServers: { s: { command: "x", env: { K: "ab$cd" } } } }))).rejects.toThrow("s's K mixes a value with a variable, so it cannot travel by name; make it one or the other");
    // A whole reference, a bearer's included, stands as written.
    expect((await MCP_SERVERS_JSON.refer(JSON.stringify({ mcpServers: { s: { url: "https://s.example", headers: { Authorization: "Bearer ${X}", Y: "${Y:-d}" } } } }))).servers).toEqual([{ name: "s", values: {} }]);
  });
});

describe("a definition's references read back as the agent starts the server", () => {
  const values: Record<string, string> = { LINEAR: TOKEN, NOTION_TOKEN: NOTION };
  const value = (n: string): string | undefined => values[n];
  const one = (format: McpFormat, text: string) => format.resolve(format.read(text, HOME)[0]!, value);

  it("fills each format's own syntax in headers, command variables and the address, and leaves a command's arguments as written", () => {
    expect(one(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { l: { type: "http", url: "https://l.example/${LINEAR}", headers: { Authorization: "Bearer ${LINEAR}" } } } }))).toEqual({ transport: { kind: "http", url: `https://l.example/${TOKEN}`, headers: { Authorization: `Bearer ${TOKEN}` } }, values: [TOKEN, TOKEN] });
    expect(one(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { n: { command: "npx", args: ["--t", "${NOTION_TOKEN}"], env: { NOTION_TOKEN: "${NOTION_TOKEN}" } } } }))).toEqual({ transport: { kind: "stdio", command: "npx", args: ["--t", "${NOTION_TOKEN}"], env: { NOTION_TOKEN: NOTION } }, values: [NOTION] });
    expect(one(GEMINI_SETTINGS_JSON, JSON.stringify({ mcpServers: { n: { command: "npx", env: { A: "$NOTION_TOKEN", B: "${LINEAR}" } } } }))).toMatchObject({ transport: { env: { A: NOTION, B: TOKEN } } });
    expect(one(OPENCODE_JSON, JSON.stringify({ mcp: { l: { type: "remote", url: "https://l.example", headers: { Authorization: "Bearer {env:LINEAR}" } } } }))).toMatchObject({ transport: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  });

  it("takes a written default for a variable with no value, and names the first one with neither", () => {
    expect(one(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { n: { command: "npx", env: { A: "${UNSET:-dflt}" } } } }))).toEqual({ transport: { kind: "stdio", command: "npx", args: [], env: { A: "dflt" } }, values: [] });
    expect(one(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { n: { command: "npx", env: { A: "${UNSET}", B: "${ALSO_UNSET}" } } } }))).toEqual({ missing: "UNSET" });
    expect(one(OPENCODE_JSON, JSON.stringify({ mcp: { l: { type: "remote", url: "https://l.example", headers: { K: "{env:UNSET}" } } } }))).toEqual({ missing: "UNSET" });
  });

  it("gives a Codex command its env_vars that have a value, and sends env_http_headers and the bearer, refusing one with none", () => {
    expect(one(CODEX_TOML, `[mcp_servers.n]\ncommand = "npx"\nenv_vars = ["NOTION_TOKEN", "UNSET"]\n`)).toEqual({ transport: { kind: "stdio", command: "npx", args: [], env: { NOTION_TOKEN: NOTION } }, values: [NOTION] });
    expect(one(CODEX_TOML, `[mcp_servers.l]\nurl = "https://l.example"\nbearer_token_env_var = "LINEAR"\nenv_http_headers = { "X-Notion" = "NOTION_TOKEN" }\n`)).toEqual({ transport: { kind: "http", url: "https://l.example", headers: { "X-Notion": NOTION, Authorization: `Bearer ${TOKEN}` } }, values: [NOTION, TOKEN] });
    expect(one(CODEX_TOML, `[mcp_servers.l]\nurl = "https://l.example"\nbearer_token_env_var = "UNSET"\n`)).toEqual({ missing: "UNSET" });
    expect(one(CODEX_TOML, `[mcp_servers.l]\nurl = "https://l.example"\n\n[mcp_servers.l.env_http_headers]\nX-Notion = "UNSET"\n`)).toEqual({ missing: "UNSET" });
  });
});

describe("a value servers.env holds, written back as its reference on the copy", () => {
  const V = "sk_TESTONLY_local";
  const known = (values: Record<string, string>, by: string[] = []): Record<string, { value: string; by: string[] }> => Object.fromEntries(Object.entries(values).map(([n, value]) => [n, { value, by }]));
  const vault = known({ ACME_TOKEN: V });
  const rows = (): undefined => undefined;
  const ADDRESS = `https://s.example/mcp?team=eng&key=${V}`;
  type Local = { args?: string[]; env?: Record<string, string>; url?: string };
  const agents: Record<string, [McpFormat, (l: Local) => string, string]> = {
    "Claude Code": [MCP_SERVERS_JSON, l => JSON.stringify({ mcpServers: { s: l.url !== undefined ? { type: "http", url: l.url } : { command: "x", args: l.args, ...(l.env !== undefined ? { env: l.env } : {}) } } }), "${ACME_TOKEN}"],
    "Gemini CLI": [GEMINI_SETTINGS_JSON, l => JSON.stringify({ mcpServers: { s: l.url !== undefined ? { httpUrl: l.url } : { command: "x", args: l.args, ...(l.env !== undefined ? { env: l.env } : {}) } } }), "${ACME_TOKEN}"],
    OpenCode: [OPENCODE_JSON, l => JSON.stringify({ mcp: { s: l.url !== undefined ? { type: "remote", url: l.url } : { type: "local", command: ["x", ...l.args!], ...(l.env !== undefined ? { environment: l.env } : {}) } } }), "{env:ACME_TOKEN}"],
  };

  for (const [agent, [format, file, ref]] of Object.entries(agents)) {
    it(`${agent}: a value an argument or the address holds as servers.env does travels as that variable's reference, and reads back as the value`, async () => {
      for (const local of [{ args: [`--token=${V}`] }, { args: [`--token=${V}`], env: { ACME_TOKEN: V } }, { url: ADDRESS }] as Local[]) {
        const held = new Map<string, { value: string; by: string }>();
        const out = await serversByName(format, file(local), held, rows, vault);
        expect(out.text, JSON.stringify(local)).not.toContain(V);
        expect(out.text).toContain(local.url !== undefined ? `key=${ref}` : `--token=${ref}`);
        expect(out.dropped).toEqual([]);
        expect([...held]).toEqual([["ACME_TOKEN", { value: V, by: "s" }]]);
        const server = format.read(out.text, HOME)[0]!;
        if (local.url !== undefined) expect(format.resolve(server, n => vault[n]?.value)).toMatchObject({ transport: { url: ADDRESS } });
      }
    });

    it(`${agent}: a value servers.env does not hold still refuses the copy where it stands, and a value standing in no whole place is left alone`, async () => {
      await expect(serversByName(format, file({ args: [`--token=${V}`], env: { ACME_TOKEN: V } }), new Map(), rows, {})).rejects.toThrow("s's value still stands in the --token argument after it was written by name, so the file stays on this computer");
      await expect(serversByName(format, file({ args: [`--token=${V}`], env: { ACME_TOKEN: V } }), new Map(), rows, known({ OTHER: "sk_TESTONLY_other" }))).rejects.toThrow("s's value still stands in the --token argument");
      const plain = await serversByName(format, file({ args: ["--workers=10", "run1"] }), new Map(), rows, known({ N: "1" }));
      expect(plain.text).toBe(file({ args: ["--workers=10", "run1"] }));
    });

    it(`${agent}: refuses where the file sets the variable servers.env holds the value under to another value, since the reference would read that one`, async () => {
      await expect(serversByName(format, file({ args: [`--token=${V}`], env: { ACME_TOKEN: "sk_TESTONLY_other" } }), new Map(), rows, vault)).rejects.toThrow("s passes the value servers.env holds as ACME_TOKEN in the --token argument, which s sets to another value, so the file stays on this computer");
    });

    it(`${agent}: the final guard still runs after the rewrite, so a value left standing as base64 keeps the file here`, async () => {
      await expect(serversByName(format, file({ args: [`--token=${V}`, "--header", `Authorization: Basic ${btoa(V)}`] }), new Map(), rows, vault)).rejects.toThrow("s's value still stands in the Authorization header, as base64 after it was written by name");
    });
  }

  it("writes the outer place where two known values nest, so a header line's whole credential takes one reference", async () => {
    const out = await serversByName(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { s: { command: "x", args: ["-H", "Authorization: Basic cred_TESTONLY"] } } }), new Map(), rows, known({ WHOLE: "Basic cred_TESTONLY", PART: "cred_TESTONLY" }));
    expect((parseJsonc(out.text) as { mcpServers: { s: { args: string[] } } }).mcpServers.s.args).toEqual(["-H", "Authorization: ${WHOLE}"]);
  });

  it("refuses a value servers.env holds that stands only percent-encoded or as base64, which cannot be written by name, for every agent", async () => {
    const odd = "sk TESTONLY/plus+";
    const encoded = `https://s.example/mcp?key=${encodeURIComponent(odd)}`;
    const said = "s's value still stands in the key parameter of an address after it was written by name, so the file stays on this computer";
    for (const [agent, [format, file]] of Object.entries(agents)) await expect(serversByName(format, file({ url: encoded }), new Map(), rows, known({ ODD: odd })), agent).rejects.toThrow(said);
    await expect(serversByName(CODEX_TOML, `[mcp_servers.s]\nurl = "${encoded}"\n`, new Map(), rows, known({ ODD: odd }))).rejects.toThrow(said);
    for (const [agent, [format, file]] of Object.entries(agents)) await expect(serversByName(format, file({ args: ["--auth", btoa(V)] }), new Map(), rows, vault), agent).rejects.toThrow("s's value still stands in the file, as base64");
    await expect(serversByName(CODEX_TOML, `[mcp_servers.s]\ncommand = "x"\nargs = ["${btoa(V)}"]\n`, new Map(), rows, vault)).rejects.toThrow("s's value still stands in the file, as base64");
  });

  it("writes the name the server itself sets where servers.env holds its value under two", async () => {
    const out = await serversByName(MCP_SERVERS_JSON, JSON.stringify({ mcpServers: { s: { command: "x", args: [`--token=${V}`], env: { MINE: V } } } }), new Map(), rows, known({ OTHER: V, MINE: V }));
    expect((parseJsonc(out.text) as { mcpServers: { s: { args: string[] } } }).mcpServers.s.args).toEqual(["--token=${MINE}"]);
  });

  it("refuses a name servers.env holds with another value for another server, or for none, and takes a new value from the server it belongs to alone as its rotation", async () => {
    const file = (value: string): string => JSON.stringify({ mcpServers: { s: { command: "x", env: { TOKEN: value } } } });
    const other = await serversByName(MCP_SERVERS_JSON, file("sk_TESTONLY_second"), new Map(), rows, known({ TOKEN: "sk_TESTONLY_first" }, ["a"]));
    expect(other.dropped).toEqual([{ name: "s", reason: "sets TOKEN, which a already sets to another value" }]);
    expect(other.text).not.toContain("sk_TESTONLY_second");
    const nobody = await serversByName(MCP_SERVERS_JSON, file("sk_TESTONLY_second"), new Map(), rows, known({ TOKEN: "sk_TESTONLY_first" }));
    expect(nobody.dropped).toEqual([{ name: "s", reason: "sets TOKEN, which servers.env already holds with another value and no server recorded for it" }]);
    const shared = await serversByName(MCP_SERVERS_JSON, file("sk_TESTONLY_second"), new Map(), rows, known({ TOKEN: "sk_TESTONLY_first" }, ["s", "a"]));
    expect(shared.dropped).toEqual([{ name: "s", reason: "sets TOKEN, which a already sets to another value" }]);
    const held = new Map<string, { value: string; by: string }>();
    const rotated = await serversByName(MCP_SERVERS_JSON, file("sk_TESTONLY_second"), held, rows, known({ TOKEN: "sk_TESTONLY_first" }, ["s"]));
    expect(rotated.dropped).toEqual([]);
    expect([...held]).toEqual([["TOKEN", { value: "sk_TESTONLY_second", by: "s" }]]);
  });

  it("Codex: reads no variable in an argument or an address, so the copy refuses and names where the value stands", async () => {
    const said = (where: string): string => `s passes the value of ACME_TOKEN in ${where}, and Codex reads no variable there, so the file stays on this computer`;
    await expect(serversByName(CODEX_TOML, `[mcp_servers.s]\ncommand = "x"\nargs = ["--token=${V}"]\n`, new Map(), rows, vault)).rejects.toThrow(said("the --token argument"));
    await expect(serversByName(CODEX_TOML, `[mcp_servers.s]\ncommand = "x"\nargs = ["--token=${V}"]\nenv = { ACME_TOKEN = "${V}" }\n`, new Map(), rows, vault)).rejects.toThrow(said("the --token argument"));
    await expect(serversByName(CODEX_TOML, `[mcp_servers.s]\nurl = "${ADDRESS}"\n`, new Map(), rows, vault)).rejects.toThrow(said("the key parameter of an address"));
    await expect(serversByName(CODEX_TOML, `[mcp_servers.s]\ncommand = "x"\nargs = ["${V}"]\n`, new Map(), rows, vault)).rejects.toThrow(said("an argument"));
  });
});
