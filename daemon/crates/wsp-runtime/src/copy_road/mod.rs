// SPDX-License-Identifier: AGPL-3.0-only
//! How a workspace on the computer somebody sits at is made: a copy of the project folder at a path of its own,
//! by whichever road this computer has, then made a clean checkout by two rules. One module per road and one list
//! of them in the order they are tried, so adding a road is its module and its row here. The roads answer whether
//! they can be taken rather than being picked off a filesystem's name, and the reason a road was passed over rides
//! the report, since a person who asked for a directory clone and got a worktree is owed the sentence.

pub mod rules;
pub mod worktree;

#[cfg(target_os = "macos")]
pub mod clonefile;

use std::io;
use std::path::Path;
use std::time::Instant;

use wsp_frames::{Carried, CopyAsk, CopyReport, CopyRoadName};

pub use rules::Walked;

/// Whether a road can be taken here, and the sentence when it cannot.
pub enum Availability {
    Yes,
    No(String),
}

/// One way of making a copy of a folder at another path on this computer.
pub trait CopyRoad: Sync {
    fn name(&self) -> CopyRoadName;
    /// Whether this road can make `to` from `from` here: the volume, the free space, the size line.
    fn available(&self, from: &Path, to: &Path, walked: &Walked, size_line_bytes: u64) -> Availability;
    /// Makes `to`; any failure leaves no `to` behind.
    fn make(&self, from: &Path, to: &Path, base: &str) -> io::Result<()>;
    fn remove(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// What the road carried into the copy, for the report and the row.
    fn carried(&self) -> Carried;
}

/// The roads this platform has, first choice first. A computer that runs workspaces of its own has none: a
/// workspace there is a fork of an image with the project copied into it, which is the runtime's road and not
/// this one.
#[cfg(target_os = "macos")]
pub const ROADS: &[&dyn CopyRoad] = &[&clonefile::Clonefile, &worktree::Worktree];
#[cfg(not(target_os = "macos"))]
pub const ROADS: &[&dyn CopyRoad] = &[];

/// What a computer with no road of its own answers, whichever half of the verb was asked.
pub const NOT_THIS_COMPUTER: &str = "this computer copies through its workspace runtime; wsp-daemon copy serves a Mac";

/// Why a folder that is not a repo is not a project.
pub fn not_a_repo(from: &Path) -> String {
    format!("{} is not a git repository; a project is a repo", from.display())
}

/// Why a path that is already there is not where a copy goes.
pub fn already_there(to: &Path) -> String {
    format!("{} is already there; a copy is made at a path of its own", to.display())
}

/// The road of a name, for a remove that reads the road off the record rather than asking the disk again.
pub fn road_named(name: CopyRoadName) -> Option<&'static dyn CopyRoad> {
    ROADS.iter().copied().find(|road| road.name() == name)
}

/// The copy, end to end: the folder read once, a road picked or taken as named, the copy made, then the two rules
/// that make it a clean checkout of the base. Anything that fails after the copy exists takes the copy with it, so
/// a refusal never leaves a folder that looks like a workspace and is not one.
pub fn make(ask: &CopyAsk) -> Result<CopyReport, String> {
    let started = Instant::now();
    let from = Path::new(&ask.from);
    let to = Path::new(&ask.to);
    if ROADS.is_empty() {
        return Err(NOT_THIS_COMPUTER.to_owned());
    }
    if !rules::is_repo_top(from) {
        return Err(not_a_repo(from));
    }
    if to.exists() {
        return Err(already_there(to));
    }
    let walked = rules::walk(from);
    let branch = ask.base.clone().unwrap_or_else(|| rules::default_branch(from));
    // The branch as the folder holds it, else as the remote holds it: a folder cloned with one branch checked out
    // still copies at the branch its remote calls its own HEAD.
    let base = rules::sha_of(from, &branch)
        .or_else(|| rules::sha_of(from, &format!("origin/{branch}")))
        .ok_or_else(|| format!("{} has no {branch} to copy", from.display()))?;
    let (road, fell_back) = pick(from, to, &walked, ask)?;
    road.make(from, to, &base).map_err(|e| e.to_string())?;
    match finish(road, to, &branch, &base, ask) {
        Ok((sha, fetched, excluded)) => Ok(CopyReport {
            road: road.name(),
            path: ask.to.clone(),
            base: sha,
            branch: if road.name() == CopyRoadName::Worktree { String::new() } else { branch },
            fetched,
            carried: road.carried(),
            excluded,
            bytes: walked.bytes,
            ms: started.elapsed().as_millis() as u64,
            fell_back,
        }),
        Err(why) => {
            let _ = road.remove(from, to);
            Err(why)
        }
    }
}

