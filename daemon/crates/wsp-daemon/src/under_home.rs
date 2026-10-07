// SPDX-License-Identifier: AGPL-3.0-only
//! One path under a home removed through the home's own descriptor: walked one folder at a time with no link
//! followed, then removed on the descriptors the walk opened, since a workspace on a computer somebody owns may still
//! be writing in that home while a leave runs there.

use std::os::unix::ffi::OsStrExt as _;
use std::path::Path;

/// What one removal under the home did, which is what the leave's lines say.
pub(crate) enum Removed {
    Gone,
    /// Nothing of that name is there, which is most of the list on most computers, or the path is one the walk
    /// does not take, a `..` or a leading `.` in it: either way nothing goes and nothing is said of it.
    Absent,
    /// A folder on the way to it is a link, or is no folder at all: nothing was removed and the path is named as
    /// one that stayed.
    Linked,
    /// A folder holding something nested deeper than `EMPTY_DEPTH`: what lay above went, the folder stays and is
    /// named as one that stayed.
    TooDeep,
}

/// One path under the home, removed through the home's own descriptor: each folder on the way is opened with no
/// link followed, and the leaf is unlinked on the descriptor of the folder holding it. A workspace on a computer
/// somebody owns writes in that computer's home, so the shared `/root/.local/bin` can be a link it planted, and a
/// removal by name would follow it and take the box's own file of that name; here the walk stops instead.
pub(crate) fn remove_under_home(home: &Path, rel: &Path) -> Removed {
    let (parent, name) = match walk_under_home(home, rel) {
        Under::At(parent, name) => (parent, name),
        Under::Absent => return Removed::Absent,
        Under::Linked => return Removed::Linked,
    };
    remove_walked(&parent, &name)
}

/// The leaf the walk reached, removed on the descriptor of the folder holding it, and a folder emptied the same way
/// first: the workspace may still be writing in this home, so a name looked up again by path could be a link by now.
fn remove_walked(parent: &std::os::fd::OwnedFd, name: &std::ffi::OsStr) -> Removed {
    let Ok(meta) = nix::sys::stat::fstatat(parent, name, nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW) else {
        return Removed::Absent;
    };
    let directory = wsp_runtime::file_type::is_folder(meta.st_mode);
    let deep = directory && empty_folder(parent, name, 0);
    let flag = if directory { nix::unistd::UnlinkatFlags::RemoveDir } else { nix::unistd::UnlinkatFlags::NoRemoveDir };
    match nix::unistd::unlinkat(parent, name, flag) {
        Ok(()) => Removed::Gone,
        Err(_) if deep => Removed::TooDeep,
        Err(_) => Removed::Absent,
    }
}

/// How deep a folder of wsp's is emptied: a tree the workspace made deeper keeps what lies below and the folder
/// stays. The leave runs on a blocking thread of 256 KiB, which a recursion as deep as the workspace likes overflows,
/// aborting the root daemon mid-leave.
const EMPTY_DEPTH: usize = 64;

/// Everything inside one folder, each name unlinked on the folder's own descriptor. The folder is opened with no
/// link followed, and so is each folder in it, so a link put where a folder stood, before or during, goes as the
/// link it is and is never entered. What could not go stays, and the folder's own removal then fails. Answers whether
/// something in it lay deeper than `EMPTY_DEPTH`.
fn empty_folder(parent: &impl std::os::fd::AsFd, name: &std::ffi::OsStr, depth: usize) -> bool {
    use nix::fcntl::{AtFlags, OFlag};
    use nix::sys::stat::{fstatat, Mode};
    use nix::unistd::{unlinkat, UnlinkatFlags};
    if depth >= EMPTY_DEPTH {
        return true;
    }
    let flags = OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let Ok(mut folder) = nix::dir::Dir::openat(parent, name, flags, Mode::empty()) else { return false };
    let names: Vec<std::ffi::CString> = folder
        .iter()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_owned())
        .filter(|n| n.as_bytes() != b"." && n.as_bytes() != b"..")
        .collect();
    let mut deep = false;
    for name in names {
        let name = std::ffi::OsStr::from_bytes(name.as_bytes());
        let Ok(meta) = fstatat(&folder, name, AtFlags::AT_SYMLINK_NOFOLLOW) else { continue };
        if wsp_runtime::file_type::is_folder(meta.st_mode) {
            deep |= empty_folder(&folder, name, depth + 1);
            let _ = unlinkat(&folder, name, UnlinkatFlags::RemoveDir);
        } else {
            let _ = unlinkat(&folder, name, UnlinkatFlags::NoRemoveDir);
        }
    }
    deep
}

