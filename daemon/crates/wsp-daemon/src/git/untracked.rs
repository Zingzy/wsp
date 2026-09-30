// SPDX-License-Identifier: AGPL-3.0-only
//! A worktree file as this daemon reads it itself rather than as git reads it: the folder the caller may read opened
//! as it is, then every folder under it and the file with no link followed (see beneath), so a writer inside the copy
//! that swaps the file, or a folder above it, for a link after git listed it gets nothing rather than a file outside
//! the root. Every blob id git.diff answers and every untracked file's patch come from this one read, and the patch
//! is the one git writes for a new file.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path};

use nix::fcntl::{open, OFlag};
use nix::sys::stat::Mode;

use super::OnThisSide;
use crate::beneath;

/// The most of one file this daemon reads: the bytes are a writer's to make as large as it likes, and the read
/// holds one of its few blocking threads.
pub(crate) const READ_MAX: usize = 32 << 20;

/// How far git looks for a NUL before it calls a file binary.
const BINARY_PROBE: usize = 8000;

/// What this side reads at a worktree file.
pub(crate) enum Seen {
    File {
        bytes: Vec<u8>,
        exec: bool,
    },
    /// Past READ_MAX, so never read: it carries no patch and no blob, as a file past the budget carries no patch.
    TooLarge,
}

