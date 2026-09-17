// SPDX-License-Identifier: AGPL-3.0-only
//! A workspace's bundle under `<root>/run/<id>`: an overlay rootfs over the chain's unpacked layers with an upper
//! and a work directory of its own, the files the container binds over /etc, the record the ops keep, and the
//! config.json youki reads, built from the embedded profile plus what the spec asks for. Every path the runtime
//! writes under its root is spelled in `Layout` and nowhere else.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

use nix::mount::{mount, umount2, MntFlags, MsFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wsp_frames::CopyWord;

use crate::profile;
use crate::store::Chain;

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
    /// The workspace's network: its link, its addresses and the ports published for it.
    pub fn net(&self, id: &str) -> PathBuf {
        self.workspace(id).join("net.json")
    }
    /// What the boot command prints, since its first process is nobody's child to read.
    pub fn boot_log(&self, id: &str) -> PathBuf {
        self.workspace(id).join("boot.log")
    }
    /// The directory holding the workspace's fenced engine socket, bound into it where it asked for an engine.
    pub fn engine(&self, id: &str) -> PathBuf {
        self.workspace(id).join("engine")
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
    /// Scratch for the self check's overlay mount and the clone probe the copies word is read from.
    pub fn check(&self) -> PathBuf {
        self.root.join("check")
    }
    /// Every workspace's own copy of the checkout it was made with, one directory per workspace.
    pub fn copies(&self) -> PathBuf {
        self.root.join("copies")
    }
    pub fn copy_of(&self, id: &str) -> PathBuf {
        self.copies().join(id)
    }
    /// Where the project checkouts a box holds live; the copies directory sits beside it under the same root,
    /// which is what lets a copy share blocks with the checkout it was made from.
    pub fn projects(&self) -> PathBuf {
        self.root.join("projects")
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

/// What the ops keep about one workspace: the spec as it was built, the chain it boots from, when, and the init
/// that runs it. The chain is the record's own copy: a wake mounts it whatever became of the name it was resolved
/// from, and the sweep keeps its layers while the record stands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub hostname: String,
    pub image: String,
    pub chain: Chain,
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub envs: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_mb: Option<u64>,
    pub created_at: String,
    pub init: Init,
    /// The workspace asked for the box's container engine, so every boot serves the fenced socket into it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub engine: bool,
    /// The project this workspace was made with, where it was made with one: the copy of a checkout this
    /// computer holds, bound inside at the project's own path by every boot. A record written before any
    /// workspace took a project reads as one without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy: Option<CopyMade>,
}

/// The copy one workspace was made with, as the create made it: where it came from, where it is mounted inside,
/// the way this disk made it and how long that took. The way is kept because the remove takes a snapshot away
/// through the kernel and a copied tree away through the filesystem, and the time because a plain copy's minutes
/// are a thing the person is told rather than left to guess at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyMade {
    pub from: String,
    pub at: String,
    pub made: CopyWord,
    pub ms: u64,
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
    /// The directory holding the engine socket, bound at `engine::INSIDE_DIR` where the workspace asked for one.
    pub engine: Option<&'a Path>,
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
    if let Some(engine) = c.engine {
        mounts.push(bind(crate::engine::INSIDE_DIR, engine.to_path_buf(), &["rbind", "rprivate"]));
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

/// The three files bound over /etc: the hostname, a hosts file naming it and the box at `host.wsp.internal` once
/// the gateway is known, and the box's resolvers.
pub fn write_etc(etc: &Path, hostname: &str, gateway: Option<Ipv4Addr>) -> Result<(), Error> {
    fs::create_dir_all(etc).map_err(at(etc))?;
    let hostname_file = etc.join("hostname");
    fs::write(&hostname_file, format!("{hostname}\n")).map_err(at(&hostname_file))?;
    let hosts = etc.join("hosts");
    fs::write(&hosts, hosts_text(hostname, gateway)).map_err(at(&hosts))?;
    let resolv = etc.join("resolv.conf");
    fs::write(&resolv, resolv_text(&read_or_empty(BOX_RESOLV), &read_or_empty(UPSTREAM_RESOLV))).map_err(at(&resolv))?;
    Ok(())
}

pub fn hosts_text(hostname: &str, gateway: Option<Ipv4Addr>) -> String {
    let mut text = format!("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.0.1\t{hostname}\n");
    if let Some(gateway) = gateway {
        text.push_str(&format!("{gateway}\t{}\n", crate::net::HOST_NAME));
    }
    text
}

const BOX_RESOLV: &str = "/etc/resolv.conf";
/// Where systemd-resolved keeps the resolvers it forwards to, when the box's own file names only its stub.
const UPSTREAM_RESOLV: &str = "/run/systemd/resolve/resolv.conf";
/// The resolvers Docker hands a container when the box names none it can use.
const DEFAULT_NAMESERVERS: [&str; 2] = ["8.8.8.8", "8.8.4.4"];

fn read_or_empty(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// The box's resolv.conf as a workspace can use it: a nameserver on the box's own loopback is a stub the workspace
/// cannot reach, so the upstream file stands in for it; IPv6 nameservers go, since the workspace has no IPv6 route;
/// a box with no usable nameserver gets Docker's defaults. Search and options lines come along as they are.
pub fn resolv_text(box_file: &str, upstream: &str) -> String {
    let usable = |file: &str| -> Vec<String> {
        file.lines()
            .filter_map(|line| line.trim().strip_prefix("nameserver").map(str::trim))
            .filter_map(|word| word.parse::<IpAddr>().ok())
            .filter(|ip| matches!(ip, IpAddr::V4(v4) if !v4.is_loopback()))
            .map(|ip| ip.to_string())
            .collect()
    };
    let (mut servers, source) = match usable(box_file) {
        found if !found.is_empty() => (found, box_file),
        _ => match usable(upstream) {
            found if !found.is_empty() => (found, upstream),
            _ => (Vec::new(), box_file),
        },
    };
    if servers.is_empty() {
        servers = DEFAULT_NAMESERVERS.iter().map(|s| (*s).to_owned()).collect();
    }
    let mut text = String::new();
    for server in servers {
        text.push_str(&format!("nameserver {server}\n"));
    }
    for line in source.lines().map(str::trim) {
        if line.starts_with("search ") || line.starts_with("options ") {
            text.push_str(line);
            text.push('\n');
        }
    }
    text
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

/// The copy bound into the workspace's rootfs at the path the project has inside it, from this daemon's own
/// mount namespace and before youki's create: youki rebinds the rootfs recursively as it pivots, so the copy
/// travels into the workspace with it, and the daemon keeps seeing it at the same path outside, which is the
/// path the engine fence already rewrites a bind source to.
pub fn bind_into(source: &Path, target: &Path) -> Result<(), Error> {
    fs::create_dir_all(target).map_err(at(target))?;
    mount(Some(source), target, None::<&str>, MsFlags::MS_BIND | MsFlags::MS_REC, None::<&str>).map_err(nix_at(target))
}

/// Where a path inside a workspace lands under its rootfs on the box. A second wall after the wire's own, held
/// to the wire's own rule rather than to a copy of it: a path that walks up out of the rootfs resolves to a
/// path on the box, and a bind mount is the one place a slip cannot be undone afterwards.
pub fn inside(rootfs: &Path, at: &str) -> Result<PathBuf, Error> {
    if !wsp_frames::is_plain_path(at) {
        let detail = format!("{at} is not a path inside a workspace");
        return Err(Error { path: rootfs.to_owned(), source: io::Error::new(io::ErrorKind::InvalidInput, detail) });
    }
    Ok(rootfs.join(at.trim_start_matches('/')))
}

/// Every mount under this path taken down, deepest first, and then the path itself: a rootfs carries the
/// overlay, the copy bound into it and whatever youki mounted under that, and a stop that detached only the
/// rootfs would leave the rest of them on the box. Read off this process's own mount table, so nothing outside
/// the path is ever named, let alone unmounted.
pub fn unmount_under(target: &Path) -> Result<(), Error> {
    let mut under: Vec<PathBuf> = mount_points(&fs::read_to_string(MOUNTINFO).map_err(at(Path::new(MOUNTINFO)))?)
        .into_iter()
        .filter(|point| point.starts_with(target))
        .collect();
    // Deepest first: a mount cannot be detached while another sits under it.
    under.sort_by_key(|point| std::cmp::Reverse(point.components().count()));
    for point in under {
        unmount(&point)?;
    }
    unmount(target)
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
const MOUNTINFO: &str = "/proc/self/mountinfo";

fn mount_points(table: &str) -> Vec<PathBuf> {
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
        assert_eq!(l.copies(), PathBuf::from("/var/lib/wsp/copies"));
        assert_eq!(l.copy_of("wsp-a"), PathBuf::from("/var/lib/wsp/copies/wsp-a"));
        assert_eq!(l.projects(), PathBuf::from("/var/lib/wsp/projects"));
        // The copies sit beside the checkouts under one root, which is what lets a copy share their blocks.
        assert_eq!(l.copies().parent(), l.projects().parent());
    }

    #[test]
    fn a_copy_lands_inside_the_workspace_at_the_projects_own_path_and_nowhere_else() {
        let l = Layout::new(Path::new("/wsp"));
        assert_eq!(inside(&l.rootfs("wsp-a"), "/Users/zingzy/wsp").unwrap(), PathBuf::from("/wsp/run/wsp-a/rootfs/Users/zingzy/wsp"));
        assert_eq!(inside(Path::new("/r"), "/x").unwrap(), PathBuf::from("/r/x"));
        // The wire refuses these before they reach here; this is the wall behind that one, since what a bind
        // mount lands on cannot be taken back.
        for walking in ["/Users/../../etc", "/..", "/a/../b", "/a/./b", "Users/zingzy/wsp"] {
            let refused = inside(&l.rootfs("wsp-a"), walking).unwrap_err().to_string();
            assert!(refused.contains(walking) && refused.contains("not a path inside a workspace"), "{walking}: {refused}");
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
            engine: None,
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
        assert!(mounts.iter().all(|m| m["destination"] != crate::engine::INSIDE_DIR));
        let bare = config_json(&Config { cpu: None, mem_mb: None, ..c });
        assert!(bare["linux"].get("resources").is_none());
        let with_engine = config_json(&Config { engine: Some(Path::new("/var/lib/wsp/run/wsp-a/engine")), ..c });
        let socket_dir = with_engine["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == crate::engine::INSIDE_DIR).unwrap();
        assert_eq!(socket_dir["source"], "/var/lib/wsp/run/wsp-a/engine");
    }

    #[test]
    fn the_etc_files_name_the_host_and_the_box_once_the_gateway_is_known() {
        let dir = tempfile::tempdir().unwrap();
        write_etc(dir.path(), "wsp-b", None).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("hostname")).unwrap(), "wsp-b\n");
        let hosts = fs::read_to_string(dir.path().join("hosts")).unwrap();
        assert!(hosts.contains("127.0.0.1\twsp-b") && !hosts.contains("host.wsp.internal"), "{hosts}");
        let resolv = fs::read_to_string(dir.path().join("resolv.conf")).unwrap();
        assert!(resolv.contains("nameserver "), "{resolv}");
        write_etc(dir.path(), "wsp-b", Some(Ipv4Addr::new(10, 65, 0, 5))).unwrap();
        assert!(fs::read_to_string(dir.path().join("hosts")).unwrap().ends_with("10.65.0.5\thost.wsp.internal\n"));
    }

    #[test]
    fn the_resolvers_handed_in_are_ones_a_workspace_can_reach() {
        let stub = "# stub\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n";
        let upstream = "nameserver 2a01:4ff:ff00::add:2\nnameserver 185.12.64.1\nnameserver 185.12.64.2\nsearch corp.example\n";
        assert_eq!(resolv_text(stub, upstream), "nameserver 185.12.64.1\nnameserver 185.12.64.2\nsearch corp.example\n");
        assert_eq!(resolv_text("nameserver 1.1.1.1\nsearch lan\n", upstream), "nameserver 1.1.1.1\nsearch lan\n");
        assert_eq!(resolv_text("nameserver ::1\n", ""), "nameserver 8.8.8.8\nnameserver 8.8.4.4\n");
        assert_eq!(resolv_text("", ""), "nameserver 8.8.8.8\nnameserver 8.8.4.4\n");
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
            chain: Chain { config: crate::fetch::Digest::of(b"c"), layers: vec![crate::fetch::Digest::of(b"l")] },
            labels: BTreeMap::from([("wsp".to_owned(), "1".to_owned())]),
            envs: BTreeMap::from([("WSP_TOKEN".to_owned(), "t".to_owned())]),
            cpu: Some(2.0),
            mem_mb: None,
            created_at: "2026-09-12T00:00:00.000Z".into(),
            init: Init { pid: 4242, started: 123_456, boot_id: "b0".into() },
            engine: false,
            copy: None,
        };
        write_json(&path, &record).unwrap();
        assert_eq!(read_record(&path).unwrap(), Some(record.clone()));
        // A record written before the engine and the copy fields existed reads as a workspace without either.
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("engine") && !written.contains("copy"), "{written}");
        assert_eq!(read_record(&path).unwrap().unwrap().copy, None);
        write_json(&path, &Workspace { engine: true, ..record.clone() }).unwrap();
        assert!(read_record(&path).unwrap().unwrap().engine);
        let made = CopyMade {
            from: "/wsp/projects/wsp/checkout".to_owned(),
            at: "/Users/zingzy/wsp".to_owned(),
            made: CopyWord::Reflink,
            ms: 1_903,
        };
        write_json(&path, &Workspace { copy: Some(made.clone()), ..record }).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap().copy, Some(made));
        assert!(fs::read_to_string(&path).unwrap().contains("\"made\": \"reflink\""));
    }

    /// Two binds under a rootfs, as a boot leaves them, taken down by one call while the mount the box itself
    /// holds under the same root stays. Root and a mount namespace of its own, so it runs where the live cases do.
    #[test]
    fn unmount_under_takes_a_bind_under_a_bind_and_leaves_the_boxs_own_mounts() {
        if std::env::var("WSP_RUNTIME_LIVE").as_deref() != Ok("1") || !nix::unistd::geteuid().is_root() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (root, rootfs) = (dir.path().join("root"), dir.path().join("root/run/wsp-a/rootfs"));
        let outside = dir.path().join("outside");
        for made in [&rootfs, &outside, &root.join("copies/wsp-a")] {
            fs::create_dir_all(made).unwrap();
        }
        fs::write(root.join("copies/wsp-a/file"), b"in the copy").unwrap();
        // The box's own mount under the same root, which nothing here may take down.
        let kept = root.join("projects");
        fs::create_dir_all(&kept).unwrap();
        bind_into(&outside, &kept).unwrap();
        bind_into(&root.join("copies/wsp-a"), &rootfs.join("Users/zingzy/wsp")).unwrap();
        bind_into(&root.join("copies/wsp-a"), &rootfs.join("Users/zingzy/wsp/again")).unwrap();
        let mounted = |at: &Path| mount_points(&fs::read_to_string(MOUNTINFO).unwrap()).contains(&at.to_path_buf());
        assert!(mounted(&rootfs.join("Users/zingzy/wsp")) && mounted(&rootfs.join("Users/zingzy/wsp/again")));
        unmount_under(&rootfs).unwrap();
        assert!(!mounted(&rootfs.join("Users/zingzy/wsp")) && !mounted(&rootfs.join("Users/zingzy/wsp/again")));
        assert!(mounted(&kept), "the box's own mount went with the workspace's");
        unmount(&kept).unwrap();
    }
}
