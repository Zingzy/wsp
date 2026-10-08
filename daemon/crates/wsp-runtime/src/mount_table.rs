// SPDX-License-Identifier: AGPL-3.0-only
//! This process's own mount table, read for what is mounted at or under a folder and what filesystem holds one.

use std::fs;
use std::path::{Path, PathBuf};

/// Every mount at or under this path, off this process's own mount table, which a leave reads before it takes the
/// runtime's folder: a workspace still running there reads through them. Read as bytes, since a mount point anywhere
/// on the computer may name bytes that are not UTF-8; a table that cannot be read is said, never read as no mounts.
pub fn mounts_at_or_under(target: &Path) -> Result<Vec<PathBuf>, String> {
    let table = fs::read(MOUNTINFO).map_err(|e| format!("{MOUNTINFO}: {e}"))?;
    Ok(mount_points(&String::from_utf8_lossy(&table)).into_iter().filter(|point| point.starts_with(target)).collect())
}

/// The filesystem the mount covering this path is of, for the sentence a plain copy is explained in; nothing
/// where the table names no mount over it.
pub fn filesystem_at(path: &Path) -> Option<String> {
    let table = fs::read_to_string(MOUNTINFO).ok()?;
    mounts(&table)
        .into_iter()
        .filter(|(point, _)| path.starts_with(point))
        .max_by_key(|(point, _)| point.components().count())
        .map(|(_, kind)| kind)
}

/// Where the kernel writes this process's own mounts.
pub(crate) const MOUNTINFO: &str = "/proc/self/mountinfo";

pub(crate) fn mount_points(table: &str) -> Vec<PathBuf> {
    mounts(table).into_iter().map(|(point, _)| point).collect()
}

/// Every mount in the table as its point and its filesystem. A line is the kernel's: the point is the fifth
/// field with its spaces and other odd bytes written as octal escapes, and the filesystem is the first field
/// after the lone dash, which the optional fields before it are told from by nothing else.
fn mounts(table: &str) -> Vec<(PathBuf, String)> {
    table
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(' ');
            let point = unescaped(fields.nth(4)?);
            let kind = fields.by_ref().skip_while(|word| *word != "-").nth(1)?;
            Some((PathBuf::from(point), kind.to_owned()))
        })
        .collect()
}

/// A mount point as the kernel wrote it: \040 and its three siblings back to the bytes they stand for.
fn unescaped(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut bytes = word.chars();
    while let Some(c) = bytes.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let octal: String = bytes.clone().take(3).collect();
        match u8::from_str_radix(&octal, 8) {
            Ok(byte) if octal.len() == 3 => {
                out.push(char::from(byte));
                bytes.nth(2);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set on the second run of the case below, inside a mount namespace of its own.
    #[cfg(target_os = "linux")]
    const IN_OWN_MOUNTS: &str = "WSP_TEST_IN_OWN_MOUNTS";

    #[cfg(target_os = "linux")]
    #[test]
    fn a_mount_point_naming_bytes_that_are_not_utf8_leaves_the_table_read_and_the_mount_under_the_runtime_found() {
        // Mounts a tmpfs, which needs root, in a namespace of the case's own so the computer's table is never touched:
        // the case runs itself again under unshare, and that run does the mounting.
        if !nix::unistd::geteuid().is_root() {
            return;
        }
        let Some(dir) = std::env::var_os(IN_OWN_MOUNTS) else {
            let dir = tempfile::tempdir().unwrap();
            let ran = std::process::Command::new("unshare")
                .args(["--mount", "--propagation", "private"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", "mount_table::tests::a_mount_point_naming_bytes_that_are_not_utf8_leaves_the_table_read_and_the_mount_under_the_runtime_found"])
                .env(IN_OWN_MOUNTS, dir.path())
                .output();
            // A computer that lends no mount namespace has nothing to hold the read to.
            let Ok(ran) = ran else { return };
            assert!(ran.status.success(), "{}{}", String::from_utf8_lossy(&ran.stdout), String::from_utf8_lossy(&ran.stderr));
            return;
        };
        use std::os::unix::ffi::OsStrExt;
        let dir = Path::new(&dir);
        let runtime = dir.join("wsp");
        let rootfs = runtime.join("run/a/rootfs");
        let odd = dir.join(std::ffi::OsStr::from_bytes(b"odd-\xff"));
        for point in [&rootfs, &odd] {
            fs::create_dir_all(point).unwrap();
            nix::mount::mount(Some("tmpfs"), point.as_path(), Some("tmpfs"), nix::mount::MsFlags::empty(), None::<&str>).unwrap();
        }
        assert_eq!(mounts_at_or_under(&runtime), Ok(vec![rootfs.clone()]));
        for point in [&rootfs, &odd] {
            nix::mount::umount(point.as_path()).unwrap();
        }
    }

    #[test]
    fn the_mount_table_reads_as_the_kernel_writes_it() {
        // The kernel's own shape: optional fields before the dash on the first line and none on the second, a
        // point with a space in it as an octal escape, and a filesystem after the dash rather than before it.
        let table = concat!(
            "36 35 98:0 / /wsp rw,noatime shared:1 master:2 - xfs /dev/sda1 rw\n",
            "37 36 0:24 / /wsp/run/wsp-a/rootfs rw - overlay overlay rw\n",
            "38 37 98:0 /copies/wsp-a /wsp/run/wsp-a/rootfs/Users/my\\040project rw - xfs /dev/sda1 rw\n",
        );
        assert_eq!(
            mounts(table),
            vec![
                (PathBuf::from("/wsp"), "xfs".to_owned()),
                (PathBuf::from("/wsp/run/wsp-a/rootfs"), "overlay".to_owned()),
                (PathBuf::from("/wsp/run/wsp-a/rootfs/Users/my project"), "xfs".to_owned()),
            ]
        );
        assert_eq!(unescaped("/a\\040b\\011c"), "/a b\tc");
        assert_eq!(unescaped("/plain\\x"), "/plain\\x");
        assert!(mounts("not a mount line").is_empty());
    }
}
