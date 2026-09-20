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
/// own home, and a workspace that could write it would let itself back into the box as root; the two engine
/// folders are the box's images and containers, which a workspace reaches through the fenced socket and nowhere
/// else.
///
/// /home covers every other home on the box: the overlays are /usr, /etc, /opt, /var and /srv, so a workspace's
/// /home is the skeleton's own empty directory, and the row is what keeps it empty the day a build binds the box's
/// root or overlays /home as the five above are overlaid. The one thing under it a workspace does read is a shared
/// tool root, Homebrew's prefix today: the boot binds those in after this cover, at their own paths and read-only,
/// so the tools a road installed there answer inside while nobody's home does.
///
/// `/root/.wsp` is not here: the boot already binds the workspace's own folder over it, so the daemon inside
/// writes its token where no other workspace on the box reads it. The sudo rules are not here either: a turn
/// inside is root in its own namespaces already, so the box's rules grant it nothing, and an empty
/// `/etc/sudoers` is a file sudo reads as granting nobody anything, which breaks every `sudo` a script inside
/// types for no credential kept back.
pub const EMPTY_BINDS: [&str; 6] = ["/etc/shadow", "/etc/gshadow", "/home", "/root/.ssh", "/var/lib/docker", "/var/lib/containerd"];

/// Every path under the box root's own home that a login shell or a root systemd manager of the box's runs by
/// name, with whether the box keeps a file or a directory there. A workspace is root in a home the box root
/// shares with it, so a line it writes into one of these is a line the box root's next login runs outside every
/// workspace: each is the workspace's own copy of the box's file, or its own folder, bound over the box's. A
/// path the box keeps nothing at is covered all the same, so a workspace cannot make it.
///
/// What this does not close, said plainly: the box root's own `.bashrc` and `.profile` source files in the shared
/// home beyond these names, an nvm or a cargo environment line, a completion file under `.local/share`, and they
/// put `.local/bin` and `bin` on the PATH. A plant in one of those still runs at the box root's next login. What
/// is closed is what the distribution's own skeleton reads by name; the rest is the shared home the map rules as
/// the design of this place.
pub const ROOT_RUN_COVERS: [(&str, bool); 18] = [
    ("/root/.profile", true),
    ("/root/.bash_profile", true),
    ("/root/.bash_login", true),
    ("/root/.bash_logout", true),
    ("/root/.bashrc", true),
    ("/root/.bash_aliases", true),
    ("/root/.zshenv", true),
    ("/root/.zprofile", true),
    ("/root/.zshrc", true),
    ("/root/.zlogin", true),
    ("/root/.zlogout", true),
    ("/root/.pam_environment", true),
    ("/root/.gitconfig", true),
    ("/root/.config/fish/config.fish", true),
    ("/root/.config/systemd", false),
    ("/root/.local/share/systemd", false),
    ("/root/.config/environment.d", false),
    ("/root/.config/autostart", false),
];

/// Where a box keeps the keys it answers ssh on, and the name every one of them starts with: they are named by
/// algorithm, so the directory is read rather than the names written down. A workspace holding the private ones
/// could answer as the box to anything that trusts it.
pub const SSH_DIR: &str = "/etc/ssh";
pub const HOST_KEY_PREFIX: &str = "ssh_host_";