/// The two rules on a copy that has just been made: the path-bound directories out so they rebuild here, then the
/// clean checkout of the base. The fetch runs in the copy's own git directory, so a copy starts level with the
/// remote rather than behind the person's last pull; a worktree shares the folder's git directory, so it takes no
/// fetch at all and nothing of the folder's refs moves.
fn finish(road: &'static dyn CopyRoad, to: &Path, branch: &str, base: &str, ask: &CopyAsk) -> Result<(String, bool, Vec<String>), String> {
    let excluded = rules::exclude(to, &ask.exclude)?;
    if road.name() == CopyRoadName::Worktree {
        return Ok((base.to_owned(), false, excluded));
    }
    // A base the caller named is the base; the fetch only moves a copy that was going to take the folder's own
    // default branch.
    let fetched = if ask.base.is_none() { rules::fetch(to, branch) } else { None };
    let sha = fetched.clone().unwrap_or_else(|| base.to_owned());
    rules::reset_to(to, branch, &sha)?;
    Ok((sha, fetched.is_some(), excluded))
}

/// The road this copy takes: the one the caller named, or the first road that says it can be taken. Every refusal
/// on the way is kept, so a copy that fell back says which road it would have taken and why it could not, and a
/// copy with no road left refuses with every sentence rather than one.
fn pick(from: &Path, to: &Path, walked: &Walked, ask: &CopyAsk) -> Result<(&'static dyn CopyRoad, Option<String>), String> {
    if let Some(named) = ask.road {
        let road = road_named(named).ok_or_else(|| format!("{} is not a road this computer has", named.word()))?;
        return match road.available(from, to, walked, ask.size_line_bytes) {
            Availability::Yes => Ok((road, None)),
            Availability::No(why) => Err(why),
        };
    }
    let mut passed = Vec::new();
    for road in ROADS.iter().copied() {
        match road.available(from, to, walked, ask.size_line_bytes) {
            Availability::Yes => return Ok((road, passed.first().cloned())),
            Availability::No(why) => passed.push(why),
        }
    }
    Err(passed.join("; "))
}

/// Why the folder somebody works in place is never taken away: it is theirs, and the record that named it is all
/// a delete has to drop.
pub const IN_PLACE_STAYS: &str = "a folder worked in place is the person's own; a delete takes its record and nothing on disk";

