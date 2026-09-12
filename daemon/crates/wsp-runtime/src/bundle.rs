// SPDX-License-Identifier: AGPL-3.0-only
//! A workspace's bundle under `<root>/run/<id>`: an overlay rootfs over the chain's unpacked layers with an upper
//! and a work directory of its own, the files the container binds over /etc, the record the ops keep, and the
//! config.json youki reads, built from the embedded profile plus what the spec asks for. Every path the runtime
//! writes under its root is spelled in `Layout` and nowhere else.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use nix::mount::{mount, umount2, MntFlags, MsFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::profile;

/// Every path the runtime writes under its root.
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(root: &Path) -> Layout {
        Layout { root: root.to_path_buf() }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn run(&self) -> PathBuf {
        self.root.join("run")
    }
    /// The bundle: config.json, the record, the rootfs mount point, the upper and work directories.
    pub fn workspace(&self, id: &str) -> PathBuf {
        self.run().join(id)
    }
    pub fn rootfs(&self, id: &str) -> PathBuf {
        self.workspace(id).join("rootfs")
    }
    pub fn upper(&self, id: &str) -> PathBuf {
        self.workspace(id).join("upper")
    }
    pub fn work(&self, id: &str) -> PathBuf {
        self.workspace(id).join("work")
    }
    /// The three files bound over the container's /etc.
    pub fn etc(&self, id: &str) -> PathBuf {
        self.workspace(id).join("etc")
    }
    pub fn config(&self, id: &str) -> PathBuf {
        self.workspace(id).join("config.json")
    }
    pub fn record(&self, id: &str) -> PathBuf {
        self.workspace(id).join("workspace.json")
    }
    /// What the boot command prints, since its first process is nobody's child to read.
    pub fn boot_log(&self, id: &str) -> PathBuf {
        self.workspace(id).join("boot.log")
    }
    /// youki's own root: `<root>/state/<id>` holds its state.json and notify sockets.
    pub fn state(&self) -> PathBuf {
        self.root.join("state")
    }
    pub fn state_of(&self, id: &str) -> PathBuf {
        self.state().join(id)
    }
    /// The parts of one upload while they arrive.
    pub fn put(&self, upload_id: &str) -> PathBuf {
        self.root.join("put").join(upload_id)
    }
    /// Scratch for the self check's overlay mount.
    pub fn check(&self) -> PathBuf {
        self.root.join("check")
    }
    /// The workspace's cgroup as the spec names it, under the cgroup root.
    pub fn cgroup_name(&self, id: &str) -> String {
        format!("/wsp/{id}")
    }
    /// Where the plain cgroup manager puts it.
    pub fn cgroup_dir(&self, id: &str) -> PathBuf {
        Path::new(crate::freeze::CGROUP_ROOT).join(self.cgroup_name(id).trim_start_matches('/'))
    }
}

/// The init process as it was at create: its pid, and what tells that pid apart from any process the kernel
/// hands the same number to later, or after a reboot. youki's state file keeps the pid alone and reads any live
/// process under it as the container, which is not a reading this crate may act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Init {
    pub pid: i32,
    /// Its start time in clock ticks since boot, field 22 of /proc/<pid>/stat.
    pub started: u64,
    /// The box's boot id, since ticks since boot start over with it.
    pub boot_id: String,
}

/// What the ops keep about one workspace: the spec as it was built, when, and the init that runs it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub hostname: String,
    pub image: String,
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_mb: Option<u64>,
    pub created_at: String,
    pub init: Init,
}

/// What one config.json is built from, beside the profile.
pub struct Config<'a> {
    pub hostname: &'a str,
    /// The process youki starts: the init in front of the boot command.
    pub args: &'a [String],
    pub envs: &'a BTreeMap<String, String>,
    pub cpu: Option<f64>,
    pub mem_mb: Option<u64>,
    pub cgroup: &'a str,
    /// The binary bound at `INIT_PATH`: this daemon's own.
    pub init: &'a Path,
    /// The directory holding hostname, hosts and resolv.conf.
    pub etc: &'a Path,
}

#[derive(Debug)]
pub struct Error {
    pub path: PathBuf,
    pub source: io::Error,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path.display(), self.source)
    }
}

impl std::error::Error for Error {}

