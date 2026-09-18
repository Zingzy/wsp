// SPDX-License-Identifier: AGPL-3.0-only
//! A workspace's bundle under `<root>/run/<id>`: a rootfs made of the computer's own system directories, one
//! read-only overlay each with an upper and a work directory of its own, the box's /root bound in with the
//! daemon's own folder blanked over it, the files the container binds over /etc, the record the ops keep, and the
//! config.json youki reads, built from the embedded profile plus what the spec asks for. Every path the runtime
//! writes under its root is spelled in `Layout` and nowhere else.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::mount::{mount, umount2, MntFlags, MsFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wsp_frames::numbers::GUEST_WSP_HOME;
use wsp_frames::{Bind, CopyWord, Share};

use crate::doctor::OVERLAID;
use crate::hardening;
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
    /// Every overlay's upper under one directory: what the workspace has written since it booted, which is what
    /// a stop keeps and a describe counts.
    pub fn upper(&self, id: &str) -> PathBuf {
        self.workspace(id).join("upper")
    }
    /// The upper of the overlay over one of the computer's system directories.
    pub fn upper_of(&self, id: &str, dir: &str) -> PathBuf {
        self.upper(id).join(dir.trim_start_matches('/'))
    }
    pub fn work(&self, id: &str) -> PathBuf {
        self.workspace(id).join("work")
    }
    /// The work directory overlayfs needs beside that upper, on the same filesystem as it.
    pub fn work_of(&self, id: &str, dir: &str) -> PathBuf {
        self.work(id).join(dir.trim_start_matches('/'))
    }
    /// The workspace's own wsp folder, bound over the box's at `GUEST_WSP_HOME`: where the daemon inside writes
    /// its token, its inbox and its manifest. Its own rather than the computer's, since the box's /root is
    /// shared by every workspace on it and a token is not a thing two workspaces may take turns writing. Kept
    /// by a stop as the uppers are, so a wake reads back what the daemon inside wrote.
    pub fn wsp_home(&self, id: &str) -> PathBuf {
        self.workspace(id).join("wsp-home")
    }
    /// An empty directory of the workspace's own, bound over a path inside it that the computer's own directory
    /// holds something at: the engine's data under /var/lib. One directory per path, since what the workspace
    /// writes at one of them is not what it writes at another.
    pub fn empty_at(&self, id: &str, at: &str) -> PathBuf {
        self.workspace(id).join("empty").join(at.trim_start_matches('/'))
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
    /// Scratch for the self check's overlay mount and the clone probe the copies word is read from. Its upper
    /// sits under the root, as a workspace's own does, which is why a root under one of the directories a
    /// workspace overlays is refused before either is made.
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
    /// Where a copy is made before it is one: a create that dies mid-copy leaves this rather than a half
    /// written `copy_of`, and the open sweeps every one of them. The copy is renamed into place, which is one
    /// directory entry, only once every byte of it is there.
    pub fn copy_being_made(&self, id: &str) -> PathBuf {
        self.copies().join(format!(".{id}{}", Layout::PARTIAL))
    }
    /// The mark a name being made carries, written by `copy_being_made` and read by `copy_belongs_to`, which are
    /// the only two that know it.
    const PARTIAL: &'static str = ".partial";
    /// The workspace a name under the copies directory belongs to: the name itself, or what the mark above wraps.
    /// The sweep asks it of every name it finds there, since a copy belongs to one workspace and to nothing else.
    pub fn copy_belongs_to(name: &str) -> String {
        name.strip_suffix(Layout::PARTIAL).and_then(|rest| rest.strip_prefix('.')).unwrap_or(name).to_owned()
    }
    /// Where this computer keeps the logins every workspace on it shares, one directory per tool: a login signed
    /// in once here, outside every workspace, and mounted into each of them. Nothing under it is ever in an image.
    pub fn logins(&self) -> PathBuf {
        self.root.join("logins")
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

/// What the ops keep about one workspace: the spec as it was built, when, and the init that runs it. It names no
/// image, since every workspace here is made of this computer's own directories: a wake mounts them again as they
/// are now, which is the box's own upgrades and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub hostname: String,
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
    /// The logins this computer holds and this workspace was made with, mounted into it by every boot: a wake
    /// takes whatever the file says now, which is what makes one sign-in on the computer the workspaces' own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<Share>,
    /// The folders of this computer's own this workspace was made with, mounted into it by every boot: a
    /// project's memory folder is one, so every workspace of that project works the same memory. A record
    /// written before any workspace took one reads as a workspace with none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub binds: Vec<Bind>,
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
    /// The computer's own logins, each bound at the path its tool reads inside; empty where none is shared.
    pub shares: &'a [Share],
    /// The computer's own folders, each bound at the path the workspace reads inside; empty where there are none.
    pub binds: &'a [Bind],
    /// The install roots this computer has of the ones outside the overlaid trees, bound read-only at their own
    /// paths: without them the tools a road installed there are on the computer and out of every workspace's
    /// sight, while the PATH inside names them. Read at every boot, so a Homebrew installed after the create is
    /// inside at the next wake.
    pub tool_roots: &'a [&'a str],
    /// The compose project every container engine call inside the workspace belongs to, where the workspace asked
    /// for an engine; nothing where it did not, since a workspace with no engine runs no compose.
    pub compose_project: Option<&'a str>,
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
    // The one PATH the tools on a machine sit on, the same order every thread and exec carries: the boot's first
    // process and the runtime's own execs would otherwise read one order of directories and a person's thread
    // another, which is a different gcc and a different gh for the same workspace.
    let mut env = vec![format!("PATH={}", wsp_frames::numbers::TOOLS_PATH), format!("HOSTNAME={}", c.hostname)];
    env.extend(c.envs.iter().map(|(k, v)| format!("{k}={v}")));
    // Last of the environment, so it stands whatever else was asked for: two workspaces of one project whose
    // compose names are both the project's own directory name fail at compose's network step, the second one
    // finding the first one's network under the name it wants (measured on a box). One name per workspace is
    // what makes the two of them two stacks.
    if let Some(project) = c.compose_project {
        env.push(format!("COMPOSE_PROJECT_NAME={project}"));
    }
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
    // Read-write, and the one file rather than the directory around it: the tool refreshes its own login in
    // place, and what it writes is what the computer holds for every other workspace on it.
    for share in c.shares {
        mounts.push(bind(&share.target, PathBuf::from(&share.source), &["rbind", "rw"]));
    }
    // A whole folder of the computer's, read-write unless the bind says otherwise: what the workspace writes in
    // it is what the computer holds for every other workspace of the same project. The same words a shared login
    // takes, and no propagation word here either: the boot makes every one of these binds itself through
    // `bind_into`, which is where the one propagation rule for everything under a rootfs lives.
    for b in c.binds {
        mounts.push(bind(&b.target, PathBuf::from(&b.source), if b.read_only { &["rbind", "ro"] } else { &["rbind", "rw"] }));
    }
    // An install root of the computer's own at its own path inside, read-only: a workspace reads the tools a road
    // installed there and writes none of them, since an install happens on the computer and nowhere else. What a
    // tool writes while it runs goes under /root, which is the computer's own and read-write already.
    for root in c.tool_roots {
        mounts.push(bind(root, PathBuf::from(root), &["rbind", "ro"]));
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
/// Where a workspace reads its resolvers, which is where the box has a link on every computer that runs
/// systemd-resolved.
const RESOLV_INSIDE: &str = "etc/resolv.conf";
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

/// One overlay: the lower directory read only under the workspace's own upper and work directories, mounted
/// nodev so no device node under the lower reaches a device from inside.
pub fn mount_overlay(lower: &Path, upper: &Path, work: &Path, target: &Path) -> Result<(), Error> {
    let data = format!("lowerdir={},upperdir={},workdir={}", lower.display(), upper.display(), work.display());
    mount(Some("overlay"), target, Some("overlay"), MsFlags::MS_NODEV, Some(data.as_str())).map_err(nix_at(target))
}

/// The directories a rootfs carries whatever the box holds: the mount points of the overlays and the binds
/// above, the ones youki mounts the kernel's own filesystems at, and the ones a login expects to be there.
const SKELETON: [&str; 15] =
    ["usr", "etc", "opt", "var", "srv", "root", "home", "tmp", "run", "proc", "sys", "dev", "mnt", "media", "boot"];

/// The two a boot empties: every distribution expects /run and /tmp empty at boot, since what is in them is pid
/// files and sockets of processes that are gone. They are plain directories of the workspace's own on the
/// daemon's disk rather than a tmpfs, which is what keeps the box's own engine socket at /run/docker.sock out of
/// a workspace, so emptying them is this function's to do and not the kernel's.
const EMPTIED_AT_BOOT: [&str; 2] = ["run", "tmp"];

/// The rootfs of a workspace on a computer somebody owns, made fresh at every boot: the box's own top-level
/// symlinks as the box writes them, an empty directory for everything else, /run and /tmp emptied, the rootfs
/// made a mount of its own that propagates nothing, an overlay over each of the computer's system directories,
/// the box's /root bound in read-write so the agents' sign-ins and caches are the person's own, the workspace's
/// own wsp folder over the box's, and an empty file or directory of the workspace's own over every path
/// `hardening::covered` names. The copy of a project and youki's own mounts come after, in the boot.
///
/// Every mount here is the workspace's alone: `bind_into` says why that takes two calls rather than one.
///
/// Nothing here is reached under a root that sits inside one of the overlaid directories: the open refuses such
/// a root before it makes anything and `crate::doctor::root_under_a_lower` says which lower it sits under. The
/// kernel takes that mount, and what it gives is a workspace reading its own upper inside the directory it
/// overlays, which is why DEFAULT_ROOT is `/wsp`.
pub fn mount_computer(layout: &Layout, id: &str, tool_roots: &[&str]) -> Result<(), Error> {
    let rootfs = layout.rootfs(id);
    // Before anything: a computer whose /bin is a directory of its own rather than a link into /usr would give a
    // workspace no shell, since /usr is the only place a tool comes from here.
    if let Some(reason) = unmerged_root()? {
        return Err(Error { path: PathBuf::from("/"), source: io::Error::new(io::ErrorKind::Unsupported, reason) });
    }
    fs::create_dir_all(&rootfs).map_err(at(&rootfs))?;
    // A wake finds what the last boot wrote at /run and /tmp, which every distribution expects empty: the pid
    // files and sockets in them name processes the stop took away.
    for name in EMPTIED_AT_BOOT {
        let dir = rootfs.join(name);
        match fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(at(&dir)(e)),
        }
    }
    for name in SKELETON {
        let dir = rootfs.join(name);
        fs::create_dir_all(&dir).map_err(at(&dir))?;
    }
    // The rootfs itself, bound to its own path and made to receive only, before one overlay or bind goes under
    // it: the volume this root sits on may be in a shared peer group of its own (a loop volume on a box was
    // shared:32), and a mount placed under a shared parent lands on every peer at the same relative path. With
    // the rootfs as its own mount and slave, nothing mounted under it can reach a peer of that volume, whatever
    // the volume is. youki binds the rootfs to itself as it pivots in any case; this is the same bind, made
    // early and made quiet.
    bind_into(&rootfs, &rootfs)?;
    // Read off the box, never written down here: on a merged-usr box bin, sbin, lib and lib64 are links into usr,
    // and a box may hold links of its own beside them. A wake finds the links its own first boot wrote, and one
    // the box has since pointed somewhere else is written again: the link itself is read, never what it points
    // at, since what it points at is under an overlay this has not mounted yet.
    for (name, target) in top_level_links()? {
        let link = rootfs.join(&name);
        match fs::read_link(&link) {
            Ok(held) if held == target => continue,
            Ok(_) => fs::remove_file(&link).map_err(at(&link))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(at(&link)(e)),
        }
        std::os::unix::fs::symlink(&target, &link).map_err(at(&link))?;
    }
    for dir in OVERLAID {
        let (upper, work) = (layout.upper_of(id, dir), layout.work_of(id, dir));
        for made in [&upper, &work] {
            fs::create_dir_all(made).map_err(at(made))?;
        }
        mount_overlay(Path::new(dir), &upper, &work, &rootfs.join(dir.trim_start_matches('/')))?;
    }
    // The overlays are up, so this lands in the workspace's own upper: a regular resolv.conf where the box has a
    // link into a /run the workspace does not share.
    write_resolv_inside(&rootfs)?;
    // The person's own home on the box, shared by every workspace on it: the agents' sign-ins, their memory and
    // their caches are the computer's and last past any one workspace, last writer wins.
    bind_into(Path::new(BOX_ROOT), &rootfs.join("root"))?;
    // And over it, the one folder under that home that is the workspace's own rather than the computer's: the
    // daemon inside writes its token, its inbox and its manifest there by default, and two workspaces on one
    // computer would otherwise take turns rewriting each other's token in a folder they share. It is made at the
    // first boot, kept by a stop as the uppers are, and goes with the workspace.
    let home = layout.wsp_home(id);
    fs::create_dir_all(&home).map_err(at(&home))?;
    bind_over(&home, &rootfs, GUEST_WSP_HOME)?;
    // And over every path of the box's own that nothing inside may read, the workspace's own empty file or
    // directory: one per path, so what a workspace writes at one of them is not what it writes at another. Read
    // off the rootfs here rather than listed here, and read last: the person's home and the box's /etc are both
    // among the trees being covered, and both are only there to read once the mounts above are up.
    for cover in hardening::covered(&rootfs) {
        let empty = layout.empty_at(id, &cover.at);
        if cover.file {
            bind_file_over(&empty, &rootfs, &cover.at)?;
        } else {
            fs::create_dir_all(&empty).map_err(at(&empty))?;
            bind_over(&empty, &rootfs, &cover.at)?;
        }
    }
    // Last, and after the covers: the Homebrew prefix sits under /home, which a cover has just emptied, so a bind
    // made before it would be the one thing the cover hid. What lands here is the computer's own tools at their own
    // path, and the PATH every process inside starts with names them.
    for root in tool_roots {
        bind_into(Path::new(root), &inside(&rootfs, root)?)?;
    }
    Ok(())
}

/// Which of those install roots this computer keeps as a directory of its own, in the order they were given: a path
/// that is not there, a file, or a symlink is passed over. A link is passed over for the reason `hardening::cover_of`
/// passes one over: an absolute link under a rootfs is resolved by the kernel against this process's own root, so a
/// bind that followed one would land on whatever the computer keeps at that path instead.
pub fn tool_roots_present<'a>(roots: &[&'a str]) -> Vec<&'a str> {
    roots.iter().copied().filter(|root| fs::symlink_metadata(root).is_ok_and(|held| held.is_dir())).collect()
}

