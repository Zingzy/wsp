// SPDX-License-Identifier: AGPL-3.0-only
//! How a workspace on a computer somebody owns gets the project's files: one copy of a checkout per workspace,
//! made once at the create and mounted inside it, never an overlay over a checkout that can change under a
//! workspace that is running. Three ways of making that copy, one module each, and one picker that asks the disk
//! what it can do rather than reading a filesystem's name: a btrfs subvolume is snapshotted, a disk that clones
//! blocks gets a reflink copy, and everywhere else every byte is written and the time it took is said out loud.
//! The walk from one tree to another is written once here and handed the per-file operation each variant brings.

use std::fs;
use std::io;
use std::path::Path;

use wsp_frames::CopyWord;

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
#[cfg(target_os = "linux")]
use std::path::PathBuf;

/// One way of making a workspace's copy of a checkout. `copy` is handed a `to` that does not exist and leaves
/// nothing of it behind where it fails; `remove` takes it away again, however it was made.
pub trait Copier: Send + Sync {
    fn word(&self) -> CopyWord;
    fn copy(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove(&self, to: &Path) -> io::Result<()>;
}

/// The copier for a word already recorded, so a remove takes a copy away the way it was made without asking the
/// disk again.
pub fn copier_of(word: CopyWord) -> Box<dyn Copier> {
    match word {
        #[cfg(target_os = "linux")]
        CopyWord::Reflink => Box::new(crate::copy_reflink::Reflink),
        #[cfg(target_os = "linux")]
        CopyWord::Snapshot => Box::new(crate::copy_snapshot::BtrfsSnapshot),
        #[cfg(target_os = "linux")]
        CopyWord::Plain => Box::new(crate::copy_plain::Plain),
        #[cfg(not(target_os = "linux"))]
        _ => Box::new(NoCopier),
    }
}

/// Which way this disk makes the copy, checked rather than read off a filesystem's name: the checkout and the
/// copies directory on one device and the checkout a btrfs subvolume is the snapshot, one device and a clone that
/// the kernel takes under the copies directory is the reflink, anything else writes every byte.
pub fn copier_for(from: &Path, copies: &Path) -> io::Result<Box<dyn Copier>> {
    let meta = fs::metadata(from).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", from.display())))?;
    if !meta.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not a folder on this computer", from.display())));
    }
    #[cfg(target_os = "linux")]
    {
        fs::create_dir_all(copies).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", copies.display())))?;
        let one_device = fs::metadata(copies)?.dev() == meta.dev();
        if one_device && crate::copy_snapshot::is_subvolume(from) {
            return Ok(Box::new(crate::copy_snapshot::BtrfsSnapshot));
        }
        if one_device && clones_under(copies) {
            return Ok(Box::new(crate::copy_reflink::Reflink));
        }
        Ok(Box::new(crate::copy_plain::Plain))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = copies;
        Err(io::Error::new(io::ErrorKind::Unsupported, format!("{}: a workspace's copy is made on Linux alone", from.display())))
    }
}

/// The word alone, for the doctor's reading and the row a person sees: a clone probe under the root's own scratch
/// directory, never a checkout. A root this cannot write under reads plain, which is what a copy there would be.
pub fn copies_word(root: &Path) -> CopyWord {
    #[cfg(target_os = "linux")]
    {
        let check = root.join("check");
        if fs::create_dir_all(&check).is_err() {
            return CopyWord::Plain;
        }
        let word = if clones_under(&check) { CopyWord::Reflink } else { CopyWord::Plain };
        let _ = fs::remove_dir(&check);
        word
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root;
        CopyWord::Plain
    }
}

