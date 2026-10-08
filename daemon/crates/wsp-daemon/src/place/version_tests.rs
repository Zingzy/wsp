// SPDX-License-Identifier: AGPL-3.0-only
//! The agents' version reads: one read per binary as it stands, on the tools PATH, inside a deadline.
use super::versions::{spawn_unless_busy, VERSION_LINE_MAX};
use super::*;
use std::time::Instant;

/// A binary that prints a line and records that it ran, so a second read can be told from a held one.
fn fake_bin(dir: &Path, name: &str, prints: &str, counter: &Path) -> PathBuf {
    let at = dir.join(name);
    std::fs::write(&at, format!("#!/bin/sh\necho ran >> {}\necho '{prints}'\n", counter.display())).unwrap();
    std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    at
}

fn ran(counter: &Path) -> usize {
    std::fs::read_to_string(counter).map(|t| t.lines().count()).unwrap_or(0)
}

#[test]
fn an_agents_version_is_read_once_and_again_only_when_its_binary_moved() {
    let dir = tempfile::tempdir().unwrap();
    let counter = dir.path().join("runs");
    let bin = fake_bin(dir.path(), "claude", "2.1.270 (Claude Code)", &counter);
    let path = dir.path().to_string_lossy().into_owned();
    let agents = parse_agents(&["claude=claude".to_owned()]);
    let mut held = AgentVersions::default();

    held.refresh(&agents, &path, VERSION_DEADLINE);
    assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.270 (Claude Code)"));
    assert_eq!(ran(&counter), 1);

    // Nothing moved, so the dial costs one stat and the line already read stands.
    held.refresh(&agents, &path, VERSION_DEADLINE);
    assert_eq!(ran(&counter), 1, "a dial where nothing moved ran the binary again");
    assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.270 (Claude Code)"));

    // An update that replaces the binary is what the report has to follow, and the daemon is not restarted by
    // one: the file's own size and modification time are what says it happened.
    fake_bin(dir.path(), "claude", "2.1.280 (Claude Code) and then some", &counter);
    held.refresh(&agents, &path, VERSION_DEADLINE);
    assert_eq!(ran(&counter), 2);
    assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.280 (Claude Code) and then some"));

    // The same bytes at another modification time are read again too: a build dropped in by hand says nothing
    // about its size.
    let file = std::fs::File::options().write(true).open(&bin).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000))).unwrap();
    drop(file);
    held.refresh(&agents, &path, VERSION_DEADLINE);
    assert_eq!(ran(&counter), 3);

    // An agent off the PATH drops off the report rather than keeping the version of a binary that is gone.
    std::fs::remove_file(&bin).unwrap();
    held.refresh(&agents, &path, VERSION_DEADLINE);
    assert!(held.lines().is_empty());
}

/// The agents are looked for where the recipe puts the tools, not where this daemon's unit looks: a place
/// daemon runs under a service unit whose PATH is the distribution's default, and an agent installed by
/// Homebrew or by its own installer under /root/.local/bin is on no line of it.
#[test]
fn the_agents_are_read_on_the_tools_path_before_the_units_own() {
    let tools = tempfile::tempdir().unwrap();
    let counter = tools.path().join("runs");
    fake_bin(tools.path(), "claude", "2.1.270 (Claude Code)", &counter);
    let agents = parse_agents(&["claude=claude".to_owned()]);
    // The unit's PATH on its own, which is the hole: the agent is on no report at all.
    assert!(agents_on(&agents, "/nonexistent").is_empty());

    // The list the presence read takes: the agent stands on the row.
    let path = presence_path_over(&tools.path().to_string_lossy(), "/nonexistent");
    assert_eq!(agents_on(&agents, &path), vec!["claude".to_owned()]);

    // The tools first: a command on both lists is read from where a thread inside a workspace would run it.
    let unit = tempfile::tempdir().unwrap();
    fake_bin(unit.path(), "claude", "0.0.1 (the unit's own)", &counter);
    let both = presence_path_over(&tools.path().to_string_lossy(), &unit.path().to_string_lossy());
    assert_eq!(found_at("claude", &both), Some(tools.path().join("claude")));

    // And what this daemon hands that read is that one list over the PATH its unit gave it, in that order.
    let live = presence_path(Some("/nonexistent"));
    assert!(live.starts_with(numbers::TOOLS_PATH), "{live}");
    assert!(live.ends_with("/nonexistent"), "{live}");
    assert_eq!(presence_path(None), numbers::TOOLS_PATH);
    assert_eq!(presence_path(Some("")), numbers::TOOLS_PATH);
}