/// One of the workspace's own directories bound over a path inside it. The mount point is under a bind of the
/// box's own directory or inside an overlay, so the daemon makes it where the box has none: the box's own wsp
/// folder is there on a computer somebody joined and the two engine folders are made by an engine that may not
/// be installed at all.
fn bind_over(source: &Path, rootfs: &Path, at_path: &str) -> Result<(), Error> {
    let target = inside(rootfs, at_path)?;
    fs::create_dir_all(&target).map_err(at(&target))?;
    bind_into(source, &target)
}

/// The same for a path the box keeps a file at: a file bind wants a file at both ends, so the workspace's own
/// empty one is made here and the one inside is already there, since the cover was read off the rootfs.
fn bind_file_over(source: &Path, rootfs: &Path, at_path: &str) -> Result<(), Error> {
    let target = inside(rootfs, at_path)?;
    if let Some(dir) = source.parent() {
        fs::create_dir_all(dir).map_err(at(dir))?;
    }
    empty_file(source)?;
    empty_file(&target)?;
    mount_bind(source, &target)
}

/// The box's own /root, bound into every workspace at the same path.
const BOX_ROOT: &str = "/root";

/// The workspace's own /etc/resolv.conf, written through the merged view of the /etc overlay so it lands in the
/// workspace's upper and the computer's own file is untouched.
///
/// Two reasons it is written here rather than left to the box's. A computer that runs systemd-resolved, which is
/// every stock Ubuntu, keeps /etc/resolv.conf as a link into /run, and /run inside a workspace is the
/// workspace's own empty folder: the runtime resolves its own bind of the file inside the root, the link leads
/// nowhere there, and the boot fails before the first process with nothing but `failed to prepare rootfs`
/// (measured on a box, 6.8.0-139). And the address that link leads to is 127.0.0.53, the box's own stub, which
/// inside a workspace's network namespace is the workspace's loopback and answers nothing.
///
/// So: the link in the upper goes, a regular file takes its place, and what it holds is the resolvers the box
/// forwards to, read by `resolv_text` from the upstream file where systemd-resolved keeps them and from the
/// box's own file where that is a file of its own.
fn write_resolv_inside(rootfs: &Path) -> Result<(), Error> {
    let path = rootfs.join(RESOLV_INSIDE);
    match fs::symlink_metadata(&path) {
        // A link, whatever it points at: removed through the merged view, which leaves the box's own alone.
        Ok(held) if held.file_type().is_symlink() => fs::remove_file(&path).map_err(at(&path))?,
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(at(&path)(e)),
    }
    fs::write(&path, resolv_text(&read_or_empty(BOX_RESOLV), &read_or_empty(UPSTREAM_RESOLV))).map_err(at(&path))
}

