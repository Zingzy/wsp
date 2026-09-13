// SPDX-License-Identifier: AGPL-3.0-only
//! What this computer can and cannot do as a place, read off the kernel without mounting anything, so it can run
//! at every dial and land in the report the host reads. Three things a person is told: whether workspaces run
//! here, and if not the one kernel reason why; whether the box has an engine for a project's own containers,
//! which is not this crate's to build; and whether it has KVM, for the microVM road. The authoritative gate
//! when a fork is actually asked for is still the self check, which mounts an overlay and makes a cgroup; this is
//! the read-only twin of it, so what the doctor says and what a create does cannot part ways on the same box.

use std::path::Path;

/// Where cgroup v2 is mounted when the box runs it; the read-only twin of the self check reads the same root the
/// freezer writes. Read only on Linux, where a workspace runs.
#[cfg(target_os = "linux")]
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// The container engine a project's own `docker compose` would run on, when the box has one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    None,
    Docker,
    Podman,
}

impl Engine {
    /// The word the report carries and the host reads.
    pub fn word(self) -> &'static str {
        match self {
            Engine::None => "none",
            Engine::Docker => "docker",
            Engine::Podman => "podman",
        }
    }
}

/// The kernel facts the doctor reads, split out so a test can hand it a box it is not running on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// This computer runs Linux, which the kernel work a workspace is built from needs; the rest of the facts are
    /// read only where it does.
    pub linux: bool,
    /// cgroup v2 unified is mounted at the cgroup root.
    pub cgroup2: bool,
    /// The controllers the cgroup root delegates, when it is v2.
    pub controllers: Vec<String>,
    /// overlay is a filesystem this kernel knows.
    pub overlay: bool,
    /// This process is root, which is the mode the daemon runs workspaces in on a box.
    pub root: bool,
    /// /dev/kvm is here, so the microVM road is open on this box.
    pub kvm: bool,
    /// The engine a project's own containers would run on.
    pub engine: Engine,
}

/// What the doctor tells the host about this box: enough for the three sentences, no English of its own, since the
/// words a person reads live in one place above the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Doctor {
    /// The daemon runs workspaces here.
    pub runs_workspaces: bool,
    /// When it does not, the one kernel reason, in the same words the self check refuses with.
    pub blocked: Option<String>,
    pub kvm: bool,
    pub engine: Engine,
}

/// The controllers a memory cap and a cpu quota need.
const WANTED_CONTROLLERS: [&str; 2] = ["memory", "cpu"];

/// The doctor's reading of a box, from its facts alone: workspaces run here when the kernel offers cgroup v2 with
/// the controllers a cap needs and an overlay to stack the layers on, and the daemon is root; else the first thing
/// missing is the reason, in the self check's own words so the two never disagree.
pub fn assess(facts: &Facts) -> Doctor {
    let blocked = blocking_reason(facts);
    Doctor { runs_workspaces: blocked.is_none(), blocked, kvm: facts.kvm, engine: facts.engine }
}

fn blocking_reason(facts: &Facts) -> Option<String> {
    if !facts.linux {
        return Some("wsp runs workspaces on a Linux computer, and this computer is not one".to_owned());
    }
    if !facts.cgroup2 {
        return Some(
            "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1".to_owned(),
        );
    }
    for wanted in WANTED_CONTROLLERS {
        if !facts.controllers.iter().any(|c| c == wanted) {
            return Some(format!("this computer's cgroup root offers no {wanted} controller, which wsp needs to run workspaces here"));
        }
    }
    if !facts.overlay {
        return Some("this computer's kernel has no overlay filesystem, which wsp stacks a workspace's layers on".to_owned());
    }
    if !facts.root {
        return Some("wsp runs workspaces on this computer as root, and this daemon is not root".to_owned());
    }
    None
}

