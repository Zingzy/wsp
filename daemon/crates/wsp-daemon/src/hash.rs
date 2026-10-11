// SPDX-License-Identifier: AGPL-3.0-only
//! The files a slate's command names inside its folder, hashed for the host: an Always pins the script the person
//! read, so an edit to it asks again. A path on this computer may pass links, as the command that runs it does, and
//! counts where it lands; a path in a workspace is read under its root with no link followed, and anything there the
//! walk cannot read as a file or nothing (a link, a fifo, a way up) refuses the whole ask, since the host cannot pin
//! what the command would run through it.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use wsp_frames::{numbers, DaemonErrorCode, FsHashReply};

use crate::fs::blocking;
use crate::paths::OpError;
use crate::Ctx;

/// The sha256 of a regular file of at most the cap, judged on the handle it was opened as.
fn digest(file: File) -> Option<String> {
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > numbers::FS_HASH_CAP_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(numbers::FS_HASH_CAP_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > numbers::FS_HASH_CAP_BYTES {
        return None;
    }
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

/// A path's place under the folder, or None where it is the folder itself or outside it.
fn under(at: &Path, top: &Path) -> Option<String> {
    at.strip_prefix(top).ok().and_then(Path::to_str).filter(|rel| !rel.is_empty()).map(str::to_owned)
}

/// The paths a frame names on this computer, each where it lands once every link is followed.
pub(crate) fn hashed_here(root: &str, paths: &[String]) -> Result<FsHashReply, OpError> {
    let top = std::fs::canonicalize(root).map_err(|_| OpError::coded(DaemonErrorCode::NotFound, format!("{root} does not exist")))?;
    let mut files = BTreeMap::new();
    for word in paths {
        if files.len() >= numbers::FS_HASH_FILES_MAX {
            break;
        }
        let Ok(at) = std::fs::canonicalize(Path::new(root).join(word)) else { continue };
        let Some(rel) = under(&at, &top) else { continue };
        if files.contains_key(&rel) {
            continue;
        }
        let Ok(file) = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC).open(&at) else { continue };
        if let Some(sum) = digest(file) {
            files.insert(rel, sum);
        }
    }
    Ok(FsHashReply { files })
}

/// A whole path's names as written, or None where one of them is a way up, which the walk below never takes.
fn names_of(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::from("/");
    for part in path.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// The paths a frame names inside a workspace whose root is `rootfs` on this computer, each name opened with no link
/// followed. Workspaces run on Linux alone; its test runs everywhere.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn hashed_beneath(rootfs: &Path, root: &str, paths: &[String]) -> Result<FsHashReply, OpError> {
    use nix::fcntl::open;
    use nix::sys::stat::Mode;

    let refused = |why: String| OpError::coded(DaemonErrorCode::NotAFile, why);
    let held = open(rootfs, crate::beneath::dir_flags(), Mode::empty()).map_err(|e| OpError::plain(e.to_string()))?;
    let top = names_of(Path::new(root)).ok_or_else(|| refused(format!("{root} takes a way up")))?;
    let mut files = BTreeMap::new();
    for word in paths {
        if files.len() >= numbers::FS_HASH_FILES_MAX {
            break;
        }
        let Some(at) = names_of(&Path::new(root).join(word)) else { return Err(refused(format!("{word} takes a way up"))) };
        let Some(rel) = under(&at, &top) else { continue };
        if files.contains_key(&rel) {
            continue;
        }
        let inside = at.to_str().unwrap_or_default().trim_start_matches('/').to_owned();
        match crate::beneath::file(&held, &inside) {
            Ok(Some(file)) => {
                if let Some(sum) = digest(file) {
                    files.insert(rel, sum);
                }
            }
            Ok(None) => {}
            Err(why) => return Err(refused(why)),
        }
    }
    Ok(FsHashReply { files })
}

/// The hashes a frame asks for: on this computer, or inside the workspace it names.
pub(crate) async fn hash_of(ctx: &Ctx, machine: Option<&str>, root: String, paths: Vec<String>) -> Result<FsHashReply, OpError> {
    if !Path::new(&root).is_absolute() {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, format!("{root} is not a whole path")));
    }
    if paths.len() > numbers::FS_HASH_PATHS_MAX {
        return Err(OpError::coded(
            DaemonErrorCode::BadRequest,
            format!("{} paths; one fs.hash takes at most {}", paths.len(), numbers::FS_HASH_PATHS_MAX),
        ));
    }
    match machine {
        None => blocking(move || hashed_here(&root, &paths)).await,
        Some(machine) => inside(ctx, machine, root, paths).await,
    }
}