/// Whether the kernel shares blocks between two files in this directory: a byte written, cloned, and both taken
/// away again. The one probe the picker and the doctor's word are both read from.
#[cfg(target_os = "linux")]
fn clones_under(dir: &Path) -> bool {
    let source = dir.join(format!(".clone-probe-{}", std::process::id()));
    let clone = source.with_extension("clone");
    let took = fs::write(&source, b"w").is_ok() && crate::copy_reflink::clone_file(&source, &clone).is_ok();
    let _ = fs::remove_file(&source);
    let _ = fs::remove_file(&clone);
    took
}

/// The bytes of one regular file from a source that exists into a target that does not: what the two copying
/// variants differ by, and the whole of what they differ by.
#[cfg(target_os = "linux")]
pub type CopyFile = fn(&Path, &Path) -> io::Result<()>;

/// `from` walked into `to`, which must not exist: directories made and then given their modes, symlinks written
/// as symlinks, every regular file handed to `file`, and each file's mode, owner, times and extended attributes
/// kept. A file the checkout hard linked under more than one name is copied once and linked under the rest, keyed
/// by device and inode as the layer walk keys them, so a package tree of thousands of links costs its bytes once.
/// Sockets are skipped and device nodes refused by name. Nothing of `to` is left where any of it fails.
#[cfg(target_os = "linux")]
pub fn copy_tree(from: &Path, to: &Path, file: CopyFile) -> io::Result<()> {
    let made = (|| -> io::Result<()> {
        fs::create_dir(to)?;
        walk(from, to, file, &mut HashMap::new())?;
        same_as(from, to)
    })();
    if made.is_err() {
        let _ = remove_tree(to);
    }
    made
}

/// The tree taken away, gone already counting as taken away. Its folders are opened up first: a checkout may
/// hold a folder its owner wrote at mode 0o500, and the copy of one is the daemon's to remove whether or not the
/// login it runs as could write inside it.
#[cfg(target_os = "linux")]
pub fn remove_tree(to: &Path) -> io::Result<()> {
    let _ = open_up(to);
    match fs::remove_dir_all(to) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io::Error::new(e.kind(), format!("{}: {e}", to.display()))),
    }
}

/// Every folder under this one given write and search for its owner, a link never followed and every error
/// ignored: this is the last thing that happens to them.
#[cfg(target_os = "linux")]
fn open_up(at: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(at)?;
    if !meta.is_dir() {
        return Ok(());
    }
    let _ = fs::set_permissions(at, std::os::unix::fs::PermissionsExt::from_mode(meta.mode() & 0o7777 | 0o700));
    for entry in fs::read_dir(at)? {
        let _ = open_up(&entry?.path());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn walk(from: &Path, to: &Path, file: CopyFile, linked: &mut HashMap<(u64, u64), PathBuf>) -> io::Result<()> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(from)?.collect::<io::Result<_>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let source = entry.path();
        let target = to.join(entry.file_name());
        let meta = fs::symlink_metadata(&source)?;
        let kind = meta.file_type();
        if kind.is_socket() {
            continue;
        }
        if kind.is_char_device() || kind.is_block_device() || kind.is_fifo() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is a device, which a project's copy does not carry", source.display()),
            ));
        }
        if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(&source)?, &target)?;
            own_as(&meta, &target)?;
            timed_as(&meta, &target)?;
            continue;
        }
        if kind.is_dir() {
            fs::create_dir(&target)?;
            walk(&source, &target, file, linked)?;
            same_as(&source, &target)?;
            continue;
        }
        if let Some(key) = crate::store::shared_inode(&meta) {
            if let Some(first) = linked.get(&key) {
                fs::hard_link(first, &target)?;
                continue;
            }
            linked.insert(key, target.clone());
        }
        file(&source, &target)?;
        same_as(&source, &target)?;
    }
    Ok(())
}

