// SPDX-License-Identifier: AGPL-3.0-only
//! What root inside a workspace does not get, in one list each: the capabilities no workspace holds whatever the
//! profile was copied from, and the paths of the computer's own that nothing inside may read. A workspace here is
//! made of the box's own directories, so its /etc is the box's /etc and its /root is the person's own home: the
//! password hashes, the sudo rules, the keys the box answers ssh on and the keys that let it into other computers
//! are all a path away from a turn running inside one. Each of them gets the workspace's own empty file or empty
//! directory over it instead.
//!
//! The bundle walks `covered` once per boot and binds what it names; the profile is held to `DROPPED_CAPS` by a
//! test. Read on every platform the daemon builds for, so both lists are held to the same test wherever the suite
//! runs.

use std::fs;
use std::path::Path;

/// Never in a workspace's bounding set, whatever the profile is copied from: the three that let a process out of
/// its namespaces or into the box's kernel, and the one that makes a device node. Named here and nowhere else, and
/// the profile is held to this list rather than the other way round.
pub const DROPPED_CAPS: [&str; 4] = ["CAP_SYS_ADMIN", "CAP_SYS_MODULE", "CAP_SYS_BOOT", "CAP_MKNOD"];

/// Every path inside a workspace the box's own file or directory may not show through, covered with the
/// workspace's own empty one where the box keeps something there. The two /etc files are the box's password
/// hashes, which are credentials a workspace could take away and crack at its leisure, under the overlay of the
/// box's /etc; /root/.ssh is the person's own keys and the box's authorized_keys, under the bind of the person's
/// own home, and a workspace that could write it would let itself back into the box as root; /home is every
/// other person's on the box; the two engine folders are the box's images and containers, which a workspace
/// reaches through the fenced socket and nowhere else.
///
/// `/root/.wsp` is not here: the boot already binds the workspace's own folder over it, so the daemon inside
/// writes its token where no other workspace on the box reads it. The sudo rules are not here either: a turn
/// inside is root in its own namespaces already, so the box's rules grant it nothing, and an empty
/// `/etc/sudoers` is a file sudo reads as granting nobody anything, which breaks every `sudo` a script inside
/// types for no credential kept back.
pub const EMPTY_BINDS: [&str; 6] = ["/etc/shadow", "/etc/gshadow", "/home", "/root/.ssh", "/var/lib/docker", "/var/lib/containerd"];

/// Where a box keeps the keys it answers ssh on, and the name every one of them starts with: they are named by
/// algorithm, so the directory is read rather than the names written down. A workspace holding the private ones
/// could answer as the box to anything that trusts it.
pub const SSH_DIR: &str = "/etc/ssh";
pub const HOST_KEY_PREFIX: &str = "ssh_host_";

/// One path inside a workspace and what goes over it: the workspace's own empty file where the box keeps a file
/// there, its own empty directory where it keeps a directory.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cover {
    pub at: String,
    pub file: bool,
}

/// Every cover this rootfs asks for, read off the rootfs itself rather than assumed: a path the box keeps nothing
/// at gets nothing, since a bind needs something to land on and a path that is not there shows nothing anyway.
///
/// A path that is a symlink is passed over rather than bound. An absolute link under a rootfs is resolved by the
/// kernel against this process's own root, not against the rootfs, so a bind that followed one would land on the
/// box's own file: `/var/run` is a link to `/run` on every stock Ubuntu, and a cover of `/var/run/docker.sock`
/// would have bound an empty file over the box's own engine socket. What such a link leads to inside is the
/// workspace's own empty /run in any case.
///
/// Called after the boot's own binds are up, so the person's home is there to read: the cover of `/root/.ssh` is
/// of the home the bind brought in, not of the empty directory the skeleton made.
pub fn covered(rootfs: &Path) -> Vec<Cover> {
    let mut out: Vec<Cover> = Vec::new();
    for at in EMPTY_BINDS {
        if let Some(cover) = cover_of(rootfs, at) {
            out.push(cover);
        }
    }
    for name in host_keys(rootfs) {
        if let Some(cover) = cover_of(rootfs, &format!("{SSH_DIR}/{name}")) {
            out.push(cover);
        }
    }
    // One cover per path, in one order: what the boot mounts is read by a person in a log line and by a test.
    out.sort();
    out.dedup_by(|a, b| a.at == b.at);
    out
}

/// What the rootfs keeps at the path, where a cover can land on it at all.
fn cover_of(rootfs: &Path, at: &str) -> Option<Cover> {
    let held = fs::symlink_metadata(rootfs.join(at.trim_start_matches('/'))).ok()?;
    if held.file_type().is_symlink() {
        return None;
    }
    Some(Cover { at: at.to_owned(), file: held.is_file() })
}

