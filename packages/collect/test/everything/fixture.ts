// SPDX-License-Identifier: AGPL-3.0-only
// A laptop described as data for the seven passes: files with size, text,
// mode and mtime; symlinks; PATH; canned command output.
import type { Entry, EnvName, Machine } from "../../src/everything/host.js";
import type { Platform } from "../../src/host.js";

export const HOME = "/Users/dev";
export const NOW = Date.UTC(2026, 8, 3);
export const RECENT = Date.UTC(2026, 7, 1);
export const OLD = Date.UTC(2023, 0, 15);
export const LOGIN_KEYCHAIN = `${HOME}/Library/Keychains/login.keychain-db`;

export interface File {
  bytes?: number;
  text?: string;
  mode?: number;
  mtime?: number;
}

export interface Laptop {
  platform?: Platform;
  /** `~/x: 300` is a 300-byte file, a string is its text, an object sets mode and mtime; `~/d/` is an empty directory. */
  files?: Record<string, number | string | File>;
  /** Symlink to target, absolute or relative to the link's directory. */
  links?: Record<string, string>;
  path?: string[];
  env?: Partial<Record<EnvName, string>>;
  which?: string[];
  /** Keyed by `cmd arg arg`; the value is stdout of a successful run. */
  exec?: Record<string, string>;
}

const expand = (p: string): string => p.replace(/^~/, HOME);
const dirname = (p: string): string => p.slice(0, p.lastIndexOf("/"));

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

// Files under a bin or shims directory are executable unless the fixture says otherwise.
function defaultMode(path: string): number {
  return /\/(bin|shims)\//.test(path) ? 0o755 : 0o644;
}

/** Every fs call and command run, so a test can prove which files were opened and which trees were never entered. */
export function laptop(l: Laptop = {}): Machine & { calls: string[] } {
  const files = new Map<string, Required<Omit<File, "text">> & { text?: string }>();
  const dirs = new Set<string>();
  const links = new Map<string, string>();
  const calls: string[] = [];

  const addDirs = (p: string): void => {
    for (let d = dirname(p); d !== "" && !dirs.has(d); d = dirname(d)) dirs.add(d);
  };
  for (const [k, v] of Object.entries(l.files ?? {})) {
    const p = expand(k);
    if (p.endsWith("/")) {
      dirs.add(p.slice(0, -1));
      addDirs(p.slice(0, -1));
      continue;
    }
    const f: File = typeof v === "number" ? { bytes: v } : typeof v === "string" ? { text: v } : v;
    const bytes = f.bytes ?? (f.text === undefined ? 0 : Buffer.byteLength(f.text));
    files.set(p, { bytes, mode: f.mode ?? defaultMode(p), mtime: f.mtime ?? RECENT, ...(f.text !== undefined ? { text: f.text } : {}) });
    addDirs(p);
  }
  for (const [k, v] of Object.entries(l.links ?? {})) {
    const p = expand(k);
    links.set(p, v.startsWith("/") ? expand(v) : normalize(`${dirname(p)}/${expand(v)}`));
    addDirs(p);
  }

  const which = new Set(l.which ?? []);
  return {
    platform: l.platform ?? "darwin",
    home: HOME,
    path: (l.path ?? []).map(expand),
    env: l.env ?? {},
    fs: {
      async stat(path): Promise<Entry | undefined> {
        if (links.has(path)) return { kind: "link", bytes: 0, mode: 0o755, mtime: RECENT };
        const f = files.get(path);
        if (f !== undefined) return { kind: "file", bytes: f.bytes, mode: f.mode, mtime: f.mtime };
        return dirs.has(path) ? { kind: "dir", bytes: 0, mode: 0o755, mtime: RECENT } : undefined;
      },
      async list(dir) {
        calls.push(`list ${dir}`);
        const names = new Set<string>();
        for (const k of [...files.keys(), ...links.keys(), ...dirs]) {
          if (k.startsWith(`${dir}/`)) {
            const name = k.slice(dir.length + 1).split("/")[0];
            if (name !== undefined && name !== "") names.add(name);
          }
        }
        return [...names].sort();
      },
      async realpath(path) {
        let p = path;
        for (let hops = 0; hops < 40; hops += 1) {
          const target = links.get(p);
          if (target === undefined) return files.has(p) || dirs.has(p) ? p : undefined;
          p = target;
        }
        return undefined;
      },
      async readText(path) {
        calls.push(`read ${path}`);
        return files.get(path)?.text;
      },
    },
    exec: {
      async which(bin) {
        return which.has(bin);
      },
      async run(cmd, args) {
        const key = [cmd, ...args].join(" ");
        calls.push(`run ${key}`);
        return l.exec?.[key];
      },
    },
    calls,
  };
}