fn at(path: &Path) -> impl FnOnce(io::Error) -> Error + '_ {
    move |source| Error { path: path.to_owned(), source }
}

fn nix_at(path: &Path) -> impl FnOnce(nix::Error) -> Error + '_ {
    move |e| Error { path: path.to_owned(), source: io::Error::from(e) }
}

/// The config.json for one workspace: the profile with the root, the hostname, the process, the resources and
/// the bind mounts filled in.
pub fn config_json(c: &Config) -> Value {
    let mut spec = profile::profile();
    spec["root"] = json!({ "path": "rootfs", "readonly": false });
    spec["hostname"] = json!(c.hostname);
    spec["process"]["args"] = json!(c.args);
    spec["process"]["cwd"] = json!("/");
    let mut env = vec![format!("PATH={}", profile::DEFAULT_PATH), format!("HOSTNAME={}", c.hostname)];
    env.extend(c.envs.iter().map(|(k, v)| format!("{k}={v}")));
    spec["process"]["env"] = json!(env);
    let bind = |destination: &str, source: PathBuf, options: &[&str]| json!({ "destination": destination, "type": "bind", "source": source, "options": options });
    let mounts = spec["mounts"].as_array_mut().expect("the profile lists mounts");
    mounts.push(bind(profile::INIT_PATH, c.init.to_path_buf(), &["bind", "ro"]));
    for name in ["resolv.conf", "hostname", "hosts"] {
        mounts.push(bind(&format!("/etc/{name}"), c.etc.join(name), &["rbind", "rprivate"]));
    }
    spec["linux"]["cgroupsPath"] = json!(c.cgroup);
    let mut resources = serde_json::Map::new();
    if let Some(mem_mb) = c.mem_mb {
        resources.insert("memory".into(), json!({ "limit": mem_mb * 1024 * 1024 }));
    }
    if let Some(cpu) = c.cpu {
        // Docker's NanoCpus as a quota over the default period: 2 cpus is 200000 of every 100000 microseconds.
        resources.insert("cpu".into(), json!({ "quota": (cpu * 100_000.0).round() as i64, "period": 100_000 }));
    }
    if !resources.is_empty() {
        spec["linux"]["resources"] = Value::Object(resources);
    }
    spec
}

/// The three files bound over /etc: the hostname, a hosts file naming it, and this computer's resolv.conf.
pub fn write_etc(etc: &Path, hostname: &str) -> Result<(), Error> {
    fs::create_dir_all(etc).map_err(at(etc))?;
    let hostname_file = etc.join("hostname");
    fs::write(&hostname_file, format!("{hostname}\n")).map_err(at(&hostname_file))?;
    let hosts = etc.join("hosts");
    fs::write(&hosts, format!("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.0.1\t{hostname}\n"))
        .map_err(at(&hosts))?;
    let resolv = etc.join("resolv.conf");
    fs::write(&resolv, fs::read("/etc/resolv.conf").unwrap_or_default()).map_err(at(&resolv))?;
    Ok(())
}

/// The overlay: the chain's layers as lowers, newest first as overlayfs reads them, the workspace's own upper
/// and work directories, mounted nodev so no device node in an image reaches a device.
pub fn mount_rootfs(lowers: &[PathBuf], upper: &Path, work: &Path, target: &Path) -> Result<(), Error> {
    let lower: Vec<String> = lowers.iter().rev().map(|p| p.to_string_lossy().into_owned()).collect();
    let data = format!("lowerdir={},upperdir={},workdir={}", lower.join(":"), upper.display(), work.display());
    mount(Some("overlay"), target, Some("overlay"), MsFlags::MS_NODEV, Some(data.as_str())).map_err(nix_at(target))
}

/// Detaches the mount; a target that is not mounted is already what was asked for.
pub fn unmount(target: &Path) -> Result<(), Error> {
    match umount2(target, MntFlags::MNT_DETACH) {
        Ok(()) | Err(nix::Error::EINVAL) | Err(nix::Error::ENOENT) => Ok(()),
        Err(e) => Err(nix_at(target)(e)),
    }
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), Error> {
    let text = serde_json::to_vec_pretty(value).map_err(|e| Error { path: path.to_owned(), source: io::Error::other(e) })?;
    fs::write(path, text).map_err(at(path))
}

