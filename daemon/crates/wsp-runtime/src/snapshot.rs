// SPDX-License-Identifier: AGPL-3.0-only
//! A workspace's upper directory as one OCI layer: a tar of what the workspace changed since it booted, with the
//! overlay's own marks turned into the words the store reads back. A character device 0:0 is a deleted file and
//! becomes `.wh.<name>`; a directory marked `trusted.overlay.opaque` hides what the lowers hold under it and gets
//! `.wh..wh..opq` inside; every other `trusted.overlay.*` attribute is the kernel's bookkeeping and stays behind.
//! A file hard linked more than once is written once and linked after, as Docker's archiver writes it, so the
//! layer pays for it once. The store unpacks the layer through the same road a fetched one takes, so a fork mounts
//! a deleted file as deleted. The workspace is held still by its caller while this reads.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

use tar::{Builder, EntryType, Header};

/// The prefix of a whiteout entry, and the whole name of an opaque marker.
pub const WHITEOUT: &str = ".wh.";
pub const OPAQUE: &str = ".wh..wh..opq";
const OVERLAY_XATTR: &str = "trusted.overlay.";
const OPAQUE_XATTR: &str = "trusted.overlay.opaque";
/// The PAX key the tar crate reads an extended attribute back from.
const PAX_XATTR: &str = "SCHILY.xattr.";

/// The upper directory as a tar on `out`, parents before children.
pub fn write_layer(upper: &Path, out: &mut dyn Write) -> io::Result<()> {
    let mut tar = Builder::new(out);
    tar.follow_symlinks(false);
    walk(&mut tar, upper, Path::new(""), &mut HashMap::new())?;
    tar.finish()
}

/// `linked` is every inode already written that has more than one name, by device and inode, so its next name is
/// a link to the first.
fn walk(tar: &mut Builder<&mut dyn Write>, dir: &Path, rel: &Path, linked: &mut HashMap<(u64, u64), PathBuf>) -> io::Result<()> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<io::Result<_>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        let here = rel.join(&name);
        let meta = fs::symlink_metadata(&path)?;
        let kind = meta.file_type();
        if kind.is_char_device() && meta.rdev() == 0 {
            let mut marker = name.into_string().map_err(|_| io::Error::other(format!("{}: not a utf-8 name", path.display())))?;
            marker.insert_str(0, WHITEOUT);
            empty_file(tar, &rel.join(marker), &meta)?;
            continue;
        }
        if kind.is_socket() {
            continue;
        }
        xattrs(tar, &path)?;
        if kind.is_file() && meta.nlink() > 1 {
            match linked.get(&(meta.dev(), meta.ino())) {
                Some(first) => {
                    hard_link(tar, &here, first, &meta)?;
                    continue;
                }
                None => {
                    linked.insert((meta.dev(), meta.ino()), here.clone());
                }
            }
        }
        tar.append_path_with_name(&path, &here)?;
        if kind.is_dir() {
            if xattr::get(&path, OPAQUE_XATTR)?.as_deref() == Some(b"y") {
                empty_file(tar, &here.join(OPAQUE), &meta)?;
            }
            walk(tar, &path, &here, linked)?;
        }
    }
    Ok(())
}

/// A hard link entry: the name at `at`, pointing at the entry already written at `first`. The builder writes both
/// names through the GNU long name entries when they pass the header's 100 bytes, which a package tree's paths do.
fn hard_link(tar: &mut Builder<&mut dyn Write>, at: &Path, first: &Path, meta: &fs::Metadata) -> io::Result<()> {
    let mut header = Header::new_gnu();
    header.set_metadata_in_mode(meta, tar::HeaderMode::Complete);
    header.set_entry_type(EntryType::Link);
    header.set_size(0);
    tar.append_link(&mut header, at, first)
}

/// An empty regular file entry owned and dated as the thing it stands for.
fn empty_file(tar: &mut Builder<&mut dyn Write>, at: &Path, like: &fs::Metadata) -> io::Result<()> {
    let mut header = Header::new_gnu();
    header.set_entry_type(EntryType::Regular);
    header.set_mode(0o644);
    header.set_uid(like.uid().into());
    header.set_gid(like.gid().into());
    header.set_mtime(like.mtime().max(0) as u64);
    header.set_size(0);
    tar.append_data(&mut header, at, io::empty())
}