/// Whether this computer keeps any of the four merged names as a directory of its own, in the doctor's own
/// sentence: read off `/` here, where the rootfs is made, and asked again by the self check so a box that cannot
/// hold a workspace says so at the dial rather than at the first create.
pub fn unmerged_root() -> Result<Option<String>, Error> {
    let root = Path::new("/");
    let mut its_own = Vec::new();
    for entry in fs::read_dir(root).map_err(at(root))? {
        let entry = entry.map_err(at(root))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if crate::doctor::MERGED_INTO_USR.contains(&name.as_str()) && entry.file_type().map_err(at(&entry.path()))?.is_dir() {
            its_own.push(name);
        }
    }
    let names: Vec<&str> = its_own.iter().map(String::as_str).collect();
    Ok(crate::doctor::root_not_merged(&names))
}

/// Every top-level name on this computer that is a symlink, with what it points at: on a box with merged usr,
/// bin, sbin, lib and lib64 point into usr, and a rootfs that lacked them would have no shell at all.
fn top_level_links() -> Result<Vec<(String, PathBuf)>, Error> {
    let root = Path::new("/");
    let mut links = Vec::new();
    for entry in fs::read_dir(root).map_err(at(root))? {
        let entry = entry.map_err(at(root))?;
        if !entry.file_type().map_err(at(&entry.path())).map(|kind| kind.is_symlink())? {
            continue;
        }
        let target = fs::read_link(entry.path()).map_err(at(&entry.path()))?;
        links.push((entry.file_name().to_string_lossy().into_owned(), target));
    }
    links.sort();
    Ok(links)
}

/// Detaches the mount; a target that is not mounted is already what was asked for.
pub fn unmount(target: &Path) -> Result<(), Error> {
    match umount2(target, MntFlags::MNT_DETACH) {
        Ok(()) | Err(nix::Error::EINVAL) | Err(nix::Error::ENOENT) => Ok(()),
        Err(e) => Err(nix_at(target)(e)),
    }
}

/// One bind under a workspace's rootfs, made from this daemon's own mount namespace and before youki's create:
/// youki rebinds the rootfs recursively as it pivots, so what is bound here travels into the workspace with it,
/// and the daemon keeps seeing it at the same path outside, which is the path the engine fence already rewrites
/// a bind source to.
///
/// Every bind here is made to receive only, the moment it exists and before anything is mounted under it. A
/// computer's own `/` is in a shared peer group on every box that boots systemd, and a bind of a mount in such a
/// group stays in it: a mount placed under that bind then lands at the same relative path on every peer, which
/// includes the computer itself. Measured on a box: the workspace's own folder bound at `rootfs/root/.wsp`
/// appeared at the computer's own `/root/.wsp` for as long as the workspace lived, hiding that computer's daemon
/// files, its token and its socket from every process on it, and a second workspace's recursive bind of `/root`
/// picked up the first workspace's folder and then covered it. Slave, not private: what the computer mounts
/// later under a bound directory still reaches the workspaces, which is what a person plugging a disk in
/// expects, and nothing a workspace mounts reaches the computer.
pub fn bind_into(source: &Path, target: &Path) -> Result<(), Error> {
    fs::create_dir_all(target).map_err(at(target))?;
    mount_bind(source, target)
}

/// The two calls of one bind, made in the one order: every bind under a rootfs goes through here, so neither road
/// can make one and forget the propagation that makes it receive only.
fn mount_bind(source: &Path, target: &Path) -> Result<(), Error> {
    for (from, at_path, flags) in bind_steps(source, target) {
        mount(from, at_path, None::<&str>, flags, None::<&str>).map_err(nix_at(at_path))?;
    }
    Ok(())
}

