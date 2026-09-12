// SPDX-License-Identifier: AGPL-3.0-only
//! Where a daemon on a computer the person owns keeps its files, as the protocol's placeDaemonPaths lays them out:
//! everything under one folder of wsp's own beneath the home, so one sweep takes the lot.

use std::path::{Path, PathBuf};

/// Every path the protocol names under a place's home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceDaemonPaths {
    pub wsp: PathBuf,
    pub dir: PathBuf,
    pub bundle: PathBuf,
    pub inbox: PathBuf,
    pub token_path: PathBuf,
    pub port_file: PathBuf,
    pub run_dir: PathBuf,
    pub put_dir: PathBuf,
    pub open_socket: PathBuf,
    pub manifest_path: PathBuf,
    pub profile_file: PathBuf,
    pub unit_dir: PathBuf,
    pub bin_dir: PathBuf,
    pub roots_path: PathBuf,
    pub place_file: PathBuf,
    pub place_key: PathBuf,
    pub place_log: PathBuf,
}

/// The home with its trailing slashes gone, as the protocol strips them before it joins.
fn trimmed(home: &Path) -> PathBuf {
    let text = home.to_string_lossy();
    let cut = text.trim_end_matches('/');
    PathBuf::from(if cut.is_empty() { "/" } else { cut })
}

pub fn place_daemon_paths(home: &Path) -> PlaceDaemonPaths {
    let at = trimmed(home);
    let wsp = at.join(".wsp");
    PlaceDaemonPaths {
        dir: wsp.join("daemon"),
        bundle: wsp.join("daemon.tgz"),
        inbox: wsp.join("inbox"),
        token_path: wsp.join("daemon-token"),
        port_file: wsp.join("daemon.port"),
        run_dir: wsp.join("run"),
        put_dir: wsp.join("put"),
        open_socket: wsp.join("open.sock"),
        manifest_path: wsp.join("manifest.json"),
        profile_file: wsp.join("profile.sh"),
        unit_dir: at.join(".config/systemd/user"),
        bin_dir: at.join(".local/bin"),
        roots_path: wsp.join("roots"),
        place_file: wsp.join("place.json"),
        place_key: wsp.join("place-key.pem"),
        place_log: wsp.join("place.log"),
        wsp,
    }
}

/// Every path a leave takes off a place, in the order the protocol's placeOwnedPaths names them. The work folder
/// is not here: what the person's threads wrote there is theirs.
pub fn place_owned_paths(home: &Path) -> Vec<PathBuf> {
    let at = place_daemon_paths(home);
    vec![
        at.place_file,
        at.place_key,
        at.place_log,
        at.dir,
        at.bundle,
        at.inbox,
        at.token_path,
        at.roots_path,
        at.profile_file,
        at.open_socket,
        at.run_dir,
        at.port_file,
        at.bin_dir.join("wsp-open"),
        at.bin_dir.join("xdg-open"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_paths_are_the_protocols_under_a_home_with_or_without_a_trailing_slash() {
        let at = place_daemon_paths(Path::new("/home/maya/"));
        assert_eq!(at.wsp, PathBuf::from("/home/maya/.wsp"));
        assert_eq!(at.place_file, PathBuf::from("/home/maya/.wsp/place.json"));
        assert_eq!(at.place_key, PathBuf::from("/home/maya/.wsp/place-key.pem"));
        assert_eq!(at.token_path, PathBuf::from("/home/maya/.wsp/daemon-token"));
        assert_eq!(at.roots_path, PathBuf::from("/home/maya/.wsp/roots"));
        assert_eq!(at.unit_dir, PathBuf::from("/home/maya/.config/systemd/user"));
        assert_eq!(at, place_daemon_paths(Path::new("/home/maya")));
    }

    #[test]
    fn the_owned_list_is_the_protocols_fourteen_in_order() {
        let owned = place_owned_paths(Path::new("/h"));
        let expected = [
            "/h/.wsp/place.json",
            "/h/.wsp/place-key.pem",
            "/h/.wsp/place.log",
            "/h/.wsp/daemon",
            "/h/.wsp/daemon.tgz",
            "/h/.wsp/inbox",
            "/h/.wsp/daemon-token",
            "/h/.wsp/roots",
            "/h/.wsp/profile.sh",
            "/h/.wsp/open.sock",
            "/h/.wsp/run",
            "/h/.wsp/daemon.port",
            "/h/.local/bin/wsp-open",
            "/h/.local/bin/xdg-open",
        ];
        assert_eq!(owned.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(), expected);
    }
}
