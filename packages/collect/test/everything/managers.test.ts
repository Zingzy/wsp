// SPDX-License-Identifier: AGPL-3.0-only
// Pass 8 over one fixture HOME per dotfiles manager: which directory is the
// manager's home, which files in it stand for rc files, and what the fold
// says about the ones the copy cannot strip.
import { describe, expect, it } from "vitest";
import { type EverythingOptions, MANAGER_HOMES, type Machine, Rows, everything as fold, managedName, managedRc, managerHomes } from "../../src/index.js";
import { HOME, NOW, laptop, many, type Laptop } from "./fixture.js";

/** The walks' time caps read this clock, so the entry caps alone decide what a test sees. */
const everything = (m: Machine, opts: EverythingOptions = {}): ReturnType<typeof fold> => fold(m, { clock: () => 0, ...opts });

const CHEZMOI: Laptop = {
  files: {
    "~/.zshrc": "export PATH=$HOME/bin:$PATH\n",
    "~/.local/share/chezmoi/.chezmoi.toml.tmpl": "[data]\n",
    "~/.local/share/chezmoi/dot_zshrc.tmpl": "export GH_TOKEN={{ .ghToken }}\nalias ll='ls -l'\n",
    "~/.local/share/chezmoi/private_dot_bashrc": "export AWS_SECRET_ACCESS_KEY=fake-chez-aws\nalias g=git\n",
    "~/.local/share/chezmoi/exact_dot_config/fish/conf.d/private_work.fish.tmpl": "set -gx WORK_KEY fake-chez-fish\n",
    "~/.local/share/chezmoi/dot_config/nvim/init.lua": "vim.g.mapleader = ' '\n",
    "~/.local/share/chezmoi/dot_gitconfig": "[user]\n\tname = dev\n",
    "~/.local/share/chezmoi/run_once_install.sh.tmpl": "export NPM_TOKEN=fake-chez-run\nnpm install -g x\n",
    "~/.local/share/chezmoi/README.md": "export README_TOKEN=looks-like-one\n",
    "~/.local/share/chezmoi/.git/HEAD": "ref: refs/heads/main\n",
    "~/.local/share/chezmoi/.git/objects/ab/cdef": 300,
  },
};

const CHEZMOI_ELSEWHERE: Laptop = {
  which: ["chezmoi"],
  exec: { "chezmoi source-path": "/Users/dev/src/dots\n" },
  files: {
    "~/src/dots/dot_zshrc": "export GH_TOKEN=fake-elsewhere\n",
    "~/src/dots/README.md": "notes\n",
  },
};

const YADM: Laptop = {
  files: {
    "~/.zshrc": "export GH_TOKEN=fake-yadm-home\n",
    "~/.local/share/yadm/repo.git/HEAD": "ref: refs/heads/main\n",
    "~/.local/share/yadm/repo.git/objects/ab/cdef": 300,
    "~/.config/yadm/bootstrap": { text: "#!/bin/sh\nexport NPM_TOKEN=fake-yadm-boot\n", mode: 0o755 },
    "~/.config/yadm/encrypt": ".ssh/id_ed25519\n",
  },
};

const STOW: Laptop = {
  links: {
    "~/.zshrc": "/Users/dev/.dotfiles/zsh/.zshrc",
    "~/.config/fish/config.fish": "/Users/dev/.dotfiles/fish/.config/fish/config.fish",
    "~/.config/fish/conf.d/env.fish": "/Users/dev/.dotfiles/fish/.config/fish/conf.d/env.fish",
  },
  files: {
    "~/.dotfiles/zsh/.zshrc": "export GH_TOKEN=fake-stow-zsh\nalias ll='ls -l'\n",
    "~/.dotfiles/zsh/.zsh/work.zsh": "export WORK_KEY=fake-stow-work\n",
    "~/.dotfiles/fish/.config/fish/config.fish": "set -gx FISH_KEY fake-stow-fish\n",
    "~/.dotfiles/fish/.config/fish/conf.d/env.fish": "set -gx ENV_TOKEN fake-stow-confd\n",
    "~/.dotfiles/bash/.bashrc": "export B_KEY=fake-stow-bash\n",
    "~/.dotfiles/git/.gitconfig": "[user]\n\tname = dev\n",
  },
};