/// The mode, the owner, the times and the extended attributes of the source on the target. The mode last of the
/// four on a directory would be too late for its children, so a directory is given all four once its children are
/// written: a checkout holding a read-only folder is copied whole and is read-only again at the end of it.
#[cfg(target_os = "linux")]
fn same_as(source: &Path, target: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(source)?;
    for key in xattr::list(source)? {
        let Some(value) = xattr::get(source, &key)? else { continue };
        // A checkout carries attributes this daemon has no business refusing a copy over: a security label the
        // kernel writes back itself, or a namespace only the box's own login may write.
        let _ = xattr::set(target, &key, &value);
    }
    fs::set_permissions(target, std::os::unix::fs::PermissionsExt::from_mode(meta.mode() & 0o7777))?;
    own_as(&meta, target)?;
    timed_as(&meta, target)
}

/// The source's times on the target, to the nanosecond and without following a link: a checkout's own dates are
/// what a build system reads to decide what it need not do again, so a copy that dated every file now would cost
/// the workspace a full rebuild.
#[cfg(target_os = "linux")]
fn timed_as(meta: &fs::Metadata, target: &Path) -> io::Result<()> {
    let name = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(target.as_os_str()))
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("{}: {e}", target.display())))?;
    let times = [
        nix::libc::timespec { tv_sec: meta.atime(), tv_nsec: meta.atime_nsec() },
        nix::libc::timespec { tv_sec: meta.mtime(), tv_nsec: meta.mtime_nsec() },
    ];
    // SAFETY: the name is a nul-terminated path and the array is the two times the call reads.
    let set = unsafe { nix::libc::utimensat(nix::libc::AT_FDCWD, name.as_ptr(), times.as_ptr(), nix::libc::AT_SYMLINK_NOFOLLOW) };
    if set != 0 {
        let e = io::Error::last_os_error();
        return Err(io::Error::new(e.kind(), format!("{}: {e}", target.display())));
    }
    Ok(())
}

/// The source's owner on the target, the link itself rather than what it points at. A daemon that is not root
/// cannot hand a file to another login, and a copy it made is its own; the copy is not refused over it.
#[cfg(target_os = "linux")]
fn own_as(meta: &fs::Metadata, target: &Path) -> io::Result<()> {
    let _ = std::os::unix::fs::lchown(target, Some(meta.uid()), Some(meta.gid()));
    Ok(())
}

/// What a computer that runs no workspaces answers the picker with, so the crate builds where the kernel work
/// does not.
#[cfg(not(target_os = "linux"))]
struct NoCopier;

#[cfg(not(target_os = "linux"))]
impl Copier for NoCopier {
    fn word(&self) -> CopyWord {
        CopyWord::Plain
    }
    fn copy(&self, from: &Path, _to: &Path) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, format!("{}: a workspace's copy is made on Linux alone", from.display())))
    }
    fn remove(&self, _to: &Path) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_word_for_this_filesystem_is_one_of_the_two_a_probe_can_answer_and_the_probe_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let word = copies_word(&root);
        assert!(matches!(word, CopyWord::Plain | CopyWord::Reflink), "{word:?}");
        // The same answer twice, and no probe file left under the root for the next reader to trip on.
        assert_eq!(copies_word(&root), word);
        let left: Vec<_> = std::fs::read_dir(&root).map(|d| d.flatten().map(|e| e.file_name()).collect()).unwrap_or_default();
        assert!(left.is_empty(), "{left:?}");
        // A root nothing may be written under is the plain copy rather than a panic.
        assert_eq!(copies_word(std::path::Path::new("/proc/one/two")), CopyWord::Plain);
    }

    #[test]
    fn the_picker_refuses_a_checkout_that_is_a_file_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("checkout");
        std::fs::write(&file, b"not a folder").unwrap();
        let refused = copier_for(&file, &dir.path().join("copies")).map(|_| ()).unwrap_err().to_string();
        assert!(refused.contains(&file.display().to_string()) && refused.contains("is not a folder"), "{refused}");
        let gone = dir.path().join("no-such-checkout");
        let missing = copier_for(&gone, &dir.path().join("copies")).map(|_| ()).unwrap_err().to_string();
        assert!(missing.contains(&gone.display().to_string()), "{missing}");
    }
}
