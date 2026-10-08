// SPDX-License-Identifier: AGPL-3.0-only
//! Whose listeners one port watch sees: its roots, its folder and its cgroups, or the whole machine, and the name a
//! watch of its own on a socket carries on every event it sends.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use wsp_frames::DaemonEvent;

/// The cgroup v2 path each of these processes stands in, off /proc/[pid]/cgroup; a process it cannot read, and every
/// process on a computer with no /proc, is left out.
pub(crate) type CgroupSource = Arc<dyn Fn(Vec<u32>) -> Pin<Box<dyn Future<Output = HashMap<u32, String>> + Send>> + Send + Sync>;

/// The road for this daemon: a fake /proc when one is given, /proc on Linux, and none elsewhere.
pub(crate) fn cgroup_for(proc_root: Option<&Path>) -> CgroupSource {
    let root = match proc_root {
        Some(root) => root.to_path_buf(),
        None if cfg!(target_os = "linux") => PathBuf::from("/proc"),
        None => return Arc::new(|_| Box::pin(async { HashMap::new() })),
    };
    Arc::new(move |pids: Vec<u32>| {
        let root = root.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                pids.into_iter().filter_map(|pid| crate::proc::read_cgroup(&root.join(pid.to_string())).map(|c| (pid, c))).collect()
            })
            .await
            .unwrap_or_default()
        })
    })
}

/// Whether a process's cgroup is one of these or under one of them.
pub(super) fn in_cgroups(cgroup: Option<&String>, cgroups: &[String]) -> bool {
    cgroup.is_some_and(|c| cgroups.iter().any(|g| c == g || c.strip_prefix(g.as_str()).is_some_and(|rest| rest.starts_with('/'))))
}

/// Whose listeners one watch sees.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Scope {
    /// Every listener: what a watch that names no roots sees, the host's own watchers among them, and a cloud
    /// machine, which is the workspace's whole.
    Everything,
    /// The listeners of the processes these roots hold, with a folder, of every process running in it, and of every
    /// process standing in one of these cgroups.
    Roots { roots: Vec<u32>, folder: Option<PathBuf>, cgroups: Vec<String> },
}

impl Scope {
    /// What a ports.watch asks for: with roots, theirs, the folder's and the cgroups'; without, every listener.
    pub(crate) fn of(roots: Option<Vec<u32>>, folder: Option<String>, cgroups: Vec<String>) -> Scope {
        // Held as the kernel names it, so a cwd read off /proc or lsof compares with it whatever links led there.
        let folder = folder.map(|f| std::fs::canonicalize(&f).unwrap_or_else(|_| PathBuf::from(f)));
        match roots {
            Some(roots) => Scope::Roots { roots, folder, cgroups },
            None => Scope::Everything,
        }
    }
}