/// The names under the rootfs's own /etc/ssh that are the box's host keys, public and private alike: a workspace
/// reading a private one could answer as the box, and the public ones say which box it is.
fn host_keys(rootfs: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(rootfs.join(SSH_DIR.trim_start_matches('/'))) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(HOST_KEY_PREFIX))
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A rootfs as a boot leaves it, with the box's own files showing through: the /etc of the overlay, the
    /// person's home under the bind, and the engine's folders.
    fn a_rootfs(root: &Path) -> std::path::PathBuf {
        let rootfs = root.join("rootfs");
        for dir in ["etc/sudoers.d", "etc/ssh", "home/someone", "root/.ssh", "var/lib/docker", "var/lib/containerd", "run"] {
            fs::create_dir_all(rootfs.join(dir)).unwrap();
        }
        for (file, text) in [
            ("etc/shadow", "root:$y$j9T$of.the.box:20000:0:99999:7:::\n"),
            ("etc/gshadow", "root:*::\n"),
            ("etc/sudoers", "root ALL=(ALL:ALL) ALL\n"),
            ("etc/ssh/ssh_host_ed25519_key", "the box's own private key\n"),
            ("etc/ssh/ssh_host_ed25519_key.pub", "the box's own public key\n"),
            ("etc/ssh/sshd_config", "Port 22\n"),
            ("root/.ssh/authorized_keys", "the key that opens the box\n"),
        ] {
            fs::write(rootfs.join(file), text).unwrap();
        }
        rootfs
    }

    #[test]
    fn every_path_the_box_keeps_something_at_is_covered_and_nothing_else_is() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = a_rootfs(dir.path());
        let covers = covered(&rootfs);
        let at: Vec<&str> = covers.iter().map(|c| c.at.as_str()).collect();
        assert_eq!(
            at,
            [
                "/etc/gshadow",
                "/etc/shadow",
                "/etc/ssh/ssh_host_ed25519_key",
                "/etc/ssh/ssh_host_ed25519_key.pub",
                "/home",
                "/root/.ssh",
                "/var/lib/containerd",
                "/var/lib/docker",
            ]
        );
        // A file is covered with a file and a directory with a directory: a bind of one over the other is refused
        // by the kernel, and what the box keeps there is what decides.
        let file_at = |path: &str| covers.iter().find(|c| c.at == path).unwrap().file;
        assert!(file_at("/etc/shadow") && file_at("/etc/ssh/ssh_host_ed25519_key"));
        assert!(!file_at("/home") && !file_at("/root/.ssh") && !file_at("/var/lib/docker"));
        // The box's sudo rules are left as they are: a turn inside is root in its own namespaces, so they grant
        // it nothing, and a file sudo reads as granting nobody anything would break every sudo typed inside.
        assert!(!at.iter().any(|path| path.contains("sudoers")), "{at:?}");
        // The host keys are read off the directory and nothing else in it is taken: sshd_config is the box's
        // configuration, which says nothing a key says.
        assert!(!at.iter().any(|path| path.ends_with("sshd_config")), "{at:?}");
        // No path twice, whatever the lists hold.
        let once: std::collections::BTreeSet<&str> = at.iter().copied().collect();
        assert_eq!(once.len(), at.len());
    }

    #[test]
    fn a_path_the_box_keeps_nothing_at_is_not_covered_and_a_link_is_passed_over() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("bare");
        fs::create_dir_all(rootfs.join("etc")).unwrap();
        // Nothing of the list is there: no cover at all, and the boot mounts nothing.
        assert_eq!(covered(&rootfs), Vec::new());
        // A path the box keeps as a link: the cover would follow it out of the rootfs, since the kernel resolves
        // an absolute link against this process's own root, and land on the box's own file.
        fs::create_dir_all(rootfs.join("run/nothing")).unwrap();
        std::os::unix::fs::symlink("/run/nothing", rootfs.join("home")).unwrap();
        fs::write(rootfs.join("etc/shadow"), "root:x:20000:0:99999:7:::\n").unwrap();
        let covers = covered(&rootfs);
        assert_eq!(covers.iter().map(|c| c.at.as_str()).collect::<Vec<_>>(), ["/etc/shadow"]);
        // And the link itself is still a link: nothing here writes through one.
        assert!(fs::symlink_metadata(rootfs.join("home")).unwrap().file_type().is_symlink());
    }

    /// The capabilities are the profile's to carry and this list's to name: a profile copied again from a live
    /// container would bring Docker's own set back, and this is what says which of them a workspace never holds.
    #[test]
    fn the_dropped_capabilities_are_in_no_set_the_profile_names() {
        let profile = crate::profile::profile();
        for set in ["bounding", "effective", "permitted"] {
            let held: Vec<&str> = profile["process"]["capabilities"][set].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
            for dropped in DROPPED_CAPS {
                assert!(!held.contains(&dropped), "{set} carries {dropped}");
            }
        }
        // And the four are named once each, so a reader of the list reads the whole rule.
        let once: std::collections::BTreeSet<&str> = DROPPED_CAPS.iter().copied().collect();
        assert_eq!(once.len(), DROPPED_CAPS.len());
    }
}