/// `rel` below the folder `at` names, read with no link followed and no more than READ_MAX bytes of it. None where
/// no regular file stands there by the time it is opened.
pub(crate) fn seen(at: &OnThisSide, rel: &str) -> Option<Seen> {
    let held = open(&at.open, OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty()).ok()?;
    let file = beneath::file(&held, &joined(&at.walk, rel)?).ok()??;
    let meta = file.metadata().ok()?;
    if meta.len() > READ_MAX as u64 {
        return Some(Seen::TooLarge);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(READ_MAX as u64 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > READ_MAX {
        return Some(Seen::TooLarge);
    }
    Some(Seen::File { bytes, exec: meta.permissions().mode() & 0o100 != 0 })
}

/// The walk's names, then rel's, as one name under the held folder; None where the walk takes a way up.
fn joined(walk: &Path, rel: &str) -> Option<String> {
    let mut names = Vec::new();
    for part in walk.components() {
        match part {
            Component::Normal(name) => names.push(name.to_str()?),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    names.push(rel);
    Some(names.join("/"))
}

/// The patch `git diff --no-index -- /dev/null <rel>` prints for a new file holding `bytes`: every line added in one
/// hunk, a binary file said in one line, and an empty one with its header alone, its blob id cut to the length git
/// abbreviates to in this repository.
pub(crate) fn patch_of(rel: &str, bytes: &[u8], exec: bool, blob: Option<&str>, abbrev: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let (a, b) = (quoted("a/", rel), quoted("b/", rel));
    out.extend(format!("diff --git {a} {b}\nnew file mode {}\n", if exec { "100755" } else { "100644" }).as_bytes());
    if let Some(blob) = blob {
        out.extend(format!("index 0000000..{}\n", &blob[..abbrev.min(blob.len())]).as_bytes());
    }
    if bytes.is_empty() {
        return out;
    }
    if bytes[..bytes.len().min(BINARY_PROBE)].contains(&0) {
        out.extend(format!("Binary files /dev/null and {b} differ\n").as_bytes());
        return out;
    }
    let lines = bytes.split_inclusive(|&c| c == b'\n').count();
    // git ends a name holding a space with a tab on this line, as a patch program reads it.
    let tab = if rel.contains(' ') { "\t" } else { "" };
    out.extend(format!("--- /dev/null\n+++ {b}{tab}\n").as_bytes());
    out.extend(if lines == 1 { "@@ -0,0 +1 @@\n".to_owned() } else { format!("@@ -0,0 +1,{lines} @@\n") }.as_bytes());
    for line in bytes.split_inclusive(|&c| c == b'\n') {
        out.push(b'+');
        out.extend_from_slice(line);
    }
    if !bytes.ends_with(b"\n") {
        out.extend(b"\n\\ No newline at end of file\n");
    }
    out
}

/// A path as git's headers name it with quotePath on, its default: as it is, or in double quotes with every quote,
/// backslash, control byte and byte past ASCII escaped the way C writes them.
fn quoted(prefix: &str, rel: &str) -> String {
    let named = format!("{prefix}{rel}");
    if !named.bytes().any(|b| b == b'"' || b == b'\\' || !(0x20..0x7f).contains(&b)) {
        return named;
    }
    let mut out = String::from("\"");
    for b in named.bytes() {
        match b {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            0x07 => out.push_str("\\a"),
            0x08 => out.push_str("\\b"),
            b'\t' => out.push_str("\\t"),
            b'\n' => out.push_str("\\n"),
            0x0b => out.push_str("\\v"),
            0x0c => out.push_str("\\f"),
            b'\r' => out.push_str("\\r"),
            b if !(0x20..0x7f).contains(&b) => out.push_str(&format!("\\{b:03o}")),
            b => out.push(b as char),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn git(dir: &Path, args: &[&str]) -> Vec<u8> {
        std::process::Command::new("git").args(args).current_dir(dir).env("LC_ALL", "C").output().unwrap().stdout
    }

    fn bytes_of(seen: Option<Seen>) -> Option<(Vec<u8>, bool)> {
        match seen {
            Some(Seen::File { bytes, exec }) => Some((bytes, exec)),
            _ => None,
        }
    }

    #[test]
    fn the_patch_is_the_one_git_writes_for_each_kind_of_new_file() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        let files: [(&str, &[u8]); 8] = [
            ("t.txt", b"one\ntwo\n"),
            ("n.txt", b"no end"),
            ("e.txt", b""),
            ("b.bin", b"a\0b"),
            ("x.sh", b"x\n"),
            ("caf\u{e9}", b"q\n"),
            ("with \"quote\" and \\ tab\t", b"q\n"),
            ("a b", b"q\n"),
        ];
        for (name, bytes) in files {
            std::fs::write(dir.path().join(name), bytes).unwrap();
        }
        std::fs::set_permissions(dir.path().join("x.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let top = OnThisSide { open: dir.path().to_path_buf(), walk: PathBuf::new() };
        for (name, _) in files {
            let (bytes, exec) = bytes_of(seen(&top, name)).unwrap();
            let blob = String::from_utf8(git(dir.path(), &["hash-object", "--", name])).unwrap();
            let patch = patch_of(name, &bytes, exec, Some(blob.trim()), 7);
            let theirs =
                git(dir.path(), &["-c", "core.quotepath=on", "diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", name]);
            assert_eq!(String::from_utf8_lossy(&patch), String::from_utf8_lossy(&theirs), "{name}");
        }
    }

    #[test]
    fn a_link_anywhere_on_the_way_reads_as_no_file_and_a_file_past_the_cap_is_never_read() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("a.txt"), "SECRET\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("a.txt"), dir.path().join("leaf")).unwrap();
        let top = OnThisSide { open: dir.path().to_path_buf(), walk: PathBuf::new() };
        for rel in ["linked/a.txt", "leaf", "../a.txt", "missing.txt"] {
            assert!(seen(&top, rel).is_none(), "{rel}");
        }
        std::fs::File::create(dir.path().join("huge")).unwrap().set_len(READ_MAX as u64 + 1).unwrap();
        assert!(matches!(seen(&top, "huge"), Some(Seen::TooLarge)));
    }

    #[test]
    fn the_walk_below_the_opened_folder_follows_no_link_and_takes_no_way_up() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("rootfs/repo")).unwrap();
        std::fs::write(dir.path().join("rootfs/repo/a.txt"), "inside\n").unwrap();
        std::os::unix::fs::symlink(dir.path().join("rootfs/repo"), dir.path().join("rootfs/linked")).unwrap();
        let under = |walk: &str| OnThisSide { open: dir.path().join("rootfs"), walk: PathBuf::from(walk) };
        assert!(seen(&under("/repo"), "a.txt").is_some());
        assert!(seen(&under("/linked"), "a.txt").is_none());
        assert!(seen(&under("/repo/.."), "repo/a.txt").is_none());
    }
}