/// The two calls one bind is made of, in order: the bind itself, then the propagation that makes it receive
/// only. Written as a list so a test reads what the boot will do without mounting anything, and so the second
/// call cannot drift away from the first.
fn bind_steps<'a>(source: &'a Path, target: &'a Path) -> [(Option<&'a Path>, &'a Path, MsFlags); 2] {
    [(Some(source), target, MsFlags::MS_BIND | MsFlags::MS_REC), (None, target, MsFlags::MS_SLAVE | MsFlags::MS_REC)]
}

/// The file a bind mount is to land on, made where the image carries none: a file bind needs the file to be
/// there inside, and the runtime makes it rather than trusting the container runtime to. Mode 0600, since a
/// login is what lands on it; a file already there is left as it is.
pub fn empty_file(path: &Path) -> Result<(), Error> {
    if path.exists() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(at(dir))?;
    }
    fs::OpenOptions::new().write(true).create(true).truncate(false).mode(0o600).open(path).map(|_| ()).map_err(at(path))
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

/// Which tree a rootfs takes from the computer itself this path is, or sits under: the person's own home, bound
/// into every workspace at the same path, and every shared install root. A mount point under one of them is made
/// through the computer's own directory and stays on it once the workspace is gone, which is why a copy or a bind
/// asking for one is refused rather than made.
///
/// The roots are read from the list and not off the disk. Presence is read again at every boot, so a destination
/// under a prefix this computer has no Homebrew at yet would be taken by the create and mounted through the
/// prefix at the first wake after a recipe run installed it.
pub fn under_computer_tree(at: &str) -> Option<&'static str> {
    std::iter::once(BOX_ROOT)
        .chain(wsp_frames::numbers::SHARED_TOOL_ROOTS)
        .find(|tree| at == *tree || at.strip_prefix(*tree).is_some_and(|under| under.starts_with('/')))
}

