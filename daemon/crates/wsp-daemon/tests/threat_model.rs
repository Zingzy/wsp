// SPDX-License-Identifier: AGPL-3.0-only
//! The threat model in wsp-review, held by reading the source. An agent writes everything in a workspace and on a
//! computer that holds workspaces this daemon runs as root over them, so two habits are refused here. A git line
//! built anywhere but the one runner of each crate, where `GitLine` keeps every name a checkout or an agent chose
//! behind a separator. And a write by path in the daemon's root paths outside the bundle helpers, unless the
//! function doing it is named below with the reason a link a workspace planted cannot steer it.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// The crates the daemon on a computer that holds workspaces is built from, each run there as root.
const ROOT_CRATES: [&str; 3] = ["wsp-daemon", "wsp-daemon-bin", "wsp-runtime"];

/// The copy road a project takes on the computer somebody sits at: it runs as that person, in a folder of theirs,
/// and no workspace of another's writes there. Its git still goes through the runner, which the first case reads.
const PERSONS_OWN: &str = "wsp-runtime/src/copy_road/";

/// The one function in each crate that names the program git.
const GIT_RUNNERS: [(&str, &str); 2] = [("wsp-daemon/src/git.rs", "run_git"), ("wsp-runtime/src/copy_road/rules.rs", "git")];

/// The calls that write by path. Each is matched as `fs::<name>` with no letter after it, so a call, a function
/// handed on by name and the tokio twin all count.
const WRITES: [&str; 13] = [
    "write",
    "create_dir",
    "create_dir_all",
    "remove_file",
    "remove_dir",
    "remove_dir_all",
    "rename",
    "set_permissions",
    "copy",
    "hard_link",
    "symlink",
    "chown",
    "lchown",
];

/// The roads from a name read at run time to a `&'static str`, which a git line's own words are.
const STATIC_STRINGS: [&str; 5] = [".leak()", "Box::leak", "OnceLock<String>", "LazyLock<String>", "OnceCell<String>"];

/// What an open writes with, read off the lines of one `OpenOptions` or `File::options()` chain.
const OPEN_WRITES: [&str; 5] = [".write(true)", ".append(true)", ".create(true)", ".create_new(true)", ".truncate(true)"];

const OWN: &str =
    "a file or folder of the runtime's or the daemon's own state, under its root or beside its token, that no workspace mounts";
const KERNEL: &str = "a kernel file: a cgroup's, or one under /proc";
const INSTALL: &str = "the computer's own install of wsp, under the prefix the setup wrote, which no workspace mounts";
const BUNDLE: &str = "a bundle helper: a workspace's boot, writing the fresh rootfs, its views and the sources of its binds under the runtime's root, or walking beneath the rootfs by descriptor";
const UNLINK: &str = "unlinks a name in a folder of the runtime's own, which takes off whatever stands there and follows no link";
const TREE: &str =
    "takes away a workspace's tree once its processes are killed and its mounts are off; remove_dir_all follows no link beneath the path";
const COPY_MADE: &str = "a copy being made, in a folder of the runtime's own that no workspace mounts until it is done";
const PTY: &str = "the pid file in the runtime's own folder, and in the wsp home the folder itself, which the runtime made and no workspace can swap, and an unlink of the size file there; the size file is written through write_file_in";
const BROKER: &str = "runs inside the workspace as its own pty broker, with the workspace's rights and in its view";
const ASIDE: &str = "the copy road's set-aside folders beside a project on the computer the person sits at";
const EMPTIED: &str = "removes the runtime's folder only once it is empty, which follows no link and takes nothing one points at";