const PLAIN: Laptop = {
  files: {
    "~/.zshrc": "source ~/.dotfiles/exports.sh\nexport PATH=$HOME/bin:$PATH\n",
    "~/.dotfiles/zshrc": "export GH_TOKEN=fake-plain-zsh\n",
    "~/.dotfiles/zsh/aliases": "alias g=git\nexport ALIAS_TOKEN=fake-plain-alias\n",
    "~/.dotfiles/nvim/profile": "export NVIM_KEY=fake-plain-nvim\n",
    "~/.dotfiles/exports.sh": "export STRIPE_KEY=fake-plain-sourced\n",
    "~/.dotfiles/work.sh": "export WORK_TOKEN=fake-plain-work\n",
    "~/.dotfiles/README.md": "export README_TOKEN=looks-like-one\n",
    "~/.dotfiles/install.sh": "echo hi\n",
    "~/dotfiles/tmux.conf": "set -g mouse on\n",
  },
};

/** A repository the person cloned under ~/src and linked by hand, beside another project: not a stow directory. */
const HAND_LINKED: Laptop = {
  links: { "~/.zshrc": "/Users/dev/src/dotfiles/.zshrc", "~/.bashrc": "/Users/dev/work/acme-infra/.bashrc" },
  files: {
    "~/src/dotfiles/.zshrc": "export GH_TOKEN=fake-hand-zsh\nalias a=b\n",
    "~/src/dotfiles/.git/HEAD": "ref: refs/heads/main\n",
    "~/src/other/.git/HEAD": "ref: refs/heads/main\n",
    "~/src/other/run": "#!/bin/sh\nexport DEPLOY_TOKEN=fake-hand-run\n",
    "~/work/acme-infra/.bashrc": "export B_KEY=fake-hand-bash\n",
    "~/work/acme-infra/deploy.sh": "export DEPLOY_KEY=fake-hand-deploy\n",
  },
};

/** One directory reached two ways: the plain name is a link to where stow's layout resolves. */
const LINKED_HOME: Laptop = {
  links: { "~/.dotfiles": "/Users/dev/src2/dotfiles", "~/.zshrc": "/Users/dev/.dotfiles/zsh/.zshrc" },
  files: {
    "~/src2/dotfiles/zsh/.zshrc": "export GH_TOKEN=fake-linked-home\nalias a=b\n",
    "~/src2/dotfiles/.git/HEAD": "ref: refs/heads/main\n",
  },
};

/** chezmoi's documented nested layout: .chezmoiroot names the source root below the source directory. */
const CHEZMOI_ROOT: Laptop = {
  which: ["chezmoi"],
  exec: { "chezmoi source-path": "/Users/dev/.local/share/chezmoi/home\n" },
  files: {
    "~/.local/share/chezmoi/.chezmoiroot": "home\n",
    "~/.local/share/chezmoi/home/dot_zshrc": "export GH_TOKEN=fake-root\nalias a=b\n",
    "~/.local/share/chezmoi/home/dot_gitconfig": "[user]\n",
  },
};

const noValues = (x: unknown): void => {
  expect(JSON.stringify(x)).not.toContain("fake-");
};