/// One path inside a workspace and what goes over it: the workspace's own empty file where the box keeps a file
/// there, its own empty directory where it keeps a directory, or its own copy of the box's file where a shell of
/// the box's runs what that file holds.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cover {
    pub at: String,
    pub file: bool,
    /// The workspace's own copy of what the box keeps there, taken at the first boot that finds no copy and kept
    /// across wakes as the uppers are, rather than an empty file or folder made at every boot.
    pub own: bool,
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
    // Read off the list and not off the rootfs: a path the box keeps nothing at is covered too, since a workspace
    // that could make it there would have the box root's next login run it.
    for (at, file) in ROOT_RUN_COVERS {
        out.push(Cover { at: at.to_owned(), file, own: true });
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
    Some(Cover { at: at.to_owned(), file: held.is_file(), own: false })
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
        // The covers read off the rootfs itself; the ones read off `ROOT_RUN_COVERS` are the case below.
        let at: Vec<&str> = covers.iter().filter(|c| !c.own).map(|c| c.at.as_str()).collect();
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
        let every: Vec<&str> = covers.iter().map(|c| c.at.as_str()).collect();
        let once: std::collections::BTreeSet<&str> = every.iter().copied().collect();
        assert_eq!(once.len(), every.len());
    }

    #[test]
    fn a_path_the_box_keeps_nothing_at_is_not_covered_and_a_link_is_passed_over() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("bare");
        fs::create_dir_all(rootfs.join("etc")).unwrap();
        // Nothing of the denylist is there: no cover read off the rootfs, and the boot mounts none of them.
        assert!(covered(&rootfs).iter().all(|c| c.own));
        // A path the box keeps as a link: the cover would follow it out of the rootfs, since the kernel resolves
        // an absolute link against this process's own root, and land on the box's own file.
        fs::create_dir_all(rootfs.join("run/nothing")).unwrap();
        std::os::unix::fs::symlink("/run/nothing", rootfs.join("home")).unwrap();
        fs::write(rootfs.join("etc/shadow"), "root:x:20000:0:99999:7:::\n").unwrap();
        let covers = covered(&rootfs);
        assert_eq!(covers.iter().filter(|c| !c.own).map(|c| c.at.as_str()).collect::<Vec<_>>(), ["/etc/shadow"]);
        // And the link itself is still a link: nothing here writes through one.
        assert!(fs::symlink_metadata(rootfs.join("home")).unwrap().file_type().is_symlink());
    }

    /// What the box root's own login and its systemd run by name is the workspace's own copy or its own folder,
    /// whether the box keeps something there or not: a path the box has nothing at is covered all the same, since
    /// a workspace that could make it there would have the box root run it.
    #[test]
    fn what_the_box_roots_shell_runs_by_name_is_covered_with_the_workspaces_own() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = a_rootfs(dir.path());
        for (file, text) in [("root/.bashrc", "# the box's own\n"), ("root/.bash_aliases", "alias x=y\n"), ("root/.profile", "# box\n")] {
            fs::write(rootfs.join(file), text).unwrap();
        }
        fs::create_dir_all(rootfs.join("root/.config/systemd/user")).unwrap();
        fs::write(rootfs.join("root/.config/systemd/user/x.service"), "[Service]\n").unwrap();
        let covers = covered(&rootfs);
        let cover = |at: &str| covers.iter().find(|c| c.at == at).unwrap_or_else(|| panic!("{at} is not covered: {covers:?}")).clone();

        // The files the box keeps: the workspace's own copy of each, which the boot seeds and keeps.
        for at in ["/root/.bashrc", "/root/.bash_aliases", "/root/.profile"] {
            assert_eq!(cover(at), Cover { at: at.to_owned(), file: true, own: true });
        }
        // The folder a root systemd manager reads units from: the workspace's own, and the folder under it that
        // the box keeps a unit in is not reachable through it.
        assert_eq!(cover("/root/.config/systemd"), Cover { at: "/root/.config/systemd".to_owned(), file: false, own: true });
        // And every rc path the box keeps nothing at, covered all the same.
        for at in ["/root/.zshrc", "/root/.bash_login", "/root/.gitconfig", "/root/.config/fish/config.fish"] {
            assert_eq!(cover(at), Cover { at: at.to_owned(), file: true, own: true });
        }
        for at in ["/root/.local/share/systemd", "/root/.config/environment.d", "/root/.config/autostart"] {
            assert_eq!(cover(at), Cover { at: at.to_owned(), file: false, own: true });
        }
        // Every row of the list is one cover and no row is under another, since a bind of one would hide the
        // other and which of the two won would be the order they were made in.
        assert_eq!(covers.iter().filter(|c| c.own).count(), ROOT_RUN_COVERS.len());
        for (at, _) in ROOT_RUN_COVERS {
            let under = ROOT_RUN_COVERS.iter().filter(|(other, _)| *other != at && at.starts_with(&format!("{other}/"))).count();
            assert_eq!(under, 0, "{at} sits under another row of the list");
        }
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