/// The facts read off this box: nothing is mounted or created, so it costs a few file reads and can run at every
/// dial. Off Linux only the engine is read; the rest stand false, and the doctor names Linux as the reason a
/// workspace does not run here, since youki's kernel work has no answer on another kernel.
pub fn read_facts() -> Facts {
    let engine = engine_on_path(&std::env::var("PATH").unwrap_or_default());
    #[cfg(target_os = "linux")]
    {
        let controllers = std::fs::read_to_string(Path::new(CGROUP_ROOT).join("cgroup.controllers"));
        let cgroup2 = controllers.is_ok();
        Facts {
            linux: true,
            cgroup2,
            controllers: controllers.map(|text| text.split_whitespace().map(str::to_owned).collect()).unwrap_or_default(),
            overlay: kernel_knows_overlay(),
            root: euid_is_root(),
            kvm: Path::new("/dev/kvm").exists(),
            engine,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        Facts { linux: false, cgroup2: false, controllers: Vec::new(), overlay: false, root: false, kvm: false, engine }
    }
}

/// Whether the kernel lists overlay in /proc/filesystems, built in or as a module already loaded.
#[cfg(target_os = "linux")]
fn kernel_knows_overlay() -> bool {
    std::fs::read_to_string("/proc/filesystems").is_ok_and(|text| text.split_whitespace().any(|word| word == "overlay"))
}

/// The effective uid is root, the mode the daemon runs workspaces in on a box. nix is here on Linux, which is the
/// only target this reads on.
#[cfg(target_os = "linux")]
fn euid_is_root() -> bool {
    nix::unistd::geteuid().is_root()
}

/// The engine a project's containers would run on: Docker where its cli is on the PATH, else podman, else none.
pub fn engine_on_path(path: &str) -> Engine {
    if on_path("docker", path) {
        Engine::Docker
    } else if on_path("podman", path) {
        Engine::Podman
    } else {
        Engine::None
    }
}

pub fn on_path(name: &str, path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.split(':').filter(|dir| !dir.is_empty()).any(|dir| {
        std::fs::metadata(Path::new(dir).join(name)).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_that_runs() -> Facts {
        Facts {
            linux: true,
            cgroup2: true,
            controllers: ["cpuset", "cpu", "io", "memory", "pids"].iter().map(|s| (*s).to_owned()).collect(),
            overlay: true,
            root: true,
            kvm: true,
            engine: Engine::None,
        }
    }

    #[test]
    fn a_box_with_cgroup_v2_the_controllers_an_overlay_and_root_runs_workspaces() {
        let d = assess(&box_that_runs());
        assert!(d.runs_workspaces);
        assert_eq!(d.blocked, None);
        assert!(d.kvm);
        assert_eq!(d.engine, Engine::None);
    }

    #[test]
    fn a_box_on_cgroup_v1_cannot_and_the_reason_names_the_boot_flag() {
        let d = assess(&Facts { cgroup2: false, controllers: vec![], ..box_that_runs() });
        assert!(!d.runs_workspaces);
        assert!(d.blocked.as_deref().unwrap().contains("systemd.unified_cgroup_hierarchy=1"), "{:?}", d.blocked);
    }

    #[test]
    fn a_v2_box_missing_the_memory_controller_cannot_and_the_reason_names_it() {
        let d = assess(&Facts { controllers: ["cpu", "pids"].iter().map(|s| (*s).to_owned()).collect(), ..box_that_runs() });
        assert!(!d.runs_workspaces);
        assert!(d.blocked.as_deref().unwrap().contains("no memory controller"), "{:?}", d.blocked);
    }

    #[test]
    fn a_box_without_an_overlay_or_without_root_cannot_and_each_reason_is_its_own() {
        assert!(assess(&Facts { overlay: false, ..box_that_runs() }).blocked.as_deref().unwrap().contains("overlay filesystem"));
        assert!(assess(&Facts { root: false, ..box_that_runs() }).blocked.as_deref().unwrap().contains("as root"));
    }

    #[test]
    fn the_kvm_and_the_engine_travel_whatever_the_kernel_says_about_workspaces() {
        let d = assess(&Facts { kvm: false, engine: Engine::Docker, ..box_that_runs() });
        assert!(d.runs_workspaces && !d.kvm && d.engine == Engine::Docker);
        assert_eq!(Engine::Podman.word(), "podman");
    }

    #[test]
    fn the_engine_is_read_off_the_path_docker_first_then_podman() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = bin.to_string_lossy().into_owned();
        let put = |name: &str| {
            let p = bin.join(name);
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        };
        assert_eq!(engine_on_path(&path), Engine::None);
        assert_eq!(engine_on_path(""), Engine::None);
        put("podman");
        assert_eq!(engine_on_path(&path), Engine::Podman);
        put("docker");
        assert_eq!(engine_on_path(&path), Engine::Docker);
    }

    #[test]
    fn read_facts_answers_this_kernel_and_assess_reads_its_own_facts() {
        // read_facts does not panic on this kernel, and assess over what it read agrees with assess over the same
        // facts spelled out: the read and the verdict are one road. self_check calls this pair before it mounts, so
        // the two cannot part ways on a box.
        let facts = read_facts();
        assert_eq!(assess(&facts), assess(&facts.clone()));
        assert_eq!(
            assess(&facts).runs_workspaces,
            facts.linux
                && facts.cgroup2
                && facts.overlay
                && facts.root
                && ["memory", "cpu"].iter().all(|w| facts.controllers.iter().any(|c| c == w))
        );
    }

    #[test]
    fn a_computer_that_is_not_linux_cannot_run_workspaces_and_the_reason_says_so() {
        // The doctor is built for every target the daemon builds for, so it answers a Mac honestly rather than
        // failing to compile: no cgroup and no overlay to read, and Linux named as the reason a workspace does not
        // run there. The engine still travels, since a project's own containers are the box's own affair.
        let d = assess(&Facts {
            linux: false,
            cgroup2: false,
            controllers: vec![],
            overlay: false,
            root: false,
            kvm: false,
            engine: Engine::Docker,
        });
        assert!(!d.runs_workspaces);
        assert!(d.blocked.as_deref().unwrap().contains("Linux computer"), "{:?}", d.blocked);
        assert_eq!(d.engine, Engine::Docker);
    }
}