/// The copy taken away by the road that made it, which is the road the record carries.
pub fn remove(from: &Path, to: &Path, road: CopyRoadName) -> Result<(), String> {
    if road == CopyRoadName::InPlace {
        return Err(IN_PLACE_STAYS.to_owned());
    }
    if ROADS.is_empty() {
        return Err(NOT_THIS_COMPUTER.to_owned());
    }
    let taking = road_named(road).ok_or_else(|| format!("{} is not a road this computer has", road.word()))?;
    taking.remove(from, to).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rules::repo;

    fn ask(from: &Path, to: &Path) -> CopyAsk {
        CopyAsk {
            from: from.display().to_string(),
            to: to.display().to_string(),
            base: None,
            exclude: vec![".next".to_owned(), "node_modules/.cache".to_owned()],
            size_line_bytes: 20 * 1024 * 1024 * 1024,
            road: None,
        }
    }

    #[test]
    fn a_folder_that_is_not_a_repo_is_not_a_project() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("plain");
        std::fs::create_dir_all(&from).unwrap();
        let to = dir.path().join("plain-other");
        let refused = make(&ask(&from, &to)).unwrap_err();
        if ROADS.is_empty() {
            assert_eq!(refused, NOT_THIS_COMPUTER);
        } else {
            assert!(refused.contains("is not a git repository"), "{refused}");
        }
        assert!(!to.exists());
    }

    #[test]
    fn a_folder_worked_in_place_is_never_removed() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        assert_eq!(remove(&from, &from, CopyRoadName::InPlace).unwrap_err(), IN_PLACE_STAYS);
        assert!(from.join("README.md").exists());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_computer_that_runs_workspaces_of_its_own_has_no_road_here() {
        assert!(ROADS.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        assert_eq!(make(&ask(&from, &to)).unwrap_err(), NOT_THIS_COMPUTER);
        assert_eq!(remove(&from, &to, CopyRoadName::Worktree).unwrap_err(), NOT_THIS_COMPUTER);
        assert!(!to.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_copy_is_a_clean_checkout_of_the_base_with_the_dependencies_carried_and_the_built_directories_gone() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        std::fs::write(from.join(".gitignore"), b"node_modules/\n.next/\n*.local\n").unwrap();
        assert!(rules::git(&from, &["add", ".gitignore"], rules::READ_MS).unwrap().ok());
        assert!(rules::git(&from, &["commit", "--quiet", "-m", "ignore"], rules::WRITE_MS).unwrap().ok());
        let base = rules::sha_of(&from, "HEAD").unwrap();
        std::fs::create_dir_all(from.join("node_modules/.cache")).unwrap();
        std::fs::create_dir_all(from.join(".next/server")).unwrap();
        std::fs::write(from.join("node_modules/dep.js"), b"dep\n").unwrap();
        std::fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
        std::fs::write(from.join("README.md"), b"half edited\n").unwrap();
        std::fs::write(from.join("scratch.txt"), b"untracked\n").unwrap();
        let to = dir.path().join("work-other");
        let report = make(&ask(&from, &to)).unwrap();
        assert_eq!(report.road, CopyRoadName::Clonefile);
        assert_eq!(report.base, base);
        assert_eq!(report.branch, "main");
        assert!(!report.fetched, "no remote, so no fetch landed");
        assert_eq!(report.carried, Carried::DepsAndConfig);
        assert_eq!(report.excluded, vec![".next".to_owned(), "node_modules/.cache".to_owned()]);
        assert_eq!(report.fell_back, None);
        assert!(report.bytes > 0);
        assert_eq!(std::fs::read_to_string(to.join("node_modules/dep.js")).unwrap(), "dep\n");
        assert_eq!(std::fs::read_to_string(to.join(".env.local")).unwrap(), "KEY=1\n");
        assert_eq!(std::fs::read_to_string(to.join("README.md")).unwrap(), "one\n");
        assert!(!to.join("scratch.txt").exists());
        assert!(!to.join(".next").exists());
        // The folder it was copied from is untouched: its edit, its untracked file and its built directory stand.
        assert_eq!(std::fs::read_to_string(from.join("README.md")).unwrap(), "half edited\n");
        assert!(from.join("scratch.txt").exists() && from.join(".next/server").exists());
        remove(&from, &to, report.road).unwrap();
        assert!(!to.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_worktree_road_is_taken_when_the_clone_says_no_and_the_report_names_why() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        // A size line under what the folder holds is the reading that sends the picker to the next road.
        let mut asking = ask(&from, &to);
        asking.size_line_bytes = 1;
        let report = make(&asking).unwrap();
        assert_eq!(report.road, CopyRoadName::Worktree);
        assert_eq!(report.carried, Carried::ConfigOnly);
        assert_eq!(report.branch, "", "a worktree stands detached");
        let why = report.fell_back.clone().unwrap();
        assert!(why.contains("a clone above"), "{why}");
        remove(&from, &to, report.road).unwrap();
        assert!(!to.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_road_named_outright_is_the_road_taken_and_a_path_already_there_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        let mut asking = ask(&from, &to);
        asking.road = Some(CopyRoadName::Worktree);
        let report = make(&asking).unwrap();
        assert_eq!(report.road, CopyRoadName::Worktree);
        assert_eq!(report.fell_back, None, "a road that was asked for fell back from nothing");
        // A second copy at the same path is refused and the first one is untouched.
        let refused = make(&asking).unwrap_err();
        assert!(refused.contains("is already there"), "{refused}");
        assert!(to.join("README.md").exists());
        remove(&from, &to, CopyRoadName::Worktree).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_rule_that_fails_after_the_copy_leaves_no_copy_behind() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("work");
        repo(&from);
        let to = dir.path().join("work-other");
        let mut asking = ask(&from, &to);
        // A name that climbs out of the copy is refused by the exclusion, which runs on the copy that was made.
        asking.exclude = vec!["../work".to_owned()];
        let refused = make(&asking).unwrap_err();
        assert!(refused.contains("../work"), "{refused}");
        assert!(!to.exists(), "the copy the failed rule ran on is gone");
        assert!(from.join("README.md").exists());
    }
}
