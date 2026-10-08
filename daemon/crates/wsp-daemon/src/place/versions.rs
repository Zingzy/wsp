// SPDX-License-Identifier: AGPL-3.0-only
//! What a program on this computer says of its own version: an agent's line, and the daemon version the wsp this
//! daemon was started with was built with, which says which `wsp leave` this computer runs.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime};

/// How often a running version read is looked in on while its deadline runs.
const VERSION_POLL: Duration = Duration::from_millis(50);
/// What the report carries of the line it printed, as the wire bounds it.
pub(super) const VERSION_LINE_MAX: usize = 64;

/// What a command printed, once it exited inside the deadline; nothing where it would not start or ran past it,
/// in which case it is killed. A spawn that reads text file busy, because another process still holds the binary
/// open for writing, is tried again inside the deadline.
fn output_within(mut command: Command, deadline: Duration) -> Option<Output> {
    let until = Instant::now() + deadline;
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = spawn_unless_busy(until, || command.spawn())?;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < until => std::thread::sleep(VERSION_POLL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
    child.wait_with_output().ok()
}

/// The spawn, tried again every `VERSION_POLL` while it reads text file busy, and never once the deadline has passed.
pub(super) fn spawn_unless_busy<T>(until: Instant, mut spawn: impl FnMut() -> std::io::Result<T>) -> Option<T> {
    loop {
        match spawn() {
            Ok(child) => return Some(child),
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => std::thread::sleep(VERSION_POLL),
            Err(_) => return None,
        }
        if Instant::now() >= until {
            return None;
        }
    }
}

/// What `<bin> --version` printed: the first line it said that is not blank, trimmed and cut to what the report
/// carries. Both streams are read, stdout first: a tool that prints its version on stderr would otherwise read as
/// nothing and be run again at every dial, a process per dial where the point of this is one stat. Nothing where
/// the binary would not start or said nothing inside the deadline, which the next dial reads again. The exit code
/// is not read: what a tool printed about itself is the fact, and some print it and exit non-zero.
pub(super) fn version_line(at: &Path, deadline: Duration) -> Option<String> {
    let mut command = Command::new(at);
    command.arg("--version");
    let out = output_within(command, deadline)?;
    let streams = [String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)];
    let said = streams.iter().flat_map(|stream| stream.lines()).map(str::trim).find(|line| !line.is_empty())?;
    Some(said.chars().take(VERSION_LINE_MAX).collect())
}

/// A file the wsp's words name, as it stood when it was read: a reinstall under a running daemon moves one of them.
type Stamp = (PathBuf, Option<(u64, Option<SystemTime>)>);

/// The daemon version the wsp this daemon was started with was built with, held between dials against the files its
/// words name and read again where one of them moved. A wsp that answered with no such version (every wsp older than
/// the question) is held as that; one that would not start or ran past the deadline is asked again at the next dial.
#[derive(Debug, Default)]
pub(crate) struct WspBuild {
    held: Option<(Vec<Stamp>, Option<u32>)>,
}

impl WspBuild {
    /// Asks the wsp where its files moved since the last answer, and answers what it said.
    pub(crate) fn refresh(&mut self, argv: &[String], deadline: Duration) -> Option<u32> {
        let stamps = stamps_of(argv);
        match &self.held {
            Some((held, said)) if *held == stamps => *said,
            _ => {
                let said = build_said(argv, deadline);
                self.held = said.map(|said| (stamps, said));
                said.flatten()
            }
        }
    }
}

fn stamps_of(argv: &[String]) -> Vec<Stamp> {
    argv.iter()
        .map(Path::new)
        .filter(|word| word.is_absolute())
        .map(|word| {
            let meta = std::fs::metadata(word).ok();
            (word.to_path_buf(), meta.map(|m| (m.len(), m.modified().ok())))
        })
        .collect()
}