#[cfg(target_os = "linux")]
async fn inside(ctx: &Ctx, machine: &str, root: String, paths: Vec<String>) -> Result<FsHashReply, OpError> {
    let rootfs = crate::workspace::workspaces_of(ctx, machine)?.rootfs_of_running(machine).map_err(crate::ops::from_runtime)?;
    blocking(move || hashed_beneath(&rootfs, &root, &paths)).await
}

#[cfg(not(target_os = "linux"))]
async fn inside(_ctx: &Ctx, machine: &str, _root: String, _paths: Vec<String>) -> Result<FsHashReply, OpError> {
    Err(crate::workspace::no_such_workspace(machine))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUM_ONE: &str = "046076f59b3d9fe61bc5261e95b7e9e371634206007c3a1143f9eb6f3c8c0f85";

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| (*w).to_owned()).collect()
    }

    #[test]
    fn a_workspace_file_is_hashed_under_its_root_and_a_link_inside_refuses_the_ask() {
        let rootfs = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(rootfs.path().join("root/acme/bin")).unwrap();
        std::fs::write(rootfs.path().join("root/acme/stats.py"), "print('one')\n").unwrap();
        std::fs::write(rootfs.path().join("root/acme/bin/run.sh"), "echo one\n").unwrap();
        std::fs::write(outside.path().join("key"), "secret").unwrap();
        let hash = |list: &[&str]| hashed_beneath(rootfs.path(), "/root/acme", &words(list));

        let read = hash(&["stats.py", "/root/acme/bin/run.sh", "/", "0.5", "/proc/loadavg", "bin"]).unwrap();
        assert_eq!(read.files.keys().collect::<Vec<_>>(), ["bin/run.sh", "stats.py"]);
        assert_eq!(read.files["stats.py"], SUM_ONE);

        std::os::unix::fs::symlink(outside.path().join("key"), rootfs.path().join("root/acme/key.py")).unwrap();
        assert_eq!(hash(&["key.py"]).unwrap_err().code, Some(DaemonErrorCode::NotAFile));
        assert_eq!(hash(&["../acme/stats.py"]).unwrap_err().code, Some(DaemonErrorCode::NotAFile));
    }

    #[test]
    fn a_path_here_counts_where_it_lands_and_only_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("acme");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("stats.py"), "print('one')\n").unwrap();
        std::fs::write(dir.path().join("away.py"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("stats.py"), root.join("bin/s.py")).unwrap();
        let root = root.to_str().unwrap();
        let hash = |list: &[&str]| hashed_here(root, &words(list)).unwrap().files;

        assert_eq!(hash(&["bin/s.py"]), BTreeMap::from([("stats.py".to_owned(), SUM_ONE.to_owned())]));
        assert!(hash(&["../away.py", "/", "0.5", "bin", "/dev/null"]).is_empty());
        let big = format!("{root}/big.bin");
        std::fs::write(&big, vec![0u8; numbers::FS_HASH_CAP_BYTES as usize + 1]).unwrap();
        assert!(hash(&[big.as_str()]).is_empty());
        assert_eq!(hashed_here("/no/such/folder", &[]).unwrap_err().code, Some(DaemonErrorCode::NotFound));
    }
}