/// The one rule this daemon holds to on a computer that runs workspaces: a command it runs is never resolved
/// through a directory under the home those workspaces write. A binary planted there still stands on the row,
/// since reading that a file is there runs nothing, and the version beside it comes from the copy outside.
#[test]
fn a_binary_planted_under_the_home_stands_on_the_row_and_is_never_run() {
    let home = tempfile::tempdir().unwrap();
    let planted_dir = home.path().join(".local/bin");
    std::fs::create_dir_all(&planted_dir).unwrap();
    let planted_ran = home.path().join("planted-ran");
    fake_bin(&planted_dir, "claude", "9.9.9 (planted)", &planted_ran);
    let system = tempfile::tempdir().unwrap();
    let system_ran = system.path().join("runs");
    fake_bin(system.path(), "claude", "2.1.270 (Claude Code)", &system_ran);
    let agents = parse_agents(&["claude=claude".to_owned()]);
    // The tools list as it reads on a box: the home's own directory first, the system's behind it.
    let tools = format!("{}:{}", planted_dir.display(), system.path().display());
    assert_eq!(agents_on(&agents, &presence_path_over(&tools, "")), vec!["claude".to_owned()]);
    // The probe list is that list with every directory under the home taken out, which for this home leaves
    // the system's alone; the rule that builds it from the tools PATH is held to the protocol's by the
    // contract fixture, and what is read here is what the version read does with it.
    let probe = system.path().to_string_lossy().into_owned();
    let mut held = AgentVersions::default();
    held.refresh(&agents, &probe, VERSION_DEADLINE);
    assert_eq!(held.lines().get("claude").map(String::as_str), Some("2.1.270 (Claude Code)"));
    assert!(!planted_ran.exists(), "the binary under the home was run");
    assert!(system_ran.exists());
}

#[test]
fn a_version_read_that_hangs_costs_its_deadline_and_says_nothing_for_that_agent() {
    let dir = tempfile::tempdir().unwrap();
    let at = dir.path().join("codex");
    std::fs::write(&at, "#!/bin/sh\nsleep 30\n").unwrap();
    std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let mut held = AgentVersions::default();
    let began = Instant::now();
    held.refresh(&parse_agents(&["codex=codex".to_owned()]), &dir.path().to_string_lossy(), Duration::from_millis(300));
    assert!(held.lines().is_empty());
    assert!(began.elapsed() < Duration::from_secs(5), "the read waited past its deadline");
    // A line cut at the wire's bound, so a binary that prints a paragraph cannot refuse the whole report.
    let counter = dir.path().join("runs");
    fake_bin(dir.path(), "long", &"v".repeat(200), &counter);
    held.refresh(&parse_agents(&["long=long".to_owned()]), &dir.path().to_string_lossy(), VERSION_DEADLINE);
    assert_eq!(held.lines()["long"].len(), VERSION_LINE_MAX);
}

/// A binary somebody still holds open for writing, as a fork of another thread does until it execs, makes its
/// exec read text file busy: the read waits for it to close inside the deadline rather than saying nothing.
#[test]
fn a_binary_held_open_for_writing_at_the_first_spawn_still_gives_its_version_line() {
    let dir = tempfile::tempdir().unwrap();
    let counter = dir.path().join("runs");
    let at = fake_bin(dir.path(), "busy", "busy 1.2.3", &counter);
    let writer = std::fs::OpenOptions::new().write(true).open(&at).unwrap();
    let closes = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        drop(writer);
    });
    assert_eq!(version_line(&at, VERSION_DEADLINE).as_deref(), Some("busy 1.2.3"));
    closes.join().unwrap();
    assert_eq!(ran(&counter), 1);
}

/// A binary that stays busy is tried until the deadline and never once after it: an agent's CLI started past
/// the deadline would only be killed by the wait that follows.
#[test]
fn a_busy_spawn_is_never_tried_past_its_deadline() {
    let until = Instant::now() + Duration::from_millis(120);
    let mut tries = Vec::new();
    let got: Option<()> = spawn_unless_busy(until, || {
        tries.push(Instant::now());
        Err(std::io::Error::from(std::io::ErrorKind::ExecutableFileBusy))
    });
    assert_eq!(got, None);
    assert!(tries.len() > 1, "the busy spawn was not tried again");
    assert!(tries.iter().all(|at| *at < until), "a spawn was tried {:?} past the deadline", tries.last().unwrap().duration_since(until));
}

/// A tool that says its version on stderr is read like any other. Reading stdout alone would leave it with no
/// line at all, so every dial would run it again: a process per dial where the whole point is one stat.
#[test]
fn a_version_printed_on_stderr_is_read_once_like_any_other() {
    let dir = tempfile::tempdir().unwrap();
    let counter = dir.path().join("runs");
    let at = dir.path().join("noisy");
    std::fs::write(&at, format!("#!/bin/sh\necho ran >> {}\necho '' \necho 'noisy 4.5.6' 1>&2\n", counter.display())).unwrap();
    std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let agents = parse_agents(&["noisy=noisy".to_owned()]);
    let path = dir.path().to_string_lossy().into_owned();
    let mut held = AgentVersions::default();
    held.refresh(&agents, &path, VERSION_DEADLINE);
    assert_eq!(held.lines().get("noisy").map(String::as_str), Some("noisy 4.5.6"));
    assert_eq!(ran(&counter), 1);
    held.refresh(&agents, &path, VERSION_DEADLINE);
    assert_eq!(ran(&counter), 1, "a version read off stderr was read again at the next dial");

    // What a tool printed on stdout is still what the report carries, whatever it put on stderr beside it.
    let both = dir.path().join("both");
    std::fs::write(&both, "#!/bin/sh\necho 'warning: old config' 1>&2\necho 'both 1.2.3'\n").unwrap();
    std::fs::set_permissions(&both, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    held.refresh(&parse_agents(&["both=both".to_owned()]), &path, VERSION_DEADLINE);
    assert_eq!(held.lines().get("both").map(String::as_str), Some("both 1.2.3"));
}