/// Where a path under the home is, opened one folder at a time.
enum Under {
    /// The folder holding it, and its name inside that folder.
    At(std::os::fd::OwnedFd, std::ffi::OsString),
    /// Nothing of that name is there, which is most of the list on most computers, or the path is not one this
    /// walk takes at all: either way nothing goes and nothing is said of it.
    Absent,
    /// A folder on the way to it is a link, or is no folder at all: nothing was removed and the path is named as
    /// one that stayed.
    Linked,
}

/// The walk itself: the home is opened as it stands, since it is what the daemon was pointed at, and every folder
/// under it with O_NOFOLLOW, so a link left where a folder was ends the walk rather than pointing what follows at
/// whatever it names. A path that is not plainly under the home, one naming `..` or opening with `.` among them,
/// is no path of wsp's and reads as absent rather than as one a link kept: the sentence for a path left standing
/// names a link, and such a path holds none.
fn walk_under_home(home: &Path, rel: &Path) -> Under {
    use std::path::Component;
    let mut parts = Vec::new();
    for part in rel.components() {
        match part {
            Component::Normal(name) => parts.push(name),
            _ => return Under::Absent,
        }
    }
    let Some((leaf, folders)) = parts.split_last() else { return Under::Absent };
    let flags = nix::fcntl::OFlag::O_DIRECTORY | nix::fcntl::OFlag::O_CLOEXEC;
    let Ok(mut at) = nix::fcntl::open(home, flags, nix::sys::stat::Mode::empty()) else { return Under::Absent };
    for folder in folders {
        at = match nix::fcntl::openat(&at, *folder, flags | nix::fcntl::OFlag::O_NOFOLLOW, nix::sys::stat::Mode::empty()) {
            Ok(next) => next,
            Err(nix::errno::Errno::ENOENT) => return Under::Absent,
            Err(_) => return Under::Linked,
        };
    }
    Under::At(at, leaf.to_os_string())
}