/// The entry's extended attributes as PAX records ahead of it, the overlay's own left out.
fn xattrs(tar: &mut Builder<&mut dyn Write>, path: &Path) -> io::Result<()> {
    let mut records = Vec::new();
    for key in xattr::list(path)? {
        let Some(key) = key.to_str() else { continue };
        if key.starts_with(OVERLAY_XATTR) {
            continue;
        }
        if let Some(value) = xattr::get(path, key)? {
            records.push((format!("{PAX_XATTR}{key}"), value));
        }
    }
    tar.append_pax_extensions(records.iter().map(|(k, v)| (k.as_str(), v.as_slice())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deleted_file_is_a_whiteout_and_an_opaque_directory_carries_its_marker() {
        let dir = tempfile::tempdir().unwrap();
        let upper = dir.path().join("upper");
        fs::create_dir_all(upper.join("etc")).unwrap();
        fs::write(upper.join("etc/new"), b"n").unwrap();
        std::os::unix::fs::symlink("new", upper.join("etc/link")).unwrap();
        fs::create_dir_all(upper.join("home/agent")).unwrap();
        let root = nix::unistd::geteuid().is_root();
        if root {
            nix::sys::stat::mknod(
                &upper.join("etc/gone"),
                nix::sys::stat::SFlag::S_IFCHR,
                nix::sys::stat::Mode::empty(),
                nix::sys::stat::makedev(0, 0),
            )
            .unwrap();
            xattr::set(upper.join("home/agent"), OPAQUE_XATTR, b"y").unwrap();
            xattr::set(upper.join("home/agent"), "trusted.overlay.origin", b"x").unwrap();
        }
        xattr::set(upper.join("etc/new"), "user.wsp", b"kept").unwrap();
        fs::write(upper.join("etc/big"), vec![7u8; 4096]).unwrap();
        fs::hard_link(upper.join("etc/big"), upper.join("etc/big-again")).unwrap();
        // A first name past the header's 100 bytes, as every path under a package tree is; the walk sorts by name,
        // so the dot directory comes first and the long name is the one the link points at.
        let deep = upper.join("opt/.pnpm").join("a".repeat(60)).join("node_modules").join("b".repeat(60));
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("index.js"), b"module.exports = 1\n").unwrap();
        let long_first = deep.join("index.js").strip_prefix(&upper).unwrap().to_path_buf();
        assert!(long_first.as_os_str().len() > 150, "{}", long_first.display());
        fs::hard_link(deep.join("index.js"), upper.join("opt/linked.js")).unwrap();
        let mut bytes = Vec::new();
        write_layer(&upper, &mut bytes).unwrap();
        let mut names = Vec::new();
        let mut kept = None;
        let mut links = Vec::new();
        let mut big_bytes = 0;
        for entry in tar::Archive::new(bytes.as_slice()).entries().unwrap() {
            let mut entry = entry.unwrap();
            let name = entry.path().unwrap().display().to_string();
            if name == "etc/new" {
                kept = entry.pax_extensions().unwrap().and_then(|p| {
                    p.filter_map(Result::ok).find(|x| x.key() == Ok("SCHILY.xattr.user.wsp")).map(|x| x.value_bytes().to_vec())
                });
            }
            if entry.header().entry_type().is_hard_link() {
                links.push((name.clone(), entry.link_name().unwrap().unwrap().display().to_string()));
            }
            if name.starts_with("etc/big") {
                big_bytes += entry.header().size().unwrap();
            }
            names.push(name);
        }
        assert_eq!(kept.as_deref(), Some(&b"kept"[..]), "{names:?}");
        assert!(names.contains(&"etc/new".to_owned()) && names.contains(&"etc/link".to_owned()), "{names:?}");
        // The second name of one inode is a link to the first, so the layer carries the bytes once.
        assert_eq!(
            links,
            [("etc/big-again".to_owned(), "etc/big".to_owned()), ("opt/linked.js".to_owned(), long_first.display().to_string())]
        );
        assert_eq!(big_bytes, 4096, "{names:?}");
        // Unpacked, the two names are one inode again, the long first name included.
        let restored = dir.path().join("restored");
        tar::Archive::new(bytes.as_slice()).unpack(&restored).unwrap();
        let first = fs::metadata(restored.join(&long_first)).unwrap();
        let second = fs::metadata(restored.join("opt/linked.js")).unwrap();
        assert_eq!((first.ino(), first.nlink()), (second.ino(), 2));
        assert_eq!(fs::read(restored.join("opt/linked.js")).unwrap(), b"module.exports = 1\n");
        assert_eq!(fs::metadata(restored.join("etc/big")).unwrap().ino(), fs::metadata(restored.join("etc/big-again")).unwrap().ino());
        if root {
            assert!(names.contains(&"etc/.wh.gone".to_owned()), "{names:?}");
            assert!(!names.contains(&"etc/gone".to_owned()));
            assert!(names.contains(&"home/agent/.wh..wh..opq".to_owned()), "{names:?}");
            assert!(bytes.windows(22).all(|w| w != b"trusted.overlay.origin"), "the kernel's own mark stays behind");
        }
    }
}