describe("pass 8: dotfiles managers", () => {
  it("maps a copy's name back to the rc file it stands for: chezmoi's attribute prefixes, dot_, .tmpl and a missing dot, at any depth inside the home", () => {
    expect(managedName("private_dot_zshrc")).toBe(".zshrc");
    expect(managedName("dot_zshrc.tmpl")).toBe(".zshrc");
    expect(managedName("encrypted_private_readonly_dot_bashrc.tmpl")).toBe(".bashrc");
    expect(managedName("exact_dot_config")).toBe(".config");
    expect(managedName("symlink_dot_zshenv.tmpl")).toBe(".zshenv");
    expect(managedName("executable_dot_profile")).toBe(".profile");
    expect(managedName("run_once_install.sh.tmpl")).toBe("run_once_install.sh");
    expect(managedName("zshrc")).toBe("zshrc");
    const yes = [
      "zshrc", "dot_zshrc", "private_dot_zshrc", "dot_zshrc.tmpl", ".zshrc", "zsh/aliases", "zsh/.zshrc", "nvim/profile", "home/dot_zshrc", "dot_config/zsh/dot_zshrc",
      "config.fish", "dot_config/fish/config.fish", "exact_dot_config/fish/conf.d/private_work.fish.tmpl", "fish/.config/fish/conf.d/env.fish", "config/fish/conf.d/env.fish",
    ];
    const no = ["README.md", "dot_gitconfig", "private_dot_gitconfig", "dot_config/nvim/init.lua", "dot_config/fish/conf.d/sub/x.fish", "dot_config/fish/functions/x.fish", "zshrc.bak", "exports.sh", "run_once_install.sh.tmpl", "work.zsh"];
    for (const rel of yes) expect(managedRc(rel), rel).toBe(true);
    for (const rel of no) expect(managedRc(rel), rel).toBe(false);
  });

  it("names each manager's home: chezmoi by its own answer or its markers, yadm by repo.git, stow by an rc link into <dir>/<package>/<same path>, else a plain dotfiles directory", async () => {
    expect(await managerHomes(laptop(CHEZMOI))).toEqual([{ path: `${HOME}/.local/share/chezmoi`, manager: "chezmoi" }]);
    expect(await managerHomes(laptop(CHEZMOI_ELSEWHERE))).toEqual([{ path: `${HOME}/src/dots`, manager: "chezmoi" }]);
    expect(await managerHomes(laptop(YADM))).toEqual([{ path: `${HOME}/.config/yadm`, manager: "yadm" }, { path: `${HOME}/.local/share/yadm`, manager: "yadm" }]);
    expect(await managerHomes(laptop(STOW))).toEqual([{ path: `${HOME}/.dotfiles`, manager: "stow" }]);
    expect(await managerHomes(laptop(PLAIN))).toEqual([{ path: `${HOME}/.dotfiles`, manager: "dotfiles" }, { path: `${HOME}/dotfiles`, manager: "dotfiles" }]);
    // chezmoi's answer outside HOME names nothing that travels; its markers make a plain dotfiles directory chezmoi's
    expect(await managerHomes(laptop({ which: ["chezmoi"], exec: { "chezmoi source-path": "/opt/dots\n" }, files: { "/opt/dots/dot_zshrc": "x\n" } }))).toEqual([]);
    expect(await managerHomes(laptop({ files: { "~/.dotfiles/.chezmoiroot": "home\n", "~/.dotfiles/home/dot_zshrc": "x\n" } }))).toEqual([{ path: `${HOME}/.dotfiles`, manager: "chezmoi" }]);
    // an rc linked to a dot-less copy is not stow's layout; the plain rule names the directory
    expect(await managerHomes(laptop({ links: { "~/.zshrc": "/Users/dev/.dotfiles/zshrc" }, files: { "~/.dotfiles/zshrc": "x\n" } }))).toEqual([{ path: `${HOME}/.dotfiles`, manager: "dotfiles" }]);
    // stow's layout is named only with corroboration: the directory is .dotfiles or dotfiles, or holds .git, .stowrc or .stow-local-ignore;
    // a hand-linked repository (its own .git) is the home itself, plain; one link's shape alone names nothing
    expect(await managerHomes(laptop(HAND_LINKED))).toEqual([{ path: `${HOME}/src/dotfiles`, manager: "dotfiles" }]);
    for (const marker of [".stowrc", ".stow-local-ignore", ".git/HEAD"]) {
      expect(await managerHomes(laptop({ links: { "~/.zshrc": "/Users/dev/stow/zsh/.zshrc" }, files: { "~/stow/zsh/.zshrc": "x\n", [`~/stow/${marker}`]: "x\n" } })), marker).toEqual([{ path: `${HOME}/stow`, manager: "stow" }]);
    }
    expect(await managerHomes(laptop({ links: { "~/.zshrc": "/Users/dev/stow/zsh/.zshrc" }, files: { "~/stow/zsh/.zshrc": "x\n", "~/stow/README.md": "x\n" } }))).toEqual([]);
    // one directory reached two ways is one home, under the path first claimed; a claim at or under a claimed home is dropped, an inner one gives way to its outer
    expect(await managerHomes(laptop(LINKED_HOME))).toEqual([{ path: `${HOME}/src2/dotfiles`, manager: "stow" }]);
    expect(await managerHomes(laptop(CHEZMOI_ROOT))).toEqual([{ path: `${HOME}/.local/share/chezmoi`, manager: "chezmoi" }]);
    // stow's layout with HOME itself as the stow directory names nothing
    expect(await managerHomes(laptop({ links: { "~/.zshrc": "/Users/dev/zsh/.zshrc" }, files: { "~/zsh/.zshrc": "x\n" } }))).toEqual([]);
    expect(await managerHomes(laptop({ files: { "~/.zshrc": "x\n" } }))).toEqual([]);
    expect(MANAGER_HOMES).toEqual([".dotfiles", "dotfiles", ".local/share/chezmoi", ".local/share/yadm", ".config/yadm"]);
  });

  it("chezmoi: the home row is config with its rc copies named, the copy the name rule cannot strip and the git history are consent rows split out of it", async () => {
    const { rows, shell } = await everything(laptop(CHEZMOI), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
    const home = rows.find(r => r.paths[0] === "~/.local/share/chezmoi");
    expect(home).toMatchObject({
      name: "chezmoi",
      kind: "config",
      manager: "chezmoi",
      rcCopies: ["dot_zshrc.tmpl", "exact_dot_config/fish/conf.d/private_work.fish.tmpl", "private_dot_bashrc"],
      rcSecrets: ["dot_zshrc.tmpl", "exact_dot_config/fish/conf.d/private_work.fish.tmpl", "private_dot_bashrc"],
      excludes: ["~/.local/share/chezmoi/.git", "~/.local/share/chezmoi/run_once_install.sh.tmpl"],
      flags: ["credential"],
      files: 7,
    });
    expect(rows.find(r => r.name === "chezmoi/run_once_install.sh.tmpl")).toMatchObject({ kind: "credential", flags: ["credential", "exports"], paths: ["~/.local/share/chezmoi/run_once_install.sh.tmpl"], files: 1 });
    expect(rows.find(r => r.name === "chezmoi/.git")).toMatchObject({ kind: "credential", flags: ["credential", "history"], paths: ["~/.local/share/chezmoi/.git"], files: 2 });
    expect(rows.some(r => r.name.endsWith("README.md") || r.name.endsWith("dot_gitconfig"))).toBe(false);
    expect(shell.map(s => [s.path, s.names])).toEqual([
      ["~/.local/share/chezmoi/dot_zshrc.tmpl", ["GH_TOKEN"]],
      ["~/.local/share/chezmoi/exact_dot_config/fish/conf.d/private_work.fish.tmpl", ["WORK_KEY"]],
      ["~/.local/share/chezmoi/private_dot_bashrc", ["AWS_SECRET_ACCESS_KEY"]],
    ]);
    noValues({ rows, shell });
  });

  it("chezmoi with its source elsewhere: the answered directory becomes a row of its own", async () => {
    const { rows, shell } = await everything(laptop(CHEZMOI_ELSEWHERE), { now: NOW });
    expect(rows.find(r => r.paths[0] === "~/src/dots")).toMatchObject({ name: "dots", kind: "config", manager: "chezmoi", rcCopies: ["dot_zshrc"], rcSecrets: ["dot_zshrc"], files: 2 });
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/src/dots/dot_zshrc", ["GH_TOKEN"]]]);
    noValues({ rows, shell });
  });

  it("yadm: the dotfiles are the ones at home; the repository is a history consent row and a script with exports is one too", async () => {
    const { rows, shell } = await everything(laptop(YADM), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
    expect(rows.some(r => r.paths[0] === "~/.local/share/yadm")).toBe(false);
    expect(rows.find(r => r.name === "yadm/repo.git")).toMatchObject({ kind: "credential", flags: ["credential", "history"], paths: ["~/.local/share/yadm/repo.git"], files: 2, bytes: 321 });
    expect(rows.find(r => r.paths[0] === "~/.config/yadm")).toMatchObject({ name: "yadm", kind: "config", manager: "yadm", rcCopies: [], rcSecrets: [], excludes: ["~/.config/yadm/bootstrap"], flags: ["credential"], files: 1 });
    expect(rows.find(r => r.name === "yadm/bootstrap")).toMatchObject({ kind: "credential", flags: ["credential", "exports"] });
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/.zshrc", ["GH_TOKEN"]]]);
    noValues({ rows, shell });
  });

  it("stow: the directory the rc links resolve into is the home, every package's rc copy is named, and the linked rc files are read through their targets", async () => {
    const { rows, shell } = await everything(laptop(STOW), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
    expect(rows.find(r => r.paths[0] === "~/.dotfiles")).toMatchObject({
      name: ".dotfiles",
      kind: "config",
      manager: "stow",
      rcCopies: ["bash/.bashrc", "fish/.config/fish/conf.d/env.fish", "fish/.config/fish/config.fish", "zsh/.zshrc"],
      rcSecrets: ["bash/.bashrc", "fish/.config/fish/conf.d/env.fish", "fish/.config/fish/config.fish", "zsh/.zshrc"],
      excludes: ["~/.dotfiles/zsh/.zsh/work.zsh"],
      flags: ["credential"],
      files: 5,
    });
    expect(rows.find(r => r.name === ".dotfiles/work.zsh")).toMatchObject({ kind: "credential", flags: ["credential", "exports"], paths: ["~/.dotfiles/zsh/.zsh/work.zsh"] });
    expect(rows.find(r => r.name === ".zshrc")).toMatchObject({ paths: ["~/.zshrc"], linkTarget: "~/.dotfiles/zsh/.zshrc" });
    expect(shell.map(s => [s.path, s.names])).toEqual([
      ["~/.zshrc", ["GH_TOKEN"]],
      ["~/.config/fish/config.fish", ["FISH_KEY"]],
      ["~/.config/fish/conf.d/env.fish", ["ENV_TOKEN"]],
      ["~/.dotfiles/bash/.bashrc", ["B_KEY"]],
      ["~/.dotfiles/fish/.config/fish/conf.d/env.fish", ["ENV_TOKEN"]],
      ["~/.dotfiles/fish/.config/fish/config.fish", ["FISH_KEY"]],
      ["~/.dotfiles/zsh/.zshrc", ["GH_TOKEN"]],
    ]);
    noValues({ rows, shell });
  });

  it("plain ~/.dotfiles and ~/dotfiles: dot-less copies map at any depth, a file the rc sources is stripped by identity rather than split out, a README is neither", async () => {
    const { rows, shell } = await everything(laptop(PLAIN), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
    expect(rows.find(r => r.paths[0] === "~/.dotfiles")).toMatchObject({
      name: ".dotfiles",
      kind: "config",
      manager: "dotfiles",
      rcCopies: ["nvim/profile", "zsh/aliases", "zshrc"],
      rcSecrets: ["nvim/profile", "zsh/aliases", "zshrc"],
      excludes: ["~/.dotfiles/work.sh"],
      flags: ["credential"],
      files: 6,
    });
    expect(rows.find(r => r.paths[0] === "~/dotfiles")).toMatchObject({ name: "dotfiles", kind: "config", manager: "dotfiles", rcCopies: [], rcSecrets: [], flags: [], files: 1 });
    expect(rows.find(r => r.name === ".dotfiles/work.sh")).toMatchObject({ kind: "credential", flags: ["credential", "exports"] });
    expect(rows.some(r => r.name.endsWith("exports.sh") || r.name.endsWith("README.md"))).toBe(false);
    expect(shell.map(s => [s.path, s.names])).toEqual([
      ["~/.dotfiles/exports.sh", ["STRIPE_KEY"]],
      ["~/.dotfiles/nvim/profile", ["NVIM_KEY"]],
      ["~/.dotfiles/zsh/aliases", ["ALIAS_TOKEN"]],
      ["~/.dotfiles/zshrc", ["GH_TOKEN"]],
    ]);
    noValues({ rows, shell });
  });

  it("a repository nested inside the home (a package that is its own repo) is a history consent row like the top-level one, never a plain state row", async () => {
    const { rows } = await everything(laptop({ files: {
      "~/.dotfiles/zsh/.zshrc": "alias a=b\n",
      "~/.dotfiles/.git/HEAD": "ref: refs/heads/main\n",
      "~/.dotfiles/zsh/.git/HEAD": "ref: refs/heads/main\n",
      "~/.dotfiles/zsh/.git/objects/ab/cdef": 300,
    } }), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
    const history = rows.filter(r => r.flags.includes("history")).map(r => [r.name, r.kind, r.paths[0], r.files, r.flags.join("+")]).sort();
    expect(history).toEqual([
      [".dotfiles/.git", "credential", "~/.dotfiles/.git", 1, "credential+history"],
      ["zsh/.git", "credential", "~/.dotfiles/zsh/.git", 2, "credential+history"],
    ]);
    expect(rows.find(r => r.paths[0] === "~/.dotfiles")).toMatchObject({ manager: "dotfiles", excludes: ["~/.dotfiles/.git", "~/.dotfiles/zsh/.git"], rcCopies: ["zsh/.zshrc"], files: 1 });
    expect(rows.some(r => r.kind === "state")).toBe(false);
  });

  it("a repository linked by hand under ~/src is its own home; the code tree around it and a project with no repository are not rows", async () => {
    const { rows, shell } = await everything(laptop(HAND_LINKED), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
    expect(rows.find(r => r.paths[0] === "~/src/dotfiles")).toMatchObject({ name: "dotfiles", kind: "config", manager: "dotfiles", rcCopies: [".zshrc"], rcSecrets: [".zshrc"], excludes: ["~/src/dotfiles/.git"], files: 1 });
    expect(rows.filter(r => r.flags.includes("history")).map(r => r.paths[0])).toEqual(["~/src/dotfiles/.git"]);
    expect(rows.some(r => r.flags.includes("exports"))).toBe(false);
    expect(rows.some(r => ["~/src", "~/work", "~/src/other", "~/work/acme-infra"].includes(r.paths[0] ?? ""))).toBe(false);
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/.zshrc", ["GH_TOKEN"]], ["~/.bashrc", ["B_KEY"]], ["~/src/dotfiles/.zshrc", ["GH_TOKEN"]]]);
    noValues({ rows, shell });
  });

  it("a home that is a link at its plain name is one row, under the link, scanned once", async () => {
    const { rows, shell } = await everything(laptop(LINKED_HOME), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
    expect(rows.filter(r => ["~/.dotfiles", "~/src2/dotfiles"].includes(r.paths[0] ?? "")).map(r => r.paths[0])).toEqual(["~/.dotfiles"]);
    expect(rows.find(r => r.paths[0] === "~/.dotfiles")).toMatchObject({ name: ".dotfiles", kind: "config", manager: "stow", linkTarget: "~/src2/dotfiles", rcCopies: ["zsh/.zshrc"], rcSecrets: ["zsh/.zshrc"], excludes: ["~/.dotfiles/.git"], files: 1 });
    expect(rows.filter(r => r.flags.includes("history")).map(r => r.paths[0])).toEqual(["~/.dotfiles/.git"]);
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/.zshrc", ["GH_TOKEN"]], ["~/.dotfiles/zsh/.zshrc", ["GH_TOKEN"]]]);
    noValues({ rows, shell });
  });

  it("chezmoi's nested root is one home at the marked directory and each copy is reported once", async () => {
    const { rows, shell } = await everything(laptop(CHEZMOI_ROOT), { now: NOW });
    expect(rows.filter(r => r.manager !== undefined).map(r => r.paths[0])).toEqual(["~/.local/share/chezmoi"]);
    expect(rows.find(r => r.paths[0] === "~/.local/share/chezmoi")).toMatchObject({ name: "chezmoi", manager: "chezmoi", rcCopies: ["home/dot_zshrc"], rcSecrets: ["home/dot_zshrc"], files: 3 });
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/.local/share/chezmoi/home/dot_zshrc", ["GH_TOKEN"]]]);
    noValues({ rows, shell });
  });

  it("a manager home too big to walk leaves a note and names what it saw", async () => {
    const { rows, notes } = await everything(laptop({ files: { "~/.dotfiles/zshrc": "export GH_TOKEN=fake-big\n", ...many("~/.dotfiles/vendor", 6_000) } }), { now: NOW });
    expect(notes).toContain("~/.dotfiles: the scan for rc copies stopped at the cap");
    expect(rows.find(r => r.paths[0] === "~/.dotfiles")).toMatchObject({ manager: "dotfiles", rcSecrets: ["zshrc"] });
  });
});
