// SPDX-License-Identifier: AGPL-3.0-only
//! The freezer, written and read at the workspace's cgroup: youki's own pause looks for the cgroup under the raw
//! path the spec names and misses it under a manager that moved it, and writing cgroup.freeze costs nothing. The
//! path is the plain manager's, which the layout spells; nothing here reads a cgroup off a pid, since a pid can
//! belong to another process by the time it is read.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Where cgroup v2 is mounted.
pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// How long a freeze or a thaw gets to show in cgroup.events before it is called failed.
const SETTLE: Duration = Duration::from_secs(5);

/// Whether cgroup.events says frozen.
pub fn frozen(cgroup: &Path) -> io::Result<bool> {
    let events = fs::read_to_string(cgroup.join("cgroup.events"))?;
    Ok(events.lines().any(|line| line.trim() == "frozen 1"))
}

/// Freezes and waits for cgroup.events to agree, off the daemon's one runtime thread: a workspace mid heavy IO
/// takes a while to freeze, and nothing else the daemon serves may wait behind it.
pub async fn freeze(cgroup: PathBuf) -> io::Result<()> {
    set_frozen_off_thread(cgroup, true, SETTLE).await
}

pub async fn thaw(cgroup: PathBuf) -> io::Result<()> {
    set_frozen_off_thread(cgroup, false, SETTLE).await
}

async fn set_frozen_off_thread(cgroup: PathBuf, want: bool, patience: Duration) -> io::Result<()> {
    tokio::task::spawn_blocking(move || set_frozen(&cgroup, want, patience)).await.map_err(|e| io::Error::other(e.to_string()))?
}

fn set_frozen(cgroup: &Path, want: bool, patience: Duration) -> io::Result<()> {
    fs::write(cgroup.join("cgroup.freeze"), if want { "1" } else { "0" })?;
    let started = Instant::now();
    while frozen(cgroup)? != want {
        if started.elapsed() > patience {
            return Err(io::Error::other(format!(
                "{} did not read frozen {} in {} s",
                cgroup.display(),
                u8::from(want),
                patience.as_secs()
            )));
        }
        sleep(Duration::from_millis(1));
    }
    Ok(())
}

/// Waits until cgroup.events says no process is left, or the cgroup is gone; killed processes take a moment to
/// leave, and the cgroup cannot be removed before they have.
pub fn wait_unpopulated(cgroup: &Path, patience: Duration) -> io::Result<()> {
    let started = Instant::now();
    loop {
        match fs::read_to_string(cgroup.join("cgroup.events")) {
            Ok(events) if events.lines().any(|line| line.trim() == "populated 0") => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        if started.elapsed() > patience {
            return Err(io::Error::other(format!("{} still holds processes after {} s", cgroup.display(), patience.as_secs())));
        }
        sleep(Duration::from_millis(2));
    }
}

/// No swap for a workspace: the memory cap is the cap, so a hog is killed instead of slowing the box. A box with
/// swap accounting off has no memory.swap.max to write and no swap to forbid.
pub fn forbid_swap(cgroup: &Path) -> io::Result<()> {
    match fs::write(cgroup.join("memory.swap.max"), "0") {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// memory.current in bytes.
pub fn memory_current(cgroup: &Path) -> io::Result<u64> {
    let text = fs::read_to_string(cgroup.join("memory.current"))?;
    text.trim().parse().map_err(|e| io::Error::other(format!("memory.current: {e}")))
}

/// cpu.stat's usage_usec.
pub fn cpu_usage_usec(cgroup: &Path) -> io::Result<u64> {
    let text = fs::read_to_string(cgroup.join("cpu.stat"))?;
    text.lines()
        .find_map(|line| line.strip_prefix("usage_usec ").and_then(|v| v.trim().parse().ok()))
        .ok_or_else(|| io::Error::other("cpu.stat carries no usage_usec"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_box_without_swap_accounting_has_no_swap_to_forbid() {
        let dir = tempfile::tempdir().unwrap();
        forbid_swap(dir.path()).unwrap();
        fs::write(dir.path().join("memory.swap.max"), "max").unwrap();
        forbid_swap(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("memory.swap.max")).unwrap(), "0");
        assert!(forbid_swap(Path::new("/proc/no-such-cgroup-here/x")).is_ok());
    }

    #[tokio::test]
    async fn the_freezer_waits_off_the_runtime_thread() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("cgroup.freeze"), "0").unwrap();
        fs::write(dir.path().join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counting = std::sync::Arc::clone(&ticks);
        let ticker = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(1)).await;
                counting.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
        // A cgroup that never reads frozen: the wait runs its whole patience, and the runtime keeps ticking meanwhile.
        let waited = set_frozen_off_thread(dir.path().to_path_buf(), true, Duration::from_millis(300)).await;
        ticker.abort();
        assert!(waited.is_err());
        assert_eq!(fs::read_to_string(dir.path().join("cgroup.freeze")).unwrap(), "1");
        assert!(
            ticks.load(std::sync::atomic::Ordering::Relaxed) >= 20,
            "the runtime thread was held: {} ticks",
            ticks.load(std::sync::atomic::Ordering::Relaxed)
        );
    }

    #[test]
    fn frozen_reads_the_events_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        assert!(!frozen(dir.path()).unwrap());
        fs::write(dir.path().join("cgroup.events"), "populated 1\nfrozen 1\n").unwrap();
        assert!(frozen(dir.path()).unwrap());
        fs::write(dir.path().join("cpu.stat"), "usage_usec 4200\nuser_usec 1\n").unwrap();
        assert_eq!(cpu_usage_usec(dir.path()).unwrap(), 4200);
    }
}
