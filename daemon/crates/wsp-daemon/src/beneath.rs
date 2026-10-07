// SPDX-License-Identifier: AGPL-3.0-only
//! A name under a folder this daemon holds open, opened one component at a time with no link followed at any of
//! them and no way up: what every read of bytes an agent can rearrange goes through, so a link a writer puts in
//! place of a folder or a file names nothing. openat rather than openat2, since this daemon runs on macOS too.

use std::fs::File;
use std::io::{self, Read as _};
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{openat, OFlag};
use nix::sys::stat::{FileStat, Mode};

/// A folder on the way: read, a folder, no link, and nothing left open across an exec.
pub(crate) fn dir_flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC
}

/// The walk's names, then rel's, as one name under the held folder; None where the walk takes a way up.
pub(crate) fn joined(walk: &Path, rel: &str) -> Option<String> {
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

/// How many of root's own links one walk from the top follows before it gives up, as the kernel's own limit on a path
/// does.
const LINKS_FOLLOWED: usize = 8;

/// The most a file of the daemon's own is read to: a token, a key or the place file is a few hundred bytes.
const KEPT_CAP: u64 = 1024 * 1024;

/// The folder holding `path`'s last name, held open, and that name, walked from `/` one name at a time with no link
/// followed: what root goes through for a file under a home whose login can put a link, or a folder of its own,
/// where wsp's folder was. A link root owns on the way is the system's own (a /home that is a link into /var), which
/// no login can make, and the walk starts again at where it points; any other link is refused. With `make` a missing
/// folder is made in the folder held above it; without, a missing one is NotFound.
pub(crate) fn from_top(path: &Path, make: bool) -> io::Result<(OwnedFd, String)> {
    folder_of(path, path, LINKS_FOLLOWED, make)
}

/// A file of this daemon's own read whole, or None where nothing stands there: the token, the place key and the
/// place file, which sit in a home's `.wsp`. That home is its login's, who can move `.wsp` aside and put a folder of
/// their own at the name, so the file is read only where the folder holding it and the file itself belong to this
/// daemon or root and no other login can write either. A folder anyone may write in counts only with its sticky
/// bit, which keeps each name in it its owner's.
pub(crate) fn kept_text(path: &Path) -> io::Result<Option<String>> {
    use nix::sys::stat::{fstat, SFlag};
    let at = std::path::absolute(path)?;
    let (folder, name) = match from_top(&at, false) {
        Ok(found) => found,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let held = fstat(&folder)?;
    if !kept(&held, held.st_mode & 0o1000 != 0) {
        let folder = at.parent().unwrap_or(&at).display();
        return Err(io::Error::other(format!("{folder} is not this daemon's folder, so {} is not read", at.display())));
    }
    let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
    let file = match openat(&folder, name.as_str(), flags, Mode::empty()) {
        Ok(fd) => File::from(fd),
        Err(Errno::ENOENT) => return Ok(None),
        Err(Errno::ELOOP) => return Err(io::Error::other(format!("a link stands at {}", at.display()))),
        Err(e) => return Err(e.into()),
    };
    let stat = fstat(&file)?;
    if SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT != SFlag::S_IFREG || !kept(&stat, false) {
        return Err(io::Error::other(format!("{} is not this daemon's file", at.display())));
    }
    let mut text = String::new();
    file.take(KEPT_CAP).read_to_string(&mut text)?;
    Ok(Some(text))
}

/// Owned by this daemon or root and written by no other login: its group may write only where the group is this
/// daemon's own, and anyone only where `sticky` keeps each name its owner's.
fn kept(stat: &FileStat, sticky: bool) -> bool {
    let owner = stat.st_uid == 0 || stat.st_uid == nix::unistd::geteuid().as_raw();
    let group = stat.st_mode & 0o020 == 0 || stat.st_gid == nix::unistd::getegid().as_raw();
    owner && (sticky || (group && stat.st_mode & 0o002 == 0))
}

/// The folder holding `at`'s last name, held open, and that name: `asked` is the path the caller named, for the words.
fn folder_of(at: &Path, asked: &Path, links: usize, make: bool) -> io::Result<(OwnedFd, String)> {
    use nix::fcntl::{readlinkat, AtFlags};
    use nix::sys::stat::{fstatat, mkdirat, SFlag};
    let rel = at
        .strip_prefix("/")
        .ok()
        .and_then(Path::to_str)
        .ok_or_else(|| io::Error::other(format!("{} is not an absolute path", asked.display())))?;
    let parts: Vec<&str> = rel.split('/').filter(|part| !part.is_empty()).collect();
    let (name, folders) = parts.split_last().ok_or_else(|| io::Error::other(format!("{} names no file", asked.display())))?;
    let linked = || io::Error::other(format!("a link stands on the way to {}", asked.display()));
    let mut walked = PathBuf::from("/");
    let mut folder = nix::fcntl::open("/", dir_flags(), Mode::empty())?;
    for (at_part, part) in folders.iter().enumerate() {
        let next = match openat(&folder, *part, dir_flags(), Mode::empty()) {
            Err(Errno::ENOENT) if make => {
                mkdirat(&folder, *part, Mode::from_bits_truncate(0o777))?;
                openat(&folder, *part, dir_flags(), Mode::empty())
            }
            opened => opened,
        };
        folder = match next {
            Ok(next) => next,
            Err(Errno::ELOOP | Errno::ENOTDIR) => {
                let held = fstatat(&folder, *part, AtFlags::AT_SYMLINK_NOFOLLOW)?;
                let is_link = SFlag::from_bits_truncate(held.st_mode) & SFlag::S_IFMT == SFlag::S_IFLNK;
                if !is_link || held.st_uid != 0 || links == 0 {
                    return Err(linked());
                }
                let target = readlinkat(&folder, *part)?;
                let mut rest = walked.join(target);
                for after in &folders[at_part + 1..] {
                    rest.push(after);
                }
                rest.push(name);
                return folder_of(&rest, asked, links - 1, make);
            }
            Err(e) => return Err(e.into()),
        };
        walked.push(part);
    }
    Ok((folder, (*name).to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A folder of the daemon's own, as `.wsp` stands on a box: the file in it is read, and a missing file or a
    /// missing folder is none.
    #[test]
    fn a_file_in_a_folder_of_the_daemons_own_is_read_and_a_missing_one_is_none() {
        let home = tempfile::tempdir().unwrap();
        let wsp = home.path().join(".wsp");
        std::fs::create_dir(&wsp).unwrap();
        mode(&wsp, 0o700);
        std::fs::write(wsp.join("daemon-token"), "t\n").unwrap();
        assert_eq!(kept_text(&wsp.join("daemon-token")).unwrap().as_deref(), Some("t\n"));
        assert_eq!(kept_text(&wsp.join("gone")).unwrap(), None);
        assert_eq!(kept_text(&home.path().join("none").join("daemon-token")).unwrap(), None);
    }

    /// Where another login can write the folder or the file, what it holds may be theirs, so it is never read; a folder
    /// whose sticky bit keeps each name its owner's, as /tmp's does, still is.
    #[test]
    fn a_folder_or_a_file_another_login_may_write_is_refused_and_a_sticky_folder_is_read() {
        let home = tempfile::tempdir().unwrap();
        let at = home.path().join("shared");
        std::fs::create_dir(&at).unwrap();
        std::fs::write(at.join("daemon-token"), "t\n").unwrap();
        mode(&at, 0o777);
        let refused = kept_text(&at.join("daemon-token")).unwrap_err().to_string();
        assert!(refused.contains("is not this daemon's folder"), "{refused}");
        mode(&at, 0o1777);
        assert_eq!(kept_text(&at.join("daemon-token")).unwrap().as_deref(), Some("t\n"));
        mode(&at, 0o700);
        mode(&at.join("daemon-token"), 0o602);
        assert!(kept_text(&at.join("daemon-token")).unwrap_err().to_string().contains("is not this daemon's file"));
        mode(&at.join("daemon-token"), 0o600);
        nix::unistd::mkfifo(&at.join("fifo"), Mode::from_bits_truncate(0o600)).unwrap();
        assert!(kept_text(&at.join("fifo")).is_err(), "a fifo is no file and never holds the read");
    }

    /// The login owns the home, so it can put a link at `.wsp` naming a folder of its own: the walk follows no link
    /// but root's, and run as root the planted one is nobody's.
    #[test]
    fn a_link_put_where_the_folder_was_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let theirs = home.path().join("theirs");
        std::fs::create_dir(&theirs).unwrap();
        std::fs::write(theirs.join("daemon-token"), "planted\n").unwrap();
        std::os::unix::fs::symlink(&theirs, home.path().join(".wsp")).unwrap();
        if nix::unistd::geteuid().is_root() {
            std::os::unix::fs::lchown(home.path().join(".wsp"), Some(65534), Some(65534)).unwrap();
        }
        let refused = kept_text(&home.path().join(".wsp").join("daemon-token")).unwrap_err().to_string();
        assert!(refused.contains("a link stands on the way"), "{refused}");
    }

    /// The reviewer's case: the login moves root's `.wsp` aside and makes a folder of its own at the name, holding a
    /// token it wrote. That folder is the login's, so nothing in it is read. Only root can stand for another login.
    #[test]
    fn a_folder_another_login_made_at_the_name_is_refused() {
        if !nix::unistd::geteuid().is_root() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let wsp = home.path().join(".wsp");
        std::fs::create_dir(&wsp).unwrap();
        std::fs::write(wsp.join("daemon-token"), "planted\n").unwrap();
        std::os::unix::fs::chown(&wsp, Some(65534), Some(65534)).unwrap();
        let refused = kept_text(&wsp.join("daemon-token")).unwrap_err().to_string();
        assert!(refused.contains("is not this daemon's folder"), "{refused}");
        std::os::unix::fs::chown(&wsp, Some(0), Some(0)).unwrap();
        std::os::unix::fs::chown(wsp.join("daemon-token"), Some(65534), Some(65534)).unwrap();
        assert!(kept_text(&wsp.join("daemon-token")).unwrap_err().to_string().contains("is not this daemon's file"));
    }
}