/// Every function in the root paths allowed a write by path, and why a link a workspace planted cannot steer it.
const EXEMPT: &[(&str, &str, &str)] = &[
    ("wsp-daemon-bin/src/main.rs", "write_port_file", OWN),
    ("wsp-daemon-bin/src/score.rs", "set", KERNEL),
    ("wsp-daemon/src/lib.rs", "run", ASIDE),
    ("wsp-daemon/src/lib.rs", "write_wsp_shim", OWN),
    ("wsp-daemon/src/manifest.rs", "save", OWN),
    ("wsp-daemon/src/place.rs", "install_daemon", INSTALL),
    ("wsp-daemon/src/place.rs", "sweep_tool_prefix", INSTALL),
    ("wsp-daemon/src/place.rs", "sweep_updates", INSTALL),
    ("wsp-daemon/src/place.rs", "sweep_workspace_profile", INSTALL),
    ("wsp-daemon/src/place.rs", "take_unfound", INSTALL),
    ("wsp-daemon/src/place.rs", "take_update_part", INSTALL),
    ("wsp-daemon/src/place/outside.rs", "sweep_runtime_root", EMPTIED),
    ("wsp-daemon/src/readings_history.rs", "append", OWN),
    ("wsp-daemon/src/relay.rs", "listen_open_socket", UNLINK),
    ("wsp-daemon/src/ssh.rs", "contain", KERNEL),
    ("wsp-daemon/src/ssh.rs", "kill_cgroup", KERNEL),
    ("wsp-daemon/src/ssh.rs", "make_private_dir", OWN),
    ("wsp-daemon/src/ssh.rs", "prepare", OWN),
    ("wsp-daemon/src/ssh.rs", "write_private", OWN),
    ("wsp-runtime/src/bundle.rs", "bind_file_over", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "bind_into", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "bind_over", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "copy_no_follow", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "empty_file", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "mount_computer", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "overlay_inside", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "view_of", BUNDLE),
    ("wsp-runtime/src/bundle.rs", "write_etc", BUNDLE),
    ("wsp-runtime/src/cgroup.rs", "forbid_swap", KERNEL),
    ("wsp-runtime/src/cgroup.rs", "remove_tree", KERNEL),
    ("wsp-runtime/src/cgroup.rs", "throttle_at", KERNEL),
    ("wsp-runtime/src/copy.rs", "clones_under", OWN),
    ("wsp-runtime/src/copy.rs", "copier_for", OWN),
    ("wsp-runtime/src/copy.rs", "copies_word", OWN),
    ("wsp-runtime/src/copy.rs", "copy_tree", COPY_MADE),
    ("wsp-runtime/src/copy.rs", "open_up", TREE),
    ("wsp-runtime/src/copy.rs", "own_as", COPY_MADE),
    ("wsp-runtime/src/copy.rs", "remove_tree", TREE),
    ("wsp-runtime/src/copy.rs", "same_as", COPY_MADE),
    ("wsp-runtime/src/copy.rs", "walk", COPY_MADE),
    ("wsp-runtime/src/copy_plain.rs", "write_file", COPY_MADE),
    ("wsp-runtime/src/copy_reflink.rs", "clone_file", COPY_MADE),
    ("wsp-runtime/src/copy_reflink.rs", "clones_into", OWN),
    ("wsp-runtime/src/engine.rs", "bind", UNLINK),
    ("wsp-runtime/src/net.rs", "rules_down", KERNEL),
    ("wsp-runtime/src/net.rs", "take_down", OWN),
    ("wsp-runtime/src/net.rs", "turn_forwarding_on", KERNEL),
    ("wsp-runtime/src/net.rs", "up", KERNEL),
    ("wsp-runtime/src/ops.rs", "binds_of", OWN),
    ("wsp-runtime/src/ops.rs", "boot", OWN),
    ("wsp-runtime/src/ops.rs", "clear_binds", OWN),
    ("wsp-runtime/src/ops.rs", "create_with_room", OWN),
    ("wsp-runtime/src/ops.rs", "make_copy", COPY_MADE),
    ("wsp-runtime/src/ops.rs", "mark_stopped", OWN),
    ("wsp-runtime/src/ops.rs", "open", OWN),
    ("wsp-runtime/src/ops.rs", "put_bytes", OWN),
    ("wsp-runtime/src/ops.rs", "ready_binds", OWN),
    ("wsp-runtime/src/ops.rs", "remove", TREE),
    ("wsp-runtime/src/ops.rs", "self_check_on", OWN),
    ("wsp-runtime/src/ops.rs", "stop", UNLINK),
    ("wsp-runtime/src/ops.rs", "stop_engine", UNLINK),
    ("wsp-runtime/src/ops.rs", "sweep_unfinished", OWN),
    ("wsp-runtime/src/pty.rs", "relay", BROKER),
    ("wsp-runtime/src/runtime.rs", "drop", UNLINK),
    ("wsp-runtime/src/runtime.rs", "helper_create", OWN),
    ("wsp-runtime/src/runtime.rs", "kill", OWN),
    ("wsp-runtime/src/runtime.rs", "pty", PTY),
    ("wsp-runtime/src/runtime.rs", "remove_stale_notify_sockets", OWN),
    ("wsp-runtime/src/runtime.rs", "spawn", OWN),
];