/// An event as a named watch sends it: with its watch's name, so a socket holding several tells them apart.
pub(super) fn named(event: DaemonEvent, name: Option<&String>) -> DaemonEvent {
    let Some(name) = name else { return event };
    match event {
        DaemonEvent::PortOpen { port, pid, process, loopback, .. } => {
            DaemonEvent::PortOpen { port, pid, process, loopback, watch: Some(name.clone()) }
        }
        DaemonEvent::PortClose { port, pid, process, command, exited, left, at, .. } => {
            DaemonEvent::PortClose { port, pid, process, command, exited, left, at, watch: Some(name.clone()) }
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixed, no_cwd, out, quiet, row, until};
    use super::super::{Lineage, LineageSource, ListeningPort, PortWatch, DEFAULT_INTERVAL};
    use super::*;
    use std::sync::Mutex;

    #[tokio::test(start_paused = true)]
    async fn a_watch_sees_what_its_roots_hold_and_one_that_names_none_sees_the_whole_machine() {
        let snapshot = Arc::new(Mutex::new(vec![
            row(4000, Some(100), 1, 0, true),
            row(4001, Some(201), 2, 0, true),
            row(4002, Some(301), 3, 0, true),
        ]));
        // One host (100) running a turn for each of two workspaces; A's server made a group of its own under its turn.
        let table = vec![
            Lineage { pid: 100, ppid: 1, pgid: 100 },
            Lineage { pid: 200, ppid: 100, pgid: 200 },
            Lineage { pid: 201, ppid: 200, pgid: 201 },
            Lineage { pid: 300, ppid: 100, pgid: 300 },
            Lineage { pid: 301, ppid: 300, pgid: 300 },
        ];
        let lineage: LineageSource = Arc::new(move || {
            let table = table.clone();
            Box::pin(async move { table })
        });
        let watch = Arc::new(PortWatch::new(fixed(snapshot), lineage, no_cwd(), DEFAULT_INTERVAL));
        let ports = |seen: Vec<ListeningPort>| seen.iter().map(|p| p.port).collect::<Vec<_>>();
        assert_eq!(ports(watch.watch(1, out().0, Scope::of(Some(vec![200]), None, vec![]), None, quiet()).await.0), [4001]);
        assert_eq!(ports(watch.watch(2, out().0, Scope::of(Some(vec![300]), None, vec![]), None, quiet()).await.0), [4002]);
        assert_eq!(
            ports(watch.watch(3, out().0, Scope::of(None, None, vec![]), None, quiet()).await.0),
            [4000, 4001, 4002],
            "the host's own watchers see every listener"
        );
        assert_eq!(
            ports(watch.watch(4, out().0, Scope::of(Some(vec![100]), None, vec![]), None, quiet()).await.0),
            [4000, 4001, 4002],
            "the host holds every workspace"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn one_socket_holds_a_watch_per_name_each_seeing_its_own_roots_and_naming_itself_on_what_it_sends() {
        let snapshot = Arc::new(Mutex::new(vec![]));
        let table = vec![
            Lineage { pid: 200, ppid: 1, pgid: 200 },
            Lineage { pid: 201, ppid: 200, pgid: 201 },
            Lineage { pid: 300, ppid: 1, pgid: 300 },
        ];
        let lineage: LineageSource = Arc::new(move || {
            let table = table.clone();
            Box::pin(async move { table })
        });
        let watch = Arc::new(PortWatch::new(fixed(Arc::clone(&snapshot)), lineage, no_cwd(), DEFAULT_INTERVAL));
        // One socket, as a computer's one link to its host is: two folders' watches on it, keyed apart.
        let (o, mut rx) = out();
        let start = tokio::time::Instant::now();
        watch.watch(10, o.clone(), Scope::of(Some(vec![200]), None, vec![]), Some("ws_a".to_owned()), quiet()).await;
        watch.watch(11, o, Scope::of(Some(vec![300]), None, vec![]), Some("ws_b".to_owned()), quiet()).await;
        snapshot.lock().unwrap().extend([row(8080, Some(201), 1, 0, true), row(3000, Some(300), 2, 0, true)]);
        until(start, 5_100).await;
        let mut sent = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(frame.text()).unwrap();
            sent.push((v["port"].as_u64().unwrap(), v["watch"].as_str().unwrap().to_owned()));
        }
        sent.sort();
        assert_eq!(sent, [(3000, "ws_b".to_owned()), (8080, "ws_a".to_owned())]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_a_thread_detached_out_of_its_group_and_its_folder_is_still_its_own_by_its_cgroup() {
        // 200 leads the turn's group; 900 is a server it detached with setsid, a group of its own under init, running
        // in /tmp; 950 is somebody else's under the same init.
        let snapshot = Arc::new(Mutex::new(vec![row(8080, Some(900), 1, 0, true), row(9090, Some(950), 2, 0, true)]));
        let table = vec![
            Lineage { pid: 200, ppid: 1, pgid: 200 },
            Lineage { pid: 900, ppid: 1, pgid: 900 },
            Lineage { pid: 950, ppid: 1, pgid: 950 },
        ];
        let lineage: LineageSource = Arc::new(move || {
            let table = table.clone();
            Box::pin(async move { table })
        });
        let cgroups: CgroupSource = Arc::new(|pids: Vec<u32>| {
            Box::pin(async move {
                let of = |pid: u32| match pid {
                    900 => Some("/wsp-threads/t1/run".to_owned()),
                    950 => Some("/wsp-threads/t10".to_owned()),
                    _ => None,
                };
                pids.into_iter().filter_map(|pid| of(pid).map(|c| (pid, c))).collect()
            })
        });
        let watch = Arc::new(PortWatch::new(fixed(snapshot), lineage, no_cwd(), DEFAULT_INTERVAL).with_cgroups(cgroups));
        let ports = |seen: Vec<ListeningPort>| seen.iter().map(|p| p.port).collect::<Vec<_>>();
        let (o, _rx) = out();
        let held = watch
            .watch(1, o.clone(), Scope::of(Some(vec![200]), None, vec!["/wsp-threads/t1".to_owned()]), Some("ws_a".to_owned()), quiet())
            .await;
        assert_eq!(ports(held.0), [8080], "t10 is not under t1, however its name begins");
        let without = watch.watch(1, o, Scope::of(Some(vec![200]), None, vec![]), Some("ws_a".to_owned()), quiet()).await;
        assert_eq!(ports(without.0), Vec::<u16>::new());
    }

    #[tokio::test(start_paused = true)]
    async fn a_port_that_leaves_a_watch_while_it_still_listens_closes_as_left_and_one_that_stopped_does_not() {
        let snapshot = Arc::new(Mutex::new(vec![row(4202, Some(202), 1, 0, true), row(4203, Some(203), 2, 0, true)]));
        let table = vec![
            Lineage { pid: 200, ppid: 1, pgid: 200 },
            Lineage { pid: 202, ppid: 1, pgid: 200 },
            Lineage { pid: 203, ppid: 1, pgid: 200 },
        ];
        let lineage: LineageSource = Arc::new(move || {
            let table = table.clone();
            Box::pin(async move { table })
        });
        let watch = Arc::new(PortWatch::new(fixed(Arc::clone(&snapshot)), lineage, no_cwd(), DEFAULT_INTERVAL));
        let (o, mut rx) = out();
        watch.watch(1, o.clone(), Scope::of(Some(vec![200]), None, vec![]), None, quiet()).await;
        snapshot.lock().unwrap().retain(|r| r.port != 4203);
        // The turn's group stops being a root: 4202 still listens, held by a process that is no longer the workspace's.
        watch.watch(1, o, Scope::of(Some(vec![]), None, vec![]), None, quiet()).await;
        let mut closes = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(frame.text()).unwrap();
            closes.push((v["port"].as_u64().unwrap(), v.get("left").cloned()));
        }
        closes.sort_by_key(|(port, _)| *port);
        assert_eq!(closes, [(4202, Some(serde_json::json!(true))), (4203, None)]);
    }
}