/// What `<wsp> --version --json` answered: the outer None where it did not answer at all, the inner where it answered
/// with no daemon version, which is what a wsp from before the question prints (its version line, or a refusal).
fn build_said(argv: &[String], deadline: Duration) -> Option<Option<u32>> {
    let (program, words) = argv.split_first()?;
    let mut command = Command::new(program);
    command.args(words).args(["--version", "--json"]);
    let out = output_within(command, deadline)?;
    let daemon = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find_map(|said| said.get("daemon")?.as_u64().and_then(|n| u32::try_from(n).ok()));
    Some(daemon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn wsp_at(dir: &Path, body: &str) -> PathBuf {
        let at = dir.join("wsp");
        std::fs::write(&at, format!("#!/bin/sh\necho ran >> {}\n{body}\n", dir.join("runs").display())).unwrap();
        std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
        at
    }

    fn ran(dir: &Path) -> usize {
        std::fs::read_to_string(dir.join("runs")).map(|s| s.lines().count()).unwrap_or(0)
    }

    #[test]
    fn reads_the_daemon_version_a_wsp_was_built_with_and_none_off_one_that_says_only_its_number() {
        let dir = tempfile::tempdir().unwrap();
        let argv = |at: &Path| vec![at.to_string_lossy().into_owned()];
        let mut build = WspBuild::default();

        // This build's wsp, which answers the question on stdout as one JSON line.
        let at = wsp_at(dir.path(), r#"[ "$1 $2" = "--version --json" ] && echo '{"version":"0.2.1","daemon":136}'"#);
        assert_eq!(build.refresh(&argv(&at), Duration::from_secs(5)), Some(136));
        assert_eq!(build.refresh(&argv(&at), Duration::from_secs(5)), Some(136));
        assert_eq!(ran(dir.path()), 1, "a wsp whose files did not move was asked again");

        // An older wsp prints its version line and nothing a gate could read, and is held as that.
        let older = tempfile::tempdir().unwrap();
        let at = wsp_at(older.path(), "echo 'wsp 0.2.0'");
        assert_eq!(build.refresh(&argv(&at), Duration::from_secs(5)), None);
        assert_eq!(build.refresh(&argv(&at), Duration::from_secs(5)), None);
        assert_eq!(ran(older.path()), 1);

        // One that refuses the flag the same.
        let refusing = tempfile::tempdir().unwrap();
        let at = wsp_at(refusing.path(), "echo 'unknown option --json' 1>&2; exit 3");
        assert_eq!(build.refresh(&argv(&at), Duration::from_secs(5)), None);
    }

    #[test]
    fn a_wsp_that_will_not_answer_says_no_version_and_is_asked_again_at_the_next_dial() {
        let dir = tempfile::tempdir().unwrap();
        let at = wsp_at(dir.path(), "sleep 30");
        let argv = vec![at.to_string_lossy().into_owned()];
        let mut build = WspBuild::default();
        let began = Instant::now();
        assert_eq!(build.refresh(&argv, Duration::from_millis(300)), None);
        assert!(began.elapsed() < Duration::from_secs(5), "the read waited past its deadline");
        assert_eq!(build.refresh(&argv, Duration::from_millis(300)), None);
        assert_eq!(ran(dir.path()), 2);

        // A wsp that is not there at all, and words that name nothing to run.
        assert_eq!(build.refresh(&[dir.path().join("gone").to_string_lossy().into_owned()], Duration::from_secs(5)), None);
        assert_eq!(build.refresh(&[], Duration::from_secs(5)), None);
    }

    #[test]
    fn a_wsp_reinstalled_under_a_running_daemon_is_asked_again() {
        let dir = tempfile::tempdir().unwrap();
        let at = wsp_at(dir.path(), "echo 'wsp 0.2.0'");
        let argv = vec![at.to_string_lossy().into_owned()];
        let mut build = WspBuild::default();
        assert_eq!(build.refresh(&argv, Duration::from_secs(5)), None);
        wsp_at(dir.path(), r#"echo '{"version":"0.2.1","daemon":136}'"#);
        assert_eq!(build.refresh(&argv, Duration::from_secs(5)), Some(136));
    }
}