/// One line of source outside test code: where it is, the function it sits in, and its text.
struct Line {
    file: String,
    at: usize,
    function: String,
    text: String,
}

fn crates() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The function a line opens, by the name after `fn `.
fn opens_function(line: &str) -> Option<String> {
    let mut rest = line.trim_start();
    for word in ["pub(crate) ", "pub(super) ", "pub ", "const ", "async ", "unsafe ", "extern \"C\" "] {
        rest = rest.strip_prefix(word).unwrap_or(rest);
    }
    let name = rest.strip_prefix("fn ")?;
    Some(name.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect())
}

/// Every line of the root crates' sources outside test code and comments.
fn source_lines() -> Vec<Line> {
    let root = crates();
    let mut sources = Vec::new();
    for krate in ROOT_CRATES {
        let mut files = Vec::new();
        rust_files(&root.join(krate).join("src"), &mut files);
        files.sort();
        for path in files {
            let file = path.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
            sources.push((file, fs::read_to_string(&path).unwrap()));
        }
    }
    lines_of(&sources)
}

/// The lines of each source, a path under the crates and its text, outside `#[cfg(test)]` items, the files of modules
/// declared under one, and comments.
fn lines_of(sources: &[(String, String)]) -> Vec<Line> {
    let test_files: BTreeSet<String> = sources.iter().flat_map(|(file, text)| test_modules(file, text)).collect();
    let mut lines = Vec::new();
    for (file, text) in sources.iter().filter(|(file, _)| !test_files.contains(file)) {
        let all: Vec<&str> = text.lines().collect();
        let mut function = String::new();
        let mut i = 0;
        while i < all.len() {
            let trimmed = all[i].trim();
            if test_gate(trimmed) {
                i = past_item(&all, i + 1);
                continue;
            }
            if let Some(name) = opens_function(all[i]) {
                function = name;
            }
            if !trimmed.starts_with("//") {
                lines.push(Line { file: file.clone(), at: i + 1, function: function.clone(), text: all[i].to_owned() });
            }
            i += 1;
        }
    }
    lines
}

/// The files Rust would read for each `#[cfg(test)] mod name;` that `file` declares, at both places it looks.
fn test_modules(file: &str, text: &str) -> Vec<String> {
    let dir = ["/lib.rs", "/main.rs", "/mod.rs"]
        .iter()
        .find_map(|end| file.strip_suffix(end))
        .map_or_else(|| file.trim_end_matches(".rs").to_owned(), str::to_owned);
    let all: Vec<&str> = text.lines().map(str::trim).collect();
    let mut files = Vec::new();
    for i in (0..all.len()).filter(|&i| test_gate(all[i])) {
        let Some(item) = all[i + 1..].iter().find(|l| !l.starts_with("#[")) else { continue };
        let mut rest = *item;
        for word in ["pub(crate) ", "pub(super) ", "pub "] {
            rest = rest.strip_prefix(word).unwrap_or(rest);
        }
        if let Some(name) = rest.strip_prefix("mod ").and_then(|r| r.strip_suffix(';')) {
            files.push(format!("{dir}/{name}.rs"));
            files.push(format!("{dir}/{name}/mod.rs"));
        }
    }
    files
}

/// A `cfg` that keeps an item to test builds: `test` as a word of its own and not under `not(`, so a feature named
/// `testing` is read as the source it is.
fn test_gate(line: &str) -> bool {
    let words = || line.split(|c: char| !c.is_alphanumeric() && c != '_');
    line.starts_with("#[cfg(") && words().any(|word| word == "test") && !line.contains("not(test")
}

/// The index past the item that starts at `from`: to its matching brace, or past its semicolon.
fn past_item(all: &[&str], from: usize) -> usize {
    let mut depth = 0i32;
    let mut opened = false;
    for (i, line) in all.iter().enumerate().skip(from) {
        depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
        opened |= line.contains('{');
        if (opened && depth <= 0) || (!opened && line.trim_end().ends_with(';')) {
            return i + 1;
        }
    }
    all.len()
}