pub fn read_record(path: &Path) -> Result<Option<Workspace>, Error> {
    match fs::read(path) {
        Ok(text) => serde_json::from_slice(&text).map(Some).map_err(|e| Error { path: path.to_owned(), source: io::Error::other(e) }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error { path: path.to_owned(), source: e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_path_sits_under_the_root() {
        let l = Layout::new(Path::new("/var/lib/wsp"));
        assert_eq!(l.workspace("wsp-a"), PathBuf::from("/var/lib/wsp/run/wsp-a"));
        assert_eq!(l.rootfs("wsp-a"), PathBuf::from("/var/lib/wsp/run/wsp-a/rootfs"));
        assert_eq!(l.state_of("wsp-a"), PathBuf::from("/var/lib/wsp/state/wsp-a"));
        assert_eq!(l.put("u1"), PathBuf::from("/var/lib/wsp/put/u1"));
        assert_eq!(l.cgroup_name("wsp-a"), "/wsp/wsp-a");
    }

    #[test]
    fn the_config_is_the_profile_with_the_spec_filled_in() {
        let envs = BTreeMap::from([("WSP_TOKEN".to_owned(), "t".to_owned())]);
        let args = vec!["/sbin/wsp-init".to_owned(), "--".to_owned(), "sleep".to_owned()];
        let c = Config {
            hostname: "wsp-a",
            args: &args,
            envs: &envs,
            cpu: Some(2.0),
            mem_mb: Some(1024),
            cgroup: "/wsp/wsp-a",
            init: Path::new("/usr/local/bin/wsp-daemon"),
            etc: Path::new("/var/lib/wsp/run/wsp-a/etc"),
        };
        let spec = config_json(&c);
        assert_eq!(spec["root"]["path"], "rootfs");
        assert_eq!(spec["hostname"], "wsp-a");
        assert_eq!(spec["process"]["args"], json!(args));
        assert_eq!(spec["process"]["env"], json!([format!("PATH={}", profile::DEFAULT_PATH), "HOSTNAME=wsp-a", "WSP_TOKEN=t"]));
        assert_eq!(spec["linux"]["resources"]["memory"]["limit"], 1024 * 1024 * 1024);
        assert_eq!(spec["linux"]["resources"]["cpu"], json!({ "quota": 200000, "period": 100000 }));
        assert_eq!(spec["linux"]["cgroupsPath"], "/wsp/wsp-a");
        let mounts = spec["mounts"].as_array().unwrap();
        let init = mounts.iter().find(|m| m["destination"] == profile::INIT_PATH).unwrap();
        assert_eq!(init["source"], "/usr/local/bin/wsp-daemon");
        assert_eq!(init["options"], json!(["bind", "ro"]));
        let hosts = mounts.iter().find(|m| m["destination"] == "/etc/hosts").unwrap();
        assert_eq!(hosts["source"], "/var/lib/wsp/run/wsp-a/etc/hosts");
        assert_eq!(spec["process"]["capabilities"]["bounding"].as_array().unwrap().len(), 13);
        let bare = config_json(&Config { cpu: None, mem_mb: None, ..c });
        assert!(bare["linux"].get("resources").is_none());
    }

    #[test]
    fn the_etc_files_name_the_host() {
        let dir = tempfile::tempdir().unwrap();
        write_etc(dir.path(), "wsp-b").unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("hostname")).unwrap(), "wsp-b\n");
        assert!(fs::read_to_string(dir.path().join("hosts")).unwrap().contains("127.0.0.1\twsp-b"));
        assert!(dir.path().join("resolv.conf").is_file());
    }

    #[test]
    fn a_record_reads_back_and_a_missing_one_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        assert_eq!(read_record(&path).unwrap(), None);
        let record = Workspace {
            id: "wsp-a".into(),
            hostname: "wsp-a".into(),
            image: "ubuntu:24.04".into(),
            labels: BTreeMap::from([("wsp".to_owned(), "1".to_owned())]),
            cpu: Some(2.0),
            mem_mb: None,
            created_at: "2026-09-12T00:00:00.000Z".into(),
            init: Init { pid: 4242, started: 123_456, boot_id: "b0".into() },
        };
        write_json(&path, &record).unwrap();
        assert_eq!(read_record(&path).unwrap(), Some(record));
    }
}