/// The folders wsp's own files left empty, taken from the file's own upwards, each through the same walk and
/// removed on its parent's descriptor. Never the first folder under the home: ~/.claude-cfg and ~/.codex are the
/// agents' own to make and to keep, whatever wsp put inside them.
pub(crate) fn prune_empty(home: &Path, from: &Path) {
    let mut at = from;
    while at != home && at.starts_with(home) && at.parent() != Some(home) {
        let Ok(rel) = at.strip_prefix(home) else { return };
        let Under::At(parent, name) = walk_under_home(home, rel) else { return };
        if nix::unistd::unlinkat(&parent, name.as_os_str(), nix::unistd::UnlinkatFlags::RemoveDir).is_err() {
            return;
        }
        match at.parent() {
            Some(parent) => at = parent,
            None => return,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A socket's type bits hold a folder's among them, so a folder of wsp's holding the door a daemon bound read its
    /// socket as a folder, could not take it, and stayed whole on a computer that left.
    #[test]
    fn a_folder_holding_a_socket_goes_whole() {
        let home = tempfile::tempdir().unwrap();
        let wsp = home.path().join(".wsp");
        std::fs::create_dir_all(wsp.join("bin")).unwrap();
        std::fs::write(wsp.join("bin/wsp"), "#!/bin/sh\n").unwrap();
        let _door = std::os::unix::net::UnixListener::bind(wsp.join("daemon.sock")).unwrap();
        assert!(matches!(remove_under_home(home.path(), Path::new(".wsp")), Removed::Gone));
        assert!(!wsp.exists());
    }

    /// A path this walk will not take is no path of wsp's, and the leave says nothing of it: the sentence for a
    /// path left standing names a link, and a path reaching out of the home holds none.
    #[test]
    fn a_path_that_is_not_plainly_under_the_home_is_absent_and_nothing_is_said_of_it() {
        let home = tempfile::tempdir().unwrap();
        // A folder beside the home, so the path below would answer with a real file of somebody's if the walk
        // took it: both sit under the same temporary folder.
        let beside = tempfile::tempdir().unwrap();
        std::fs::write(beside.path().join("keep"), "not wsp's\n").unwrap();
        let out = Path::new("..").join(beside.path().file_name().unwrap()).join("keep");

        assert!(matches!(remove_under_home(home.path(), &out), Removed::Absent));
        assert!(matches!(remove_under_home(home.path(), Path::new("./settings.json")), Removed::Absent));
        assert!(beside.path().join("keep").exists(), "a path out of the home was taken");
    }

    #[test]
    fn a_folder_swapped_for_a_link_after_the_walk_is_not_followed_by_the_removal() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("wsp")).unwrap();
        std::fs::write(outside.path().join("wsp/keep"), "the computer's own\n").unwrap();
        std::fs::create_dir_all(home.path().join(".local/share/wsp/bin")).unwrap();
        std::fs::write(home.path().join(".local/share/wsp/bin/tool"), "wsp's\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join(".local/share/wsp/out")).unwrap();
        let rel = Path::new(".local/share/wsp");
        let Under::At(parent, name) = walk_under_home(home.path(), rel) else { panic!("the walk stopped") };
        // The workspace still writes in this home: between the walk and the removal it puts a link where a folder on
        // the way stood, aimed at a folder holding a file of the same name.
        std::fs::rename(home.path().join(".local/share"), home.path().join(".local/aside")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join(".local/share")).unwrap();

        let removed = remove_walked(&parent, &name);

        assert_eq!(std::fs::read_to_string(outside.path().join("wsp/keep")).unwrap(), "the computer's own\n");
        assert!(matches!(removed, Removed::Gone));
        assert!(!home.path().join(".local/aside/wsp").exists(), "the folder the walk opened is still there");
    }

    #[test]
    fn a_folder_swapped_for_a_link_while_it_is_emptied_is_not_entered() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("wsp/sub")).unwrap();
        for keep in ["keep", "wsp/keep", "wsp/sub/keep"] {
            std::fs::write(outside.path().join(keep), "the computer's own\n").unwrap();
        }
        // What a swap made during the emptying leaves: the name the emptying is about to open is a link by now.
        std::os::unix::fs::symlink(outside.path(), home.path().join("wsp")).unwrap();
        let at = nix::fcntl::open(home.path(), nix::fcntl::OFlag::O_DIRECTORY, nix::sys::stat::Mode::empty()).unwrap();

        empty_folder(&at, std::ffi::OsStr::new("wsp"), 0);

        for keep in ["keep", "wsp/keep", "wsp/sub/keep"] {
            assert_eq!(std::fs::read_to_string(outside.path().join(keep)).unwrap(), "the computer's own\n", "{keep}");
        }
    }

    /// `n` folders, each named `d` and each inside the one before, made under `top` one descriptor at a time, since
    /// a path that deep is past what a lookup by name takes.
    pub(crate) fn nest(top: &Path, n: usize) {
        use nix::fcntl::{openat, OFlag};
        use nix::sys::stat::{mkdirat, Mode};
        std::fs::create_dir_all(top).unwrap();
        let mut at = nix::fcntl::open(top, OFlag::O_DIRECTORY, Mode::empty()).unwrap();
        for _ in 0..n {
            mkdirat(&at, "d", Mode::from_bits_truncate(0o700)).unwrap();
            at = openat(&at, "d", OFlag::O_DIRECTORY, Mode::empty()).unwrap();
        }
    }

    /// Takes a nest down one level at a time from its top, so the test's own clean-up never recurses as deep as it.
    fn unnest(top: &Path) {
        use nix::fcntl::{renameat, OFlag};
        use nix::sys::stat::Mode;
        use nix::unistd::{unlinkat, UnlinkatFlags};
        let at = nix::fcntl::open(top, OFlag::O_DIRECTORY, Mode::empty()).unwrap();
        while renameat(&at, "d/d", &at, "x").is_ok() {
            unlinkat(&at, "d", UnlinkatFlags::RemoveDir).unwrap();
            renameat(&at, "x", &at, "d").unwrap();
        }
    }

    #[test]
    fn a_folder_is_emptied_sixty_four_folders_deep_and_one_holding_more_stays() {
        let home = tempfile::tempdir().unwrap();
        nest(&home.path().join("wsp"), 64);
        assert!(matches!(remove_under_home(home.path(), Path::new("wsp")), Removed::Gone));
        assert!(!home.path().join("wsp").exists());

        nest(&home.path().join("wsp"), 65);
        assert!(matches!(remove_under_home(home.path(), Path::new("wsp")), Removed::TooDeep));
        assert!(home.path().join("wsp").exists());
    }

    /// The leave runs on one of the daemon's blocking threads, whose stack is `BLOCKING_STACK_BYTES` in the bin: a
    /// nest a workspace planted that deep would abort the root daemon mid-leave if the emptying followed it down.
    #[test]
    fn a_nest_thousands_deep_never_overflows_the_stack_a_leave_runs_on() {
        let home = tempfile::tempdir().unwrap();
        let top = home.path().join("wsp");
        nest(&top, 5000);
        let leave = home.path().to_path_buf();
        let removed = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || matches!(remove_under_home(&leave, Path::new("wsp")), Removed::TooDeep))
            .unwrap()
            .join();
        unnest(&top);
        assert!(removed.unwrap(), "a nest 5000 deep was not named as one that stayed");
    }
}