fn writes_by_path(text: &str) -> bool {
    WRITES.iter().any(|name| {
        let call = format!("fs::{name}");
        text.match_indices(&call).any(|(at, _)| {
            let after = text[at + call.len()..].chars().next();
            !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
        })
    }) || ["File::create(", "File::create_new(", "DirBuilder::new("].iter().any(|call| text.contains(call))
}

#[test]
fn a_module_declared_under_a_test_cfg_is_read_as_test_code_and_the_file_beside_it_as_source() {
    let source = |file: &str, text: &str| (file.to_owned(), text.to_owned());
    let lines = lines_of(&[
        source("wsp-daemon/src/place.rs", "#[cfg(test)]\nmod version_tests;\nmod real;\n"),
        source("wsp-daemon/src/place/real.rs", "fn keep() {\n    std::fs::write(at, b\"\")?;\n}\n"),
        source("wsp-daemon/src/place/version_tests.rs", "fn fake_bin() {\n    std::fs::write(at, b\"\")?;\n}\n"),
        source("wsp-daemon/src/lib.rs", "#[cfg(test)]\npub(crate) mod helpers;\n"),
        source("wsp-daemon/src/helpers/mod.rs", "fn stub() {\n    std::fs::write(at, b\"\")?;\n}\n"),
    ]);
    let writes: Vec<String> = lines.iter().filter(|l| writes_by_path(&l.text)).map(|l| format!("{} in {}", l.file, l.function)).collect();
    assert_eq!(writes, ["wsp-daemon/src/place/real.rs in keep"]);
}

#[test]
fn git_runs_only_through_its_runner() {
    let mut found = Vec::new();
    let mut runners_seen = 0;
    for line in source_lines() {
        let names_git = line.text.contains("\"git\"");
        let runner = GIT_RUNNERS.iter().any(|(file, function)| line.file == *file && line.function == *function);
        runners_seen += usize::from(names_git && runner);
        if (names_git && !runner) || STATIC_STRINGS.iter().any(|road| line.text.contains(road)) {
            found.push(format!("{}:{} in {}: {}", line.file, line.at, line.function, line.text.trim()));
        }
    }
    assert!(
        found.is_empty(),
        "git is run only through run_git and copy_road::rules::git, with a GitLine, so a name an agent chose never reaches \
         git as a flag:\n{}",
        found.join("\n")
    );
    assert!(runners_seen >= GIT_RUNNERS.len(), "a runner no longer names git: the reading above read nothing");
}

#[test]
fn a_root_write_names_its_reason() {
    let lines: Vec<Line> = source_lines().into_iter().filter(|l| !l.file.starts_with(PERSONS_OWN)).collect();
    let mut found = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.text.trim_start();
        let imported = (trimmed.starts_with("use std::fs::") || trimmed.starts_with("use tokio::fs::"))
            && WRITES.iter().any(|name| trimmed.split(|c: char| !c.is_alphanumeric() && c != '_').any(|word| word == *name));
        if imported {
            found.push(format!("{}:{}: a write imported bare cannot be read here: {}", line.file, line.at, trimmed));
            continue;
        }
        let chain: String = lines[i..(i + 4).min(lines.len())].iter().map(|l| l.text.as_str()).collect();
        let opens_to_write = (line.text.contains("OpenOptions::new()") || line.text.contains("File::options()"))
            && OPEN_WRITES.iter().any(|w| chain.contains(w));
        if !writes_by_path(&line.text) && !opens_to_write {
            continue;
        }
        seen.insert((line.file.clone(), line.function.clone()));
        if !EXEMPT.iter().any(|(file, function, _)| line.file == *file && line.function == *function) {
            found.push(format!("{}:{} in {}: {}", line.file, line.at, line.function, trimmed));
        }
    }
    let stale: Vec<String> = EXEMPT
        .iter()
        .filter(|(file, function, _)| !seen.contains(&((*file).to_owned(), (*function).to_owned())))
        .map(|(file, function, _)| format!("{file} {function}"))
        .collect();
    assert!(
        found.is_empty(),
        "a write by path in the daemon's root paths follows a link a workspace planted onto the computer's own file. Write \
         through the bundle helpers (write_file_inside, write_file_in, open_inside), or name the function in EXEMPT with \
         why no link can steer it:\n{}",
        found.join("\n")
    );
    assert!(stale.is_empty(), "named in EXEMPT and writing nothing by path any more, so the name goes:\n{}", stale.join("\n"));
}