/// What such a destination is refused with, wherever it is read: at the create and at every boot.
pub fn computer_tree_refusal(at: &str, tree: &str) -> String {
    format!(
        "the computer's own directories are not a place for a workspace's mounts: {at} sits under {tree}, which every workspace here reads from the computer itself"
    )
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
        let l = Layout::new(Path::new(crate::DEFAULT_ROOT));
        assert_eq!(l.workspace("wsp-a"), PathBuf::from("/wsp/run/wsp-a"));
        assert_eq!(l.rootfs("wsp-a"), PathBuf::from("/wsp/run/wsp-a/rootfs"));
        assert_eq!(l.state_of("wsp-a"), PathBuf::from("/wsp/state/wsp-a"));
        assert_eq!(l.put("u1"), PathBuf::from("/wsp/put/u1"));
        assert_eq!(l.cgroup_name("wsp-a"), "/wsp/wsp-a");
        assert_eq!(l.copies(), PathBuf::from("/wsp/copies"));
        assert_eq!(l.copy_of("wsp-a"), PathBuf::from("/wsp/copies/wsp-a"));
        assert_eq!(l.projects(), PathBuf::from("/wsp/projects"));
        // The copies sit beside the checkouts under one root, which is what lets a copy share their blocks.
        assert_eq!(l.copies().parent(), l.projects().parent());
        // One upper and one work directory per overlaid directory, both under the workspace's own two, so what a
        // workspace has written is one tree to count and one tree to keep.
        assert_eq!(l.upper_of("wsp-a", "/usr"), PathBuf::from("/wsp/run/wsp-a/upper/usr"));
        assert_eq!(l.work_of("wsp-a", "/var"), PathBuf::from("/wsp/run/wsp-a/work/var"));
        assert!(OVERLAID.iter().all(|dir| l.upper_of("wsp-a", dir).starts_with(l.upper("wsp-a"))));
        // The workspace's own wsp folder, which the daemon inside writes its token into: one per workspace, so
        // no two of them are one directory however many run on the computer.
        assert_eq!(l.wsp_home("wsp-a"), PathBuf::from("/wsp/run/wsp-a/wsp-home"));
        assert_ne!(l.wsp_home("wsp-a"), l.wsp_home("wsp-b"));
        assert_eq!(l.empty_at("wsp-a", "/var/lib/docker"), PathBuf::from("/wsp/run/wsp-a/empty/var/lib/docker"));
        // An empty directory per path and no two of them one directory: what a workspace writes at one of them
        // is not what it writes at another.
        let empties: std::collections::BTreeSet<PathBuf> = hardening::EMPTY_BINDS.iter().map(|at| l.empty_at("wsp-a", at)).collect();
        assert_eq!(empties.len(), hardening::EMPTY_BINDS.len());
        // Every one of them under the workspace's own folder, so a stop keeps them and a remove takes them all.
        for made in [l.wsp_home("wsp-a"), l.empty_at("wsp-a", hardening::EMPTY_BINDS[0]), l.upper("wsp-a")] {
            assert!(made.starts_with(l.workspace("wsp-a")), "{}", made.display());
        }
        // The mark a copy being made carries is written and read in one place.
        assert_eq!(l.copy_being_made("wsp-a"), PathBuf::from("/wsp/copies/.wsp-a.partial"));
        assert_eq!(Layout::copy_belongs_to(".wsp-a.partial"), "wsp-a");
        assert_eq!(Layout::copy_belongs_to("wsp-a"), "wsp-a");
        assert_eq!(Layout::copy_belongs_to(".clone-probe-42-0"), ".clone-probe-42-0");
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
            etc: Path::new("/wsp/run/wsp-a/etc"),
            engine: None,
            shares: &[],
            binds: &[],
            tool_roots: &[],
            compose_project: None,
        };
        let spec = config_json(&c);
        assert_eq!(spec["root"]["path"], "rootfs");
        assert_eq!(spec["hostname"], "wsp-a");
        assert_eq!(spec["process"]["args"], json!(args));
        // The one PATH a machine's tools sit on, which every thread and exec on this workspace carries too.
        assert_eq!(spec["process"]["env"], json!([format!("PATH={}", wsp_frames::numbers::TOOLS_PATH), "HOSTNAME=wsp-a", "WSP_TOKEN=t"]));
        assert_eq!(spec["linux"]["resources"]["memory"]["limit"], 1024 * 1024 * 1024);
        assert_eq!(spec["linux"]["resources"]["cpu"], json!({ "quota": 200000, "period": 100000 }));
        assert_eq!(spec["linux"]["cgroupsPath"], "/wsp/wsp-a");
        let mounts = spec["mounts"].as_array().unwrap();
        let init = mounts.iter().find(|m| m["destination"] == profile::INIT_PATH).unwrap();
        assert_eq!(init["source"], "/usr/local/bin/wsp-daemon");
        assert_eq!(init["options"], json!(["bind", "ro"]));
        let hosts = mounts.iter().find(|m| m["destination"] == "/etc/hosts").unwrap();
        assert_eq!(hosts["source"], "/wsp/run/wsp-a/etc/hosts");
        assert_eq!(spec["process"]["capabilities"]["bounding"].as_array().unwrap().len(), 13);
        assert!(mounts.iter().all(|m| m["destination"] != crate::engine::INSIDE_DIR));
        let bare = config_json(&Config { cpu: None, mem_mb: None, ..c });
        assert!(bare["linux"].get("resources").is_none());
        let with_engine = config_json(&Config { engine: Some(Path::new("/wsp/run/wsp-a/engine")), ..c });
        let socket_dir = with_engine["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == crate::engine::INSIDE_DIR).unwrap();
        assert_eq!(socket_dir["source"], "/wsp/run/wsp-a/engine");
        // The compose project is the workspace's own, and it is the last word in the environment: a workspace
        // with an engine runs compose against the box's engine through the fence, and two workspaces of one
        // project share no network there only because their project names differ.
        let composing = config_json(&Config { engine: Some(Path::new("/wsp/run/wsp-a/engine")), compose_project: Some("wsp-a"), ..c });
        let env = composing["process"]["env"].as_array().unwrap();
        assert_eq!(env.last().unwrap(), "COMPOSE_PROJECT_NAME=wsp-a");
        assert_eq!(env.iter().filter(|word| word.as_str().is_some_and(|w| w.starts_with("COMPOSE_PROJECT_NAME="))).count(), 1);
        // And a workspace that asked for no engine carries none, since it runs no compose at all.
        assert!(!spec["process"]["env"].as_array().unwrap().iter().any(|w| w.as_str().is_some_and(|w| w.contains("COMPOSE_PROJECT"))));
        assert!(!with_engine["process"]["env"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().is_some_and(|w| w.contains("COMPOSE_PROJECT"))));
        // A login the computer signs in once: the one file, at the path the tool reads it inside, read-write, so
        // the tool refreshing it there is the computer's own refresh. Nothing else about the mounts moves.
        let shares = [Share { source: "/wsp/logins/codex/auth.json".to_owned(), target: "/root/.codex/auth.json".to_owned() }];
        let shared = config_json(&Config { shares: &shares, ..c });
        let login = shared["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == "/root/.codex/auth.json").unwrap();
        assert_eq!(login["source"], "/wsp/logins/codex/auth.json");
        assert_eq!(login["type"], "bind");
        assert_eq!(login["options"], json!(["rbind", "rw"]));
        assert_eq!(shared["mounts"].as_array().unwrap().len(), mounts.len() + 1);
        // And a workspace that shares none carries no mount of its own.
        assert!(mounts.iter().all(|m| m["destination"] != "/root/.codex/auth.json"));
        // A folder of the computer's own, at the path the workspace reads it inside: one more mount after the
        // profile's, read-write, so what the workspace writes in the project's checkout is what the computer
        // holds for the next piece of work on it.
        let held = "/srv/spoo-landing";
        let binds = [Bind { source: "/wsp/projects/pr_1/checkout".to_owned(), target: held.to_owned(), read_only: false }];
        let bound = config_json(&Config { binds: &binds, ..c });
        let folder = bound["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == held).unwrap();
        assert_eq!(folder["source"], "/wsp/projects/pr_1/checkout");
        assert_eq!(folder["type"], "bind");
        // The same words a shared login takes: the boot makes the bind itself, and `bind_steps` is the one place
        // the propagation of everything under a rootfs is decided.
        assert_eq!(folder["options"], json!(["rbind", "rw"]));
        assert_eq!(bound["mounts"].as_array().unwrap().len(), mounts.len() + 1);
        // A bind the host asked to be read-only is mounted that way, and a workspace with no bind carries none.
        let read_only = [Bind { source: "/wsp/projects/pr_1/checkout".to_owned(), target: held.to_owned(), read_only: true }];
        let fenced = config_json(&Config { binds: &read_only, ..c });
        assert_eq!(
            fenced["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == held).unwrap()["options"],
            json!(["rbind", "ro"])
        );
        assert!(mounts.iter().all(|m| m["destination"] != held));
        // An install root of the computer's own outside the overlaid trees: one bind at its own path, read-only,
        // and nothing else about the mounts moves. A workspace on a computer with none carries no such mount.
        let with_roots = config_json(&Config { tool_roots: &[wsp_frames::numbers::HOMEBREW_HOME], ..c });
        let root_mount =
            with_roots["mounts"].as_array().unwrap().iter().find(|m| m["destination"] == wsp_frames::numbers::HOMEBREW_HOME).unwrap();
        assert_eq!(root_mount["source"], wsp_frames::numbers::HOMEBREW_HOME);
        assert_eq!(root_mount["type"], "bind");
        assert_eq!(root_mount["options"], json!(["rbind", "ro"]));
        assert_eq!(with_roots["mounts"].as_array().unwrap().len(), mounts.len() + 1);
        assert!(mounts.iter().all(|m| m["destination"] != wsp_frames::numbers::HOMEBREW_HOME));
        // The PATH is the same on both, since it is one rule and not a reading of what this computer has: a box
        // with no Homebrew yet gets a workspace whose PATH names the prefix and whose rootfs carries no bind.
        assert_eq!(with_roots["process"]["env"], spec["process"]["env"]);
    }

    #[test]
    fn a_tool_root_the_computer_keeps_as_a_directory_is_present_and_nothing_else_is() {
        let dir = tempfile::tempdir().unwrap();
        let (held, file, link, missing) = ("held", "a-file", "a-link", "not-there");
        fs::create_dir_all(dir.path().join(held)).unwrap();
        fs::write(dir.path().join(file), "x\n").unwrap();
        std::os::unix::fs::symlink(dir.path().join(held), dir.path().join(link)).unwrap();
        let at = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        let (held, file, link, missing) = (at(held), at(file), at(link), at(missing));
        let roots: Vec<&str> = vec![&held, &file, &link, &missing];
        // A directory of the computer's own is bound in; a file, a missing path and a link are passed over. The link
        // for the reason a cover passes one over: the kernel resolves an absolute link under a rootfs against this
        // process's own root, so a bind that followed it would land somewhere else entirely.
        assert_eq!(tool_roots_present(&roots), vec![held.as_str()]);
        assert_eq!(tool_roots_present(&[]), Vec::<&str>::new());
        // And the roots this computer is asked about are the ones the wire names, whatever this computer has.
        assert_eq!(wsp_frames::numbers::SHARED_TOOL_ROOTS, [wsp_frames::numbers::HOMEBREW_HOME]);
    }

    /// Which destinations sit under a tree the rootfs takes from the computer, read off the list rather than off
    /// this computer's disk: the prefix answers whether a Homebrew is installed at it or not, since a wake after
    /// a recipe run installed one would find it there.
    #[test]
    fn a_destination_under_the_computers_own_home_or_a_tool_root_names_the_tree_it_is_under() {
        let brew = wsp_frames::numbers::HOMEBREW_HOME;
        assert_eq!(under_computer_tree("/root/x"), Some(BOX_ROOT));
        assert_eq!(under_computer_tree(BOX_ROOT), Some(BOX_ROOT));
        assert_eq!(under_computer_tree("/root/.claude-cfg/projects/k/memory"), Some(BOX_ROOT));
        assert_eq!(under_computer_tree(&format!("{brew}/bin")), Some(brew));
        assert_eq!(under_computer_tree(brew), Some(brew));
        // Every path a workspace's own mounts land at: the projects folder, a copy at the checkout's own path,
        // and the scratch a case writes in.
        for taken in ["/private/tmp/repo", "/wsp/projects/p", "/var/tmp/x", "/Users/zingzy/wsp"] {
            assert_eq!(under_computer_tree(taken), None, "{taken}");
        }
        // A name the tree's own name is a prefix of is not under it: the reading is by path component.
        assert_eq!(under_computer_tree("/rootfs"), None);
        assert_eq!(under_computer_tree(&format!("{brew}er")), None);
        // One sentence, naming the destination and the tree it sits under.
        assert_eq!(
            computer_tree_refusal("/root/x", BOX_ROOT),
            "the computer's own directories are not a place for a workspace's mounts: /root/x sits under /root, which every workspace here reads from the computer itself"
        );
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
        // The stub's own address never travels into a workspace whatever the box's two files hold: inside a
        // workspace's network namespace that loopback is the workspace's own and answers nothing.
        for (box_file, upstream) in [(stub, upstream), (stub, ""), ("nameserver 127.0.0.53\n", "nameserver 127.0.0.53\n")] {
            assert!(!resolv_text(box_file, upstream).contains("127.0.0.53"), "{box_file:?} {upstream:?}");
        }
    }

    #[test]
    fn a_record_reads_back_and_a_missing_one_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        assert_eq!(read_record(&path).unwrap(), None);
        let record = Workspace {
            id: "wsp-a".into(),
            hostname: "wsp-a".into(),
            labels: BTreeMap::from([("wsp".to_owned(), "1".to_owned())]),
            envs: BTreeMap::from([("WSP_TOKEN".to_owned(), "t".to_owned())]),
            cpu: Some(2.0),
            mem_mb: None,
            created_at: "2026-09-12T00:00:00.000Z".into(),
            init: Init { pid: 4242, started: 123_456, boot_id: "b0".into() },
            engine: false,
            copy: None,
            shares: Vec::new(),
            binds: Vec::new(),
        };
        write_json(&path, &record).unwrap();
        assert_eq!(read_record(&path).unwrap(), Some(record.clone()));
        // A record written before the engine, the copy, the shares and the binds fields existed reads as a
        // workspace with none of them.
        let written = fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains("engine") && !written.contains("copy") && !written.contains("shares") && !written.contains("binds"),
            "{written}"
        );
        assert!(read_record(&path).unwrap().unwrap().shares.is_empty());
        assert!(read_record(&path).unwrap().unwrap().binds.is_empty());
        assert_eq!(read_record(&path).unwrap().unwrap().copy, None);
        write_json(&path, &Workspace { engine: true, ..record.clone() }).unwrap();
        assert!(read_record(&path).unwrap().unwrap().engine);
        let made = CopyMade {
            from: "/wsp/projects/wsp/checkout".to_owned(),
            at: "/Users/zingzy/wsp".to_owned(),
            made: CopyWord::Reflink,
            ms: 1_903,
        };
        write_json(&path, &Workspace { copy: Some(made.clone()), ..record.clone() }).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap().copy, Some(made));
        assert!(fs::read_to_string(&path).unwrap().contains("\"made\": \"reflink\""));
        // The logins the workspace was made with are the record's too: every boot binds whatever the file says now.
        let shares = vec![Share { source: "/var/lib/wsp/logins/codex/auth.json".to_owned(), target: "/root/.codex/auth.json".to_owned() }];
        write_json(&path, &Workspace { shares: shares.clone(), ..record.clone() }).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap().shares, shares);
        // And the folders it was made with, which every boot mounts again: the project's checkout on the computer.
        let binds =
            vec![Bind { source: "/wsp/projects/pr_1/checkout".to_owned(), target: "/srv/spoo-landing".to_owned(), read_only: false }];
        write_json(&path, &Workspace { binds: binds.clone(), ..record }).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap().binds, binds);
    }

    /// Every bind the boot makes is two calls in one order: the bind, then the propagation that makes it
    /// receive only. Read off the list the boot walks, so a bind added later cannot skip the second call, and
    /// nothing is mounted to read it.
    #[test]
    fn a_bind_under_a_rootfs_is_made_to_receive_only_right_after_it_is_made() {
        let (source, target) = (Path::new("/root"), Path::new("/wsp/run/wsp-a/rootfs/root"));
        let steps = bind_steps(source, target);
        assert_eq!(steps.len(), 2);
        // The bind itself, recursive, so what the computer holds under the source comes along.
        assert_eq!(steps[0].0, Some(source));
        assert_eq!(steps[0].1, target);
        assert_eq!(steps[0].2, MsFlags::MS_BIND | MsFlags::MS_REC);
        // Then the same path made a slave of its source, recursively: it receives what the computer mounts
        // later and propagates nothing back, which is what keeps a workspace's own folder off the computer's
        // own path. Second, not first: the propagation is of the mount, and before the bind there is none.
        assert_eq!(steps[1].0, None);
        assert_eq!(steps[1].1, target);
        assert_eq!(steps[1].2, MsFlags::MS_SLAVE | MsFlags::MS_REC);
        assert!(!steps[1].2.contains(MsFlags::MS_SHARED) && !steps[1].2.contains(MsFlags::MS_PRIVATE));
    }

    /// What a workspace's /etc/resolv.conf is after the boot writes it, on a rootfs made by hand: the link the
    /// box keeps there on every computer that runs systemd-resolved is gone, a regular file stands in its place,
    /// and what it holds is a nameserver a workspace can reach. No mount and no root: this is the write the boot
    /// makes through the merged view, and the live case below is the same write over a real overlay.
    #[test]
    fn the_workspaces_own_resolv_conf_is_a_file_where_the_box_keeps_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        fs::create_dir_all(rootfs.join("etc")).unwrap();
        fs::create_dir_all(rootfs.join("run")).unwrap();
        // The link every stock Ubuntu keeps, pointing into a /run the workspace's own is empty of.
        std::os::unix::fs::symlink("../run/systemd/resolve/stub-resolv.conf", rootfs.join(RESOLV_INSIDE)).unwrap();
        assert!(fs::read_to_string(rootfs.join(RESOLV_INSIDE)).is_err(), "the link resolves inside this rootfs");

        write_resolv_inside(&rootfs).unwrap();
        let held = fs::symlink_metadata(rootfs.join(RESOLV_INSIDE)).unwrap();
        assert!(held.file_type().is_file(), "the workspace's resolv.conf is not a regular file");
        let text = fs::read_to_string(rootfs.join(RESOLV_INSIDE)).unwrap();
        assert!(text.lines().any(|line| line.starts_with("nameserver ")), "{text}");
        assert!(!text.contains("127.0.0.53"), "{text}");
        // Written again, as a wake writes it, over the file the last boot left.
        write_resolv_inside(&rootfs).unwrap();
        assert_eq!(fs::read_to_string(rootfs.join(RESOLV_INSIDE)).unwrap(), text);
        // And on a rootfs whose /etc has nothing there at all, which is a box with no resolv.conf of its own.
        let bare = dir.path().join("bare");
        fs::create_dir_all(bare.join("etc")).unwrap();
        write_resolv_inside(&bare).unwrap();
        assert!(fs::read_to_string(bare.join(RESOLV_INSIDE)).unwrap().contains("nameserver "));
    }

    /// Whether a live mount case may run here: the flag the live suite sets and root, since every mount below
    /// needs both. A run as anyone else is a return at the first line, as every live case in this crate is.
    fn live_and_root() -> bool {
        std::env::var("WSP_RUNTIME_LIVE").as_deref() == Ok("1") && nix::unistd::geteuid().is_root()
    }

    /// The whole of what a workspace on a computer somebody owns is made of, mounted on a throwaway root and
    /// taken down again: the box's own top-level symlinks, the skeleton, an overlay over each of the computer's
    /// system directories with the workspace's own upper under it, the box's /root, an empty directory over every
    /// path nothing inside may read, and this computer's own install roots outside those trees bound in at their
    /// own paths. Root and the live flag, as every mount case here is. Nothing of the computer's /home is written
    /// here: the roots are whatever it already has, read rather than made.
    #[test]
    fn a_workspace_is_the_computers_own_directories_over_the_workspaces_own_uppers() {
        if !live_and_root() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("root"));
        let (id, rootfs) = ("wsp-computer", layout.rootfs("wsp-computer"));
        // What the computer keeps at its own resolv.conf, read before anything is mounted: a link on every
        // computer that runs systemd-resolved, and whatever it is, this leaves it alone.
        let box_resolv = (fs::symlink_metadata(BOX_RESOLV).map(|m| m.file_type().is_symlink()).ok(), fs::read_link(BOX_RESOLV).ok());
        // And what the box keeps at two of the paths the covers go over, so the case can say afterwards that the
        // computer's own are as they were: how many entries its /root/.ssh holds and how long its shadow file is,
        // neither of which is a thing this reads the content of.
        let box_ssh = fs::read_dir("/root/.ssh").map(|d| d.count()).unwrap_or(0);
        let box_shadow = fs::metadata("/etc/shadow").map(|m| m.len()).ok();
        // What this computer has of the install roots outside the overlaid trees: /home/linuxbrew on a box the
        // recipe's Homebrew rows ran on, nothing on one with no Homebrew, and the case reads both.
        let roots = tool_roots_present(&wsp_frames::numbers::SHARED_TOOL_ROOTS);
        mount_computer(&layout, id, &roots).unwrap();
        let table = || fs::read_to_string(MOUNTINFO).unwrap();
        let mounted = |at: &Path| mount_points(&table()).contains(&at.to_path_buf());

        // The box's own links, read off / rather than written down: on a merged-usr box bin, sbin, lib and lib64
        // point into usr, and a rootfs without them has no shell at all.
        for (name, target) in top_level_links().unwrap() {
            assert_eq!(fs::read_link(rootfs.join(&name)).unwrap(), target, "{name}");
        }
        // And a second mount of the same rootfs, which is what a wake is, writes them again rather than
        // tripping on the links its first boot left.
        unmount_under(&rootfs).unwrap();
        mount_computer(&layout, id, &roots).unwrap();
        for (name, target) in top_level_links().unwrap() {
            assert_eq!(fs::read_link(rootfs.join(&name)).unwrap(), target, "{name} after a second mount");
        }
        for name in SKELETON {
            assert!(rootfs.join(name).is_dir(), "{name}");
        }
        // Each of the five is its own overlay, and each carries the box's own files.
        for lower in OVERLAID {
            let at = rootfs.join(lower.trim_start_matches('/'));
            assert!(mounted(&at), "{lower} is not mounted");
            assert!(layout.upper_of(id, lower).is_dir() && layout.work_of(id, lower).is_dir(), "{lower}");
        }
        assert!(rootfs.join("etc/os-release").is_file(), "the box's /etc did not come in");
        // The one file in the box's /etc a workspace may not take as it is: the boot writes a regular
        // resolv.conf in the workspace's own upper, whatever the box keeps there, and the box's own is
        // untouched. Without it the runtime's bind of that file resolves inside the root to nothing.
        let inside_resolv = rootfs.join(RESOLV_INSIDE);
        assert!(fs::symlink_metadata(&inside_resolv).unwrap().file_type().is_file(), "the workspace's resolv.conf is not a file");
        let text = fs::read_to_string(&inside_resolv).unwrap();
        assert!(text.lines().any(|line| line.starts_with("nameserver ")) && !text.contains("127.0.0.53"), "{text}");
        assert!(layout.upper_of(id, "/etc").join("resolv.conf").is_file(), "the write did not land in the workspace's upper");
        assert_eq!(
            (fs::symlink_metadata(BOX_RESOLV).map(|m| m.file_type().is_symlink()).ok(), fs::read_link(BOX_RESOLV).ok()),
            box_resolv,
            "the computer's own resolv.conf changed"
        );

        // A write through the merged view lands in the workspace's own upper, and the box's directory does not
        // have it: a workspace installs a package and the computer does not.
        let written = rootfs.join("usr/lib/wsp-computer-probe");
        fs::write(&written, b"the workspace wrote this\n").unwrap();
        assert_eq!(fs::read(layout.upper_of(id, "/usr").join("lib/wsp-computer-probe")).unwrap(), b"the workspace wrote this\n");
        assert!(!Path::new("/usr/lib/wsp-computer-probe").exists(), "a workspace's write reached the box");

        // The person's own /root is the box's, shared and writable; every path the hardening list names is the
        // workspace's own empty file or directory over the box's, so the box's logins, its sudo rules, its ssh
        // host keys, the keys that open it and every other home on it show nothing inside.
        assert!(mounted(&rootfs.join("root")));
        let covers = hardening::covered(&rootfs);
        for named in ["/etc/shadow", "/etc/gshadow", "/root/.ssh", "/home", "/var/lib/docker"] {
            assert!(covers.iter().any(|c| c.at == named), "{named} is not covered: {covers:?}");
        }
        assert!(covers.iter().any(|c| c.at.starts_with("/etc/ssh/ssh_host_")), "no host key is covered: {covers:?}");
        for cover in &covers {
            let at_path = inside(&rootfs, &cover.at).unwrap();
            assert!(mounted(&at_path), "{} is not covered", cover.at);
            if cover.file {
                assert_eq!(fs::metadata(&at_path).unwrap().len(), 0, "{} reads bytes inside", cover.at);
                continue;
            }
            // Empty, but for the install roots the boot binds in after the covers: the only thing under /home a
            // workspace reads is the prefix a road installed the computer's tools into, which lands inside the
            // cover because the boot binds it after the cover is up.
            let mut expected: Vec<String> = roots
                .iter()
                .filter_map(|root| Path::new(root).strip_prefix(&cover.at).ok())
                .filter_map(|rest| rest.components().next().map(|first| first.as_os_str().to_string_lossy().into_owned()))
                .collect();
            let mut held: Vec<String> =
                fs::read_dir(&at_path).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            held.sort();
            expected.sort();
            expected.dedup();
            assert_eq!(held, expected, "{} holds more than the install roots brought in", cover.at);
            fs::write(at_path.join("probe"), b"w").unwrap();
            assert!(layout.empty_at(id, &cover.at).join("probe").is_file(), "{} wrote somewhere else", cover.at);
            // And the write went to the workspace's own empty directory, never to the bound root inside it.
            assert_eq!(fs::read_dir(&at_path).unwrap().count(), expected.len() + 1, "{}", cover.at);
        }
        // Every install root this computer has is mounted at its own path inside, under the cover over /home, and
        // what it holds is the computer's own: the tools a road installed there answer in the workspace.
        for root in &roots {
            let at_path = inside(&rootfs, root).unwrap();
            assert!(mounted(&at_path), "{root} is not bound into the workspace");
            let mut inside_names: Vec<String> =
                fs::read_dir(&at_path).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            let mut own: Vec<String> = fs::read_dir(root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            inside_names.sort();
            own.sort();
            assert_eq!(inside_names, own, "{root} reads differently inside");
        }
        assert_eq!(fs::read_dir("/root/.ssh").map(|d| d.count()).unwrap_or(0), box_ssh, "the computer's own keys changed");
        assert_eq!(fs::metadata("/etc/shadow").map(|m| m.len()).ok(), box_shadow, "the computer's own logins changed");

        // The wsp folder under that home is the workspace's own: what the daemon inside writes at its token's
        // default path lands under run/<id> and nothing of it reaches the box's own folder.
        let home = inside(&rootfs, GUEST_WSP_HOME).unwrap();
        assert!(mounted(&home), "the workspace's own wsp folder is not mounted");
        let token = PathBuf::from(wsp_frames::numbers::DEFAULT_TOKEN_PATH);
        let held = fs::read(&token).ok();
        fs::write(inside(&rootfs, wsp_frames::numbers::DEFAULT_TOKEN_PATH).unwrap(), b"a-token-of-this-workspace\n").unwrap();
        assert_eq!(fs::read(layout.wsp_home(id).join("daemon-token")).unwrap(), b"a-token-of-this-workspace\n");
        assert_eq!(fs::read(&token).ok(), held, "a write inside reached the computer's own daemon token");

        // /run and /tmp are the workspace's own and empty at every boot, which is what every distribution
        // expects: a pid file or a socket left there names a process the stop took away.
        for name in EMPTIED_AT_BOOT {
            assert_eq!(fs::read_dir(rootfs.join(name)).unwrap().count(), 0, "/{name} is not empty at boot");
            fs::write(rootfs.join(name).join("last-boot.pid"), b"4242\n").unwrap();
        }

        unmount_under(&rootfs).unwrap();
        assert!(!table().contains(&rootfs.display().to_string()), "a mount of the workspace outlived the stop");
        // What the workspace wrote is still on disk, which is what a wake boots over: the uppers, the wsp
        // folder with the daemon's own token in it, and the empty directories' own writes.
        assert!(layout.upper_of(id, "/usr").join("lib/wsp-computer-probe").is_file());
        assert_eq!(fs::read(layout.wsp_home(id).join("daemon-token")).unwrap(), b"a-token-of-this-workspace\n");
        // And what it left at /run and /tmp is gone at the next boot, as a boot leaves them.
        mount_computer(&layout, id, &roots).unwrap();
        for name in EMPTIED_AT_BOOT {
            assert_eq!(fs::read_dir(rootfs.join(name)).unwrap().count(), 0, "/{name} carried the last boot's files");
        }
        assert_eq!(fs::read(inside(&rootfs, wsp_frames::numbers::DEFAULT_TOKEN_PATH).unwrap()).unwrap(), b"a-token-of-this-workspace\n");
        unmount_under(&rootfs).unwrap();
    }

    /// A bind whose source is in a shared peer group, which is what the computer's own `/` is on a box: what
    /// the boot mounts under that bind may not appear at the source's own path. The source here is a temp
    /// directory this case makes shared itself, never the computer's `/root`, which this case neither reads nor
    /// writes. Root and the live flag, as every mount case here is.
    #[test]
    fn nothing_mounted_under_a_bind_reaches_the_peer_group_its_source_is_in() {
        if !live_and_root() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        // The stand-in for the computer's own home and the folder under it a workspace covers: a marker in it,
        // so a mount that reached the source would hide this file and the case would read that.
        let (home, under) = (dir.path().join("home"), dir.path().join("home/.wsp"));
        let (own, rootfs) = (dir.path().join("own"), dir.path().join("rootfs"));
        for made in [&home, &under, &own, &rootfs] {
            fs::create_dir_all(made).unwrap();
        }
        fs::write(
            under.join("token"),
            b"the computer's own
",
        )
        .unwrap();
        // The source made a mount of its own and shared, which is the shape a box's / has.
        mount(Some(&home), &home, None::<&str>, MsFlags::MS_BIND | MsFlags::MS_REC, None::<&str>).unwrap();
        mount(None::<&str>, &home, None::<&str>, MsFlags::MS_SHARED | MsFlags::MS_REC, None::<&str>).unwrap();
        let table = || fs::read_to_string(MOUNTINFO).unwrap();
        let at_path = |p: &Path| mount_points(&table()).iter().filter(|point| *point == p).count();
        assert_eq!(at_path(&home), 1, "the stand-in source is not its own mount");

        // The boot's own road: the source bound under a rootfs, then the workspace's own folder over a path
        // inside that bind.
        bind_into(&rootfs, &rootfs).unwrap();
        bind_into(&home, &rootfs.join("root")).unwrap();
        bind_into(&own, &rootfs.join("root/.wsp")).unwrap();
        assert_eq!(at_path(&rootfs.join("root/.wsp")), 1, "the workspace's own folder is not mounted");
        // The whole of it: nothing new at the source's own path, and what the source holds there is still what
        // it held. A bind left in the source's peer group would have put the workspace's empty folder here.
        assert_eq!(at_path(&under), 0, "a mount under the bind reached the source's own path");
        assert_eq!(
            fs::read_to_string(under.join("token")).unwrap(),
            "the computer's own
"
        );
        assert_eq!(fs::read_dir(&under).unwrap().count(), 1);
        // And the workspace reads its own folder at that path, which is the point of the bind.
        fs::write(
            rootfs.join("root/.wsp/token"),
            b"the workspace's own
",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(own.join("token")).unwrap(),
            "the workspace's own
"
        );
        assert_eq!(
            fs::read_to_string(under.join("token")).unwrap(),
            "the computer's own
"
        );

        unmount_under(&rootfs).unwrap();
        assert_eq!(at_path(&under), 0);
        unmount(&home).unwrap();
    }

    /// Two binds under a rootfs, as a boot leaves them, taken down by one call while the mount the box itself
    /// holds under the same root stays. Root and a mount namespace of its own, so it runs where the live cases do.
    #[test]
    fn unmount_under_takes_a_bind_under_a_bind_and_leaves_the_boxs_own_mounts() {
        if !live_and_root() {
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