/** Generates count small files under dir so a walk can be driven past its cap. */
export function many(dir: string, count: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) out[`${dir}/d${Math.floor(i / 100)}/f${i}`] = 10;
  return out;
}

export const KEYCHAIN_DUMP = `keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="gh:github.com"
    "acct"<blob>="dev"
    "svce"<blob>="gh:github.com"
keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="dev-work"
    "svce"<blob>="gh:github.com"
keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="dev"
    "svce"<blob>="glab:gitlab.com:token"
keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="assistant"
    "svce"<blob>="com.apple.assistant"
keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="dev"
    "svce"<blob>="Raycast"
keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="Slack Key"
    "svce"<blob>="Slack Safe Storage"
keychain: "/Library/Keychains/System.keychain"
version: 512
class: "genp"
attributes:
    "acct"<blob>="Home Wi-Fi"
    "svce"<blob>="AirPort"
keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "inet"
attributes:
    "acct"<blob>="dev"
    "srvr"<blob>="github.com"
keychain: "/Users/dev/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="nobody"
`;

/** The fixture HOME every acceptance case lives in. */
export function home(): Laptop {
  return {
    path: ["~/.local/share/mise/shims", "~/.local/bin", "/opt/homebrew/bin", "~/.nix-profile/bin", "~/.cargo/bin", "~/go/bin", "/usr/local/bin", "/usr/bin", "~/.local/bin"],
    which: ["uv", "npm", "go"],
    links: {
      "/opt/homebrew/bin/gh": "../Cellar/gh/2.97.0/bin/gh",
      "/opt/homebrew/bin/jq": "../Cellar/jq/1.7.1/bin/jq",
      "/opt/homebrew/bin/adb": "../Caskroom/android-platform-tools/37.0.0/platform-tools/adb",
      "~/.nix-profile/bin/rg": "/nix/store/abcdefghijklmnopqrstuvwxyz012345-ripgrep-14.1.0/bin/rg",
      "~/.local/bin/ty": "../share/uv/tools/ty/bin/ty",
      "~/.local/bin/litmus": "../lib/node_modules/litmus-cli/dist/index.js",
      "~/.local/bin/node": "/Users/dev/.hermes/node/bin/node",
      "~/.local/share/mise/shims/python": "/opt/homebrew/Cellar/mise/2026.1.0/bin/mise",
      "/usr/local/bin/docker": "/Applications/Docker.app/Contents/Resources/bin/docker",
      "~/.local/bin/dangling": "/nowhere/gone",
      "~/.config/nvim": "/Users/dev/dotfiles/nvim",
      "~/.tmux.conf": "dotfiles/tmux.conf",
      "~/.broken": "/nowhere/else",
    },
    files: {
      "/opt/homebrew/Cellar/gh/2.97.0/bin/gh": 40_000_000,
      "/opt/homebrew/Cellar/gh/2.97.0/INSTALL_RECEIPT.json": '{"installed_on_request":true,"poured_from_bottle":true}',
      "/opt/homebrew/Cellar/jq/1.7.1/bin/jq": 1_000_000,
      "/opt/homebrew/Cellar/jq/1.7.1/INSTALL_RECEIPT.json": '{"installed_on_request":false}',
      "/opt/homebrew/Cellar/mise/2026.1.0/bin/mise": 20_000_000,
      "/opt/homebrew/Caskroom/android-platform-tools/37.0.0/platform-tools/adb": { bytes: 12_000_000, mode: 0o755 },
      "/opt/homebrew/bin/brew": 30_000,
      "/nix/store/abcdefghijklmnopqrstuvwxyz012345-ripgrep-14.1.0/bin/rg": 5_000_000,
      "~/.local/share/uv/tools/ty/bin/ty": 3_000_000,
      "~/.local/lib/node_modules/litmus-cli/dist/index.js": { bytes: 20_000, mode: 0o755 },
      "~/.cargo/bin/bat": 6_000_000,
      "~/.cargo/.crates2.json": '{"installs":{"bat 0.24.0 (registry+https://github.com/rust-lang/crates.io-index)":{"bins":["bat"]}}}',
      "~/go/bin/gopls": 30_000_000,
      "~/.local/bin/hermes": { bytes: 5_000_000, mode: 0o755, mtime: RECENT },
      "~/.local/bin/omp": { bytes: 9_000_000, mode: 0o755, mtime: OLD },
      "~/.local/bin/README": { text: "not a program\n", mode: 0o644 },
      "~/.hermes/node/bin/node": 90_000_000,
      "/Applications/Docker.app/Contents/Resources/bin/docker": 50_000_000,
      "/usr/bin/ls": 150_000,
      "/usr/bin/ssh": 150_000,
      "/usr/bin/zsh": 150_000,
      "~/.config/gh/hosts.yml": { text: "github.com:\n    user: dev\n    oauth_token: redacted\n", mode: 0o600 },
      "~/.config/gh/config.yml": "git_protocol: https\n",
      "~/.hermes/config.yaml": "model: default\n",
      "~/.hermes/auth.json": '{"access_token":"redacted","expires_at":1}',
      "~/.hermes/.env": "ANTHROPIC_API_KEY=sk-ant-redacted\n",
      "~/.hermes/.env.example": "HERMES_TOKEN=put-yours-here\n",
      "~/.hermes/node_modules/left-pad/index.js": 2_000,
      "~/.cache/pip/http/blob": 5_000_000,
      "~/.cache/huggingface/token": { text: "hf_redacted", mode: 0o600 },
      "~/.config/raycast/config.json": { text: '{"theme":"dark"}', mode: 0o600 },
      "~/.config/raycast/extensions/big.bin": 3_000_000,
      "~/.config/monid/credentials.yaml": { text: "api_key: redacted\n", mode: 0o600 },
      "~/.netrc": { text: "machine api.example.com login dev password redacted\n", mode: 0o600 },
      "~/.zshrc": "export PATH=$HOME/.local/bin:$PATH\nexport ANTHROPIC_API_KEY=sk-redacted\nexport KEYTIMEOUT=1\nGITHUB_TOKEN=ghp_redacted\nalias ll='ls -l'\n",
      "~/.zsh_history": { bytes: 300_000, mode: 0o600 },
      "~/.viminfo": { bytes: 20_000, mode: 0o600 },
      "~/.CFUserTextEncoding": { text: "0:0", mode: 0o600 },
      "~/.oh-my-zsh/.git/HEAD": "ref: refs/heads/master\n",
      "~/.oh-my-zsh/credentials.json": '{"token":"looks-like-one"}',
      "~/.oh-my-zsh/oh-my-zsh.sh": 3_000,
      "~/.oldtool/config.toml": { text: "x = 1\n", mtime: OLD },
      "~/.local/state/nvim/shada": 40_000,
      "~/Library/Caches/pnpm/blob": 2_000_000,
      "~/.kube/config": { text: "apiVersion: v1\nclusters: []\n", mode: 0o600 },
      "~/.mcp-auth/mcp-remote-0.1/abc_client_info.json": { text: '{"client_id":"x"}', mode: 0o600 },
      "~/.jcode/state.active": { text: "1", mode: 0o600 },
      "~/.zsh_sessions/ABC.session": { bytes: 200, mode: 0o600 },
      "~/.ssh/id_ed25519": { text: "-----BEGIN OPENSSH PRIVATE KEY-----\nredacted\n-----END OPENSSH PRIVATE KEY-----\n", mode: 0o600 },
      "~/.ssh/id_ed25519.pub": "ssh-ed25519 AAAA dev\n",
      "~/.ssh/config": "Host *\n  AddKeysToAgent yes\n",
      "~/.ssh/known_hosts": { bytes: 4_000, mode: 0o600 },
      "~/.rustup/toolchains/stable/bin/rustc": 40_000_000,
      "~/.rustup/settings.toml": "version = \"12\"\n",
      "~/dotfiles/nvim/init.lua": 500,
      "~/dotfiles/tmux.conf": 300,
      "~/Library/Preferences/com.apple.finder.plist": 2_000,
      "~/Library/Preferences/com.googlecode.iterm2.plist": 9_000,
      "~/Library/Preferences/.wrangler/config/default.toml": 'oauth_token = "redacted"\n',
      "~/Library/Application Support/Code/User/settings.json": '{"editor.fontSize":13}',
      "~/Library/Application Support/com.apple.TCC/TCC.db": 4_000,
      "~/Documents/notes.md": 1_000,
    },
    exec: {
      "npm root -g": "/Users/dev/.local/lib/node_modules\n",
      "npm ls -g --depth=0 --json": '{"dependencies":{"litmus-cli":{"version":"1.2.0"},"npm":{"version":"10.0.0"}}}',
      "uv tool list": "ty v0.0.1\n- ty\n",
      "go version -m /Users/dev/go/bin/gopls": "/Users/dev/go/bin/gopls: go1.23.1\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n",
      "security login-keychain": `    "${LOGIN_KEYCHAIN}"\n`,
      [`security dump-keychain ${LOGIN_KEYCHAIN}`]: KEYCHAIN_DUMP,
    },
  };
}

