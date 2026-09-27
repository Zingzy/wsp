// SPDX-License-Identifier: AGPL-3.0-only
//! The host a call brings up when none serves the state file here: the wsp this server was handed, run as
//! `wsp up --state <file> --port 0 --ws-port 0` in a session of its own with its output on the host's log, and waited
//! on until its lock names a live process that answers on the port the lock records. A child that ends first has
//! said why in the log, and that is the answer. packages/host/src/host-start.ts `hostStarter` is the rule.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;

use crate::aim::{self, Lock};
use crate::failure::Failure;
use crate::record::{self, fill};
use crate::Env;

/// How many of the log's last lines a host that never answered is refused with.
const TAIL_LINES: usize = 20;

pub async fn started(state: &Path, wsp: &[String], env: &Env, say: &mut (dyn FnMut(&str) + Send)) -> Result<Lock, Failure> {
    let names = record::host();
    let words = record::words();
    let Some((program, args)) = wsp.split_first() else {
        return Err(Failure::new(fill(&words.no_host_serving, &[("state", &state.to_string_lossy())])));
    };
    let dir = state.parent().unwrap_or(Path::new("."));
    let log_path = dir.join(&names.files.log);
    let spawned = (|| {
        std::fs::create_dir_all(dir)?;
        let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
        let wrote = log.metadata()?.len();
        let mut up = Command::new(program);
        up.args(args)
            .args(["up", "--state"])
            .arg(state)
            .args(["--port", "0", "--ws-port", "0"])
            .env_clear()
            .envs(env)
            .env(&names.env.started_by, &names.started_by)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        // A session of its own, as node's detached spawn gives the host the command line starts, so a hangup on the
        // agent's terminal is not the host's. SAFETY: setsid is async-signal-safe and touches no memory of ours.
        unsafe {
            up.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        Ok::<_, std::io::Error>((up.spawn()?, wrote))
    })();
    let (mut child, wrote) = spawned.map_err(|e| Failure::new(format!("{program}: {e}")))?;
    let log = log_path.to_string_lossy();
    say(&fill(&words.starting_host, &[("state", &state.to_string_lossy()), ("log", &log)]));
    let deadline = Instant::now() + Duration::from_millis(names.start_wait_ms);
    loop {
        if let Some(lock) = aim::serving(state) {
            if answers(&lock, Duration::from_millis(names.probe_ms)).await {
                return Ok(lock);
            }
        }
        if let Ok(Some(ended)) = child.try_wait() {
            let said = log_lines(&log_path, wrote);
            if !said.is_empty() {
                return Err(Failure::new(said.join("\n")));
            }
            let how = ended.code().map_or_else(|| "a signal".to_owned(), |code| code.to_string());
            return Err(Failure::new(fill(&words.host_exited, &[("state", &state.to_string_lossy()), ("ended", &how), ("log", &log)])));
        }
        if Instant::now() >= deadline {
            let all = log_lines(&log_path, 0);
            let tail = &all[all.len().saturating_sub(TAIL_LINES)..];
            let said = std::iter::once(fill(&words.no_host_answered, &[("state", &state.to_string_lossy())])).chain(tail.iter().cloned());
            return Err(Failure::new(said.collect::<Vec<_>>().join("\n")));
        }
        tokio::time::sleep(Duration::from_millis(names.poll_ms)).await;
    }
}

/// Whether the host a lock names answers where the lock says: the lock is taken before the host binds anything, so
/// the lock alone is a claim, and any answer at all to one GET means something bound the port.
async fn answers(lock: &Lock, within: Duration) -> bool {
    let at = aim::authority(&aim::dial_address(lock), lock.port);
    let asked = async {
        let mut tcp = TcpStream::connect(&at).await.ok()?;
        tcp.write_all(format!("GET / HTTP/1.1\r\nHost: {at}\r\nConnection: close\r\n\r\n").as_bytes()).await.ok()?;
        let mut first = [0u8; 1];
        (tcp.read(&mut first).await.ok()? == 1).then_some(())
    };
    matches!(tokio::time::timeout(within, asked).await, Ok(Some(())))
}

/// The log's non-empty lines past a mark: everything a child that was started there said.
fn log_lines(path: &Path, from: u64) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    let from = usize::try_from(from).unwrap_or(usize::MAX).min(bytes.len());
    String::from_utf8_lossy(&bytes[from..]).lines().filter(|line| !line.trim().is_empty()).map(str::to_owned).collect()
}
