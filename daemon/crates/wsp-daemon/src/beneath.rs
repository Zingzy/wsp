// SPDX-License-Identifier: AGPL-3.0-only
//! A name under a folder this daemon holds open, opened one component at a time with no link followed at any of
//! them and no way up: what every read of bytes an agent can rearrange goes through, so a link a writer puts in
//! place of a folder or a file names nothing. openat rather than openat2, since this daemon runs on macOS too.

use std::fs::File;
use std::os::fd::OwnedFd;

use nix::errno::Errno;
use nix::fcntl::{openat, OFlag};
use nix::sys::stat::Mode;

/// A folder on the way: read, a folder, no link, and nothing left open across an exec.
pub(crate) fn dir_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

/// The folder holding `rel` under `at` and its last name, each folder on the way opened with no link followed.
/// None where a folder on the way is not there; refused where a name is empty, `.` or `..`, or a link stands on
/// the way.
pub(crate) fn parent_of<'a>(at: &OwnedFd, rel: &'a str) -> Result<Option<(OwnedFd, &'a str)>, String> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..") {
        return Err(format!("{rel} is not a name under the folder it is read from"));
    }
    let (leaf, folders) = parts.split_last().ok_or_else(|| "an empty name".to_owned())?;
    let mut at = at.try_clone().map_err(|e| e.to_string())?;
    for folder in folders {
        at = match openat(&at, *folder, dir_flags(), Mode::empty()) {
            Ok(next) => next,
            Err(Errno::ENOENT | Errno::ENOTDIR) => return Ok(None),
            Err(Errno::ELOOP) => return Err(format!("a link stands at {rel}")),
            Err(e) => return Err(format!("{rel}: {e}")),
        };
    }
    Ok(Some((at, leaf)))
}

/// A regular file, or None where nothing or a folder stands there. Opened without blocking, so a fifo left in
/// place of a file cannot hold the read.
pub(crate) fn file(at: &OwnedFd, rel: &str) -> Result<Option<File>, String> {
    let Some((parent, leaf)) = parent_of(at, rel)? else { return Ok(None) };
    let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
    let file = match openat(&parent, leaf, flags, Mode::empty()) {
        Ok(fd) => File::from(fd),
        Err(Errno::ENOENT) => return Ok(None),
        Err(Errno::ELOOP) => return Err(format!("a link stands at {rel}")),
        Err(e) => return Err(format!("{rel}: {e}")),
    };
    let kind = file.metadata().map_err(|e| format!("{rel}: {e}"))?.file_type();
    if kind.is_dir() {
        return Ok(None);
    }
    if !kind.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    Ok(Some(file))
}