/** Thirty credential shapes a developer machine carries, with fake contents, and five files that only look like one. */
export function shapes(): Laptop {
  return {
    files: {
      "~/.netrc": { text: "machine api.example.com login dev password fake\n", mode: 0o600 },
      "~/.aws/credentials": { text: "[default]\naws_access_key_id = AKIAFAKE\naws_secret_access_key = fake\n", mode: 0o600 },
      "~/.aws/config": "[default]\nregion = eu-west-1\n",
      "~/.config/gh/hosts.yml": { text: "github.com:\n    user: dev\n    oauth_token: gho_fake\n", mode: 0o600 },
      "~/.config/gh/config.yml": "git_protocol: https\n",
      "~/.config/gcloud/access_tokens.db": { bytes: 12_000, mode: 0o600 },
      "~/.config/gcloud/configurations/config_default": "[core]\nproject = demo\n",
      "~/.config/gcloud/legacy_credentials/dev@example.com/.boto": { text: "[Credentials]\ngs_oauth2_refresh_token = fake\n", mode: 0o600 },
      "~/.gcp/service-account-abc.json": '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nfake"}',
      "~/.ssh/id_rsa": { text: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", mode: 0o600 },
      "~/.ssh/id_rsa.pub": "ssh-rsa AAAA dev\n",
      "~/.ssh/config": "Host *\n  AddKeysToAgent yes\n",
      "~/.ssh/known_hosts": { bytes: 4_000, mode: 0o600 },
      "~/.cloudflared/cert.pem": "-----BEGIN ARGO TUNNEL TOKEN-----\nfake\n",
      "~/.codex/auth.json": '{"tokens":{"access_token":"fake"}}',
      "~/.codex/config.toml": 'model = "o3"\n',
      "~/.gemini/oauth_creds.json": '{"access_token":"fake","refresh_token":"fake"}',
      "~/.claude/.credentials.json": { text: '{"claudeAiOauth":{"accessToken":"sk-ant-x"}}', mode: 0o600 },
      "~/.claude/settings.json": '{"theme":"dark"}',
      "~/.kube/config": { text: "apiVersion: v1\nclusters: []\n", mode: 0o600 },
      "~/.docker/config.json": '{"auths":{"https://index.docker.io/v1/":{"auth":"ZmFrZQ=="}},"credsStore":"desktop"}',
      "~/.pypirc": { text: "[pypi]\nusername = __token__\npassword = pypi-fake\n", mode: 0o600 },
      "~/.fly/config.yml": "access_token: fo1_fake\n",
      "~/.supabase/access-token": "sbp_fake\n",
      "~/.doppler/.doppler.yaml": { text: "scoped:\n  /:\n    token: dp.st.fake\n", mode: 0o600 },
      "~/.local/share/atuin/key": { text: "fake-key-material", mode: 0o600 },
      "~/.secrets": { text: "export STRIPE_KEY=sk_test_fake\n", mode: 0o600 },
      "~/.hermes/.env": "ANTHROPIC_API_KEY=sk-ant-fake\n",
      "~/.hermes/.env.local": { text: "X_TOKEN=fake\n", mode: 0o600 },
      "~/.hermes/config.yaml": "model: default\n",
      "~/.hermes/auth.json": '{"access_token":"fake"}',
      "~/.npmrc": { text: "//registry.npmjs.org/:_authToken=npm_fake\nregistry=https://registry.npmjs.org/\n", mode: 0o600 },
      "~/.git-credentials": { text: "https://dev:ghp_fake@github.com\n", mode: 0o600 },
      "~/.config/.wrangler/config/default.toml": 'oauth_token = "fake"\nexpiration_time = "2026"\n',
      "~/Library/Preferences/.wrangler/config/default.toml": 'oauth_token = "fake"\n',
      "~/.railway/config.json": '{"user":{"token":"fake"},"projects":{}}',
      "~/.gnupg/gpg.conf": "use-agent\n",
      "~/.gnupg/private-keys-v1.d/ABCDEF.key": { bytes: 2_000, mode: 0o600 },
      "~/.password-store/.gpg-id": "dev@example.com\n",
      "~/.password-store/site.gpg": 300,
      "~/.config/monid/credentials.yaml": { text: "api_key: fake\n", mode: 0o600 },
      "~/.hfstuff/tokenizer.json": { bytes: 466_000, mode: 0o644 },
      "~/.hfstuff/tokenizer_config.json": '{"model_max_length":512}',
      "~/.config/raycast/config.json": { text: '{"theme":"dark"}', mode: 0o600 },
      "~/.viminfo": { bytes: 20_000, mode: 0o600 },
      "~/.CFUserTextEncoding": { text: "0:0", mode: 0o600 },
    },
  };
}

/** The look-alikes in shapes() that must never be flagged. */
export const EXPECTED_SHAPES = [
  "~/.CFUserTextEncoding", "~/.viminfo", "~/.hfstuff/tokenizer.json", "~/.hfstuff/tokenizer_config.json", "~/.config/raycast/config.json", "~/.ssh/known_hosts",
].map(p => p.replace("~", HOME));
