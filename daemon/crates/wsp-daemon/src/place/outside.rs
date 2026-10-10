// SPDX-License-Identifier: AGPL-3.0-only
//! What a leave run as root takes outside the home: the workspace profile, the install folder and the runtime's
//! folder, whose checkouts are read for work no remote has before anything goes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use wsp_frames::{numbers, words};

use super::{sweep_outside_home, sweep_tool_prefix, sweep_workspace_profile};
use crate::under_home::{remove_under_home, Removed};

/// What a leave over the link takes off this computer, in its order: the home's files first, then, as root, what the
/// setup put outside the home. Before anything goes, a leave that would take the runtime's folder reads the checkouts
/// in it, and refuses naming each that holds work no remote has, or the folder where it could not read them, unless
/// forced. The add's record of what stood before it sits in wsp's folder, which the home's sweep takes, so it is read
/// first. `projects` are the folders under the runtime's projects folder the host's records name.
pub(crate) fn leave_here(
    home: &Path,
    profile: &Path,
    install: &str,
    runtime: &Path,
    force: bool,
    projects: &[String],
) -> Result<Vec<String>, String> {
    let found = super::place_found(home);
    if leave_takes_runtime(found.as_ref(), runtime) && !force {
        let unsaved = unsaved_under(runtime).unwrap_or_else(|_| vec![words::place_unread(runtime.display())]);
        if !unsaved.is_empty() {
            return Err(words::place_leave_unsaved(&unsaved));
        }
    }
    let mut swept = super::sweep_place_home(home, &super::sh_stdout);
    // Only root's install loaded the profile and only root's jobs install outside the home, and only root can take
    // either off.
    if nix::unistd::geteuid().is_root() {
        let mounted = wsp_runtime::mount_table::mounts_at_or_under(runtime);
        swept.extend(sweep_outside_owned(found.as_ref(), profile, install, runtime, &mounted, projects, &super::sh_stdout));
        #[cfg(target_os = "linux")]
        swept.extend(sweep_cgroup_roots(
            &[numbers::WORKSPACE_CGROUPS, numbers::THREAD_CGROUPS]
                .map(|cgroup| PathBuf::from(format!("{install}{}{cgroup}", numbers::CGROUP_MOUNT))),
        ));
    }
    Ok(swept)
}

/// Whether a leave here takes the runtime's folder whole: only root's can, and only with the add's whole record naming
/// it as not there before, since with no record nothing tells wsp's folder from one that stood. Something mounted under
/// it keeps it too, which the sweep reads at the time it runs.
pub(crate) fn leave_takes_runtime(found: Option<&HashSet<PathBuf>>, runtime: &Path) -> bool {
    nix::unistd::geteuid().is_root() && found.is_some_and(|found| !found.contains(runtime))
}

/// What a leave run as root takes outside the home: the workspace profile, what the setup wrote outside wsp's install
/// folder, then that folder and the links into it, each by the add's record. With no whole record nothing of the
/// profile or the folder goes, and one line names what stands there for a person to clear by hand; what the setup
/// wrote outside the folder still goes, since its own list hashes each path. `install` is the folder /usr/local, /opt
/// and /etc sit under, empty for this computer's own.
pub(crate) fn sweep_outside_owned(
    found: Option<&HashSet<PathBuf>>,
    profile: &Path,
    install: &str,
    runtime: &Path,
    mounted: &Result<Vec<PathBuf>, String>,
    projects: &[String],
    read: &dyn Fn(&str) -> String,
) -> Vec<String> {
    let prefix = PathBuf::from(format!("{install}{}", numbers::TOOL_PREFIX));
    let links = PathBuf::from(format!("{install}{}", numbers::TOOL_LINKS_DIR));
    let mut swept = Vec::new();
    let Some(found) = found else {
        let standing: Vec<String> = [profile, prefix.as_path(), runtime]
            .into_iter()
            .filter(|path| std::fs::symlink_metadata(path).is_ok())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        if !standing.is_empty() {
            swept.push(words::place_owners_unknown(&standing));
        }
        swept.extend(sweep_outside_home(install));
        return swept;
    };
    swept.extend(sweep_workspace_profile(profile, found, read));
    // The list naming what the setup wrote outside the home sits in the prefix, so it is read first.
    swept.extend(sweep_outside_home(install));
    swept.extend(sweep_tool_prefix(&prefix, &links, found));
    swept.extend(sweep_runtime_root(runtime, found, mounted, projects));
    swept
}

/// Takes the runtime's folder off this computer, unless something is mounted under it: a workspace still running there
/// reads through those mounts, and a removal would reach through them into whatever they show. A mount table that
/// cannot be read keeps it for the same reason. Whole where wsp made it. Where the add found it standing, which is also
/// what a folder an earlier wsp's remove left reads as, only what wsp made there goes: its `RUNTIME_FOLDERS` and the
/// project folders the host's records name, each a single name under `RUNTIME_PROJECTS`; anything else there may be the
/// person's and stays, and the folder goes only once nothing else is in it. Emptied by descriptor under its parent, as
/// the home's paths are, so a tree a workspace made deeper than wsp's own keeps what lies below rather than overflowing
/// the leave's small stack. A folder still standing after the try is said, never answered as gone or as nothing. The
/// host's own leave takes it by the same rule.
pub(crate) fn sweep_runtime_root(
    root: &Path,
    found: &HashSet<PathBuf>,
    mounted: &Result<Vec<PathBuf>, String>,
    projects: &[String],
) -> Vec<String> {
    if std::fs::symlink_metadata(root).is_err() {
        return Vec::new();
    }
    let mounted = match mounted {
        Ok(mounted) => mounted,
        Err(why) => return vec![words::place_kept_mounts_unread(root.to_string_lossy(), why)],
    };
    if let Some(mount) = mounted.iter().find(|point| point.starts_with(root)) {
        return vec![words::place_kept_mounted(root.to_string_lossy(), mount.to_string_lossy())];
    }
    if !found.contains(root) {
        return take_whole(root);
    }
    let held = root.join(numbers::RUNTIME_PROJECTS);
    let one_name =
        |name: &&String| matches!(Path::new(name.as_str()).components().collect::<Vec<_>>()[..], [std::path::Component::Normal(_)]);
    let mut swept: Vec<String> = numbers::RUNTIME_FOLDERS
        .iter()
        .map(|name| root.join(name))
        .chain(projects.iter().filter(one_name).map(|name| held.join(name)))
        .filter(|folder| std::fs::symlink_metadata(folder).is_ok())
        .flat_map(|folder| take_whole(&folder))
        .collect();
    if std::fs::remove_dir(&held).is_ok() {
        swept.push(held.to_string_lossy().into_owned());
    }
    swept.push(match std::fs::remove_dir(root) {
        Ok(()) => root.to_string_lossy().into_owned(),
        Err(_) => words::place_stood_before(root.to_string_lossy()),
    });
    swept
}

fn take_whole(path: &Path) -> Vec<String> {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else { return Vec::new() };
    match remove_under_home(parent, Path::new(name)) {
        Removed::Gone => vec![path.to_string_lossy().into_owned()],
        Removed::Linked => vec![words::place_kept_for_link(path.to_string_lossy())],
        Removed::TooDeep => vec![words::place_kept_too_deep(path.to_string_lossy())],
        Removed::Absent if std::fs::symlink_metadata(path).is_ok() => vec![words::place_runtime_stands(path.to_string_lossy())],
        Removed::Absent => Vec::new(),
    }
}

/// Takes the cgroups wsp made, deepest first, each only once nothing stands in it: a leave ends no process, and the
/// kernel refuses the removal of a cgroup still holding one, which is then said. One that is not there is nothing.
#[cfg(target_os = "linux")]
pub(crate) fn sweep_cgroup_roots(roots: &[PathBuf]) -> Vec<String> {
    roots
        .iter()
        .filter(|root| std::fs::symlink_metadata(root).is_ok())
        .map(|root| match wsp_runtime::cgroup::remove_tree(root) {
            Ok(()) => root.to_string_lossy().into_owned(),
            Err(_) => words::place_cgroup_stands(root.to_string_lossy()),
        })
        .collect()
}

/// Every checkout and workspace under the runtime's folder a leave would take with it, each named by its path with
/// what it holds that no remote has: each workspace's copy of its checkout and each project's checkout, read off their
/// git directories alone, so nothing an agent wrote there runs as the root this daemon is. Their uncommitted files
/// cannot be read that way, so every one standing is named; a workspace with no copy holds whatever it wrote in its
/// own folder, which reads as nothing it could read. Empty where the folder holds none; an error where a folder of
/// the runtime's could not be listed, which hides what it holds rather than holding nothing.
#[cfg(target_os = "linux")]
pub(crate) fn unsaved_under(runtime: &Path) -> Result<Vec<String>, String> {
    let layout = wsp_runtime::bundle::Layout::new(runtime);
    let names = |dir: PathBuf| -> Result<Vec<String>, String> {
        let listed = match std::fs::read_dir(&dir) {
            Ok(listed) => listed,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("{}: {e}", dir.display())),
        };
        let mut names = Vec::new();
        for entry in listed {
            let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        Ok(names)
    };
    let read = |checkout: PathBuf| -> String {
        match crate::git::stored::unsaved(&checkout) {
            Ok(Some(held)) => words::place_holds_unsaved(checkout.display(), held.commits, held.stashes),
            Ok(None) => words::place_holds_unsaved(checkout.display(), Some(0), 0),
            Err(_) => words::place_unread(checkout.display()),
        }
    };
    let copies: Vec<String> = names(layout.copies())?.into_iter().filter(|name| !name.starts_with('.')).collect();
    let mut lines: Vec<String> = names(layout.run())?
        .into_iter()
        .filter(|id| !copies.contains(id))
        .map(|id| words::place_unread(layout.workspace(&id).display()))
        .collect();
    lines.extend(copies.iter().map(|id| read(layout.copy_of(id))));
    for project in names(layout.projects())? {
        let checkout = layout.projects().join(project).join("checkout");
        if std::fs::symlink_metadata(&checkout).is_ok() {
            lines.push(read(checkout));
        }
    }
    Ok(lines)
}

/// Nothing on a computer whose runtime boots no workspace, which is every computer that is not Linux: no copy, no
/// workspace folder and no project checkout is ever made under its runtime's folder.
#[cfg(not(target_os = "linux"))]
pub(crate) fn unsaved_under(_runtime: &Path) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::place::place_found;
    use crate::place::tests::{box_of_its_own, install_root, record_under, setup_installed, standing, tree, BoxOfItsOwn};

    pub(in crate::place) fn runtime_of(at: &BoxOfItsOwn) -> PathBuf {
        at.root.path().join(numbers::RUNTIME_ROOT.trim_start_matches('/'))
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_root_leave_over_a_checkout_holding_a_commit_no_remote_has_removes_nothing_unless_forced() {
        // Only root's leave takes the runtime's folder, so only root's leave reads what is in it.
        if !nix::unistd::geteuid().is_root() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let at = wsp_frames::place_daemon_paths(home.path());
        std::fs::create_dir_all(&at.wsp).unwrap();
        std::fs::write(&at.place_file, "{}").unwrap();
        std::fs::write(&at.place_found, format!("{}\0", numbers::PLACE_FOUND_END)).unwrap();
        // A stopped workspace's copy of its checkout: one commit, and no remote anywhere.
        let runtime = home.path().join("runtime");
        let copy = runtime.join("copies/w1");
        std::fs::create_dir_all(runtime.join("run/w1")).unwrap();
        std::fs::create_dir_all(&copy).unwrap();
        let git = |args: &[&str]| {
            let ran = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main"])
                .args(args)
                .current_dir(&copy)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(ran.status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(copy.join("a.txt"), "work\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "work"]);
        let profile = home.path().join("apparmor.d").join("wsp-workspace");
        // Through the op on the link, as the host's remove sends it: a refusal is answered and the daemon serves on,
        // and only a forced leave sweeps and ends it.
        let mut token = tempfile::NamedTempFile::new().unwrap();
        std::io::Write::write_all(&mut token, b"t\n").unwrap();
        let mut options = crate::Options::new(token.path());
        options.home = Some(home.path().to_path_buf());
        options.apparmor_profile = Some(profile);
        options.install_root = Some(home.path().to_path_buf());
        options.runtime_root = Some(runtime.clone());
        let ctx = std::sync::Arc::new(crate::Ctx::new(options, Box::new(|_| {}), 0).unwrap());
        let (link, _rx) = crate::ops::tests::conn_on(None, crate::ops::Road::Link);
        let out = crate::ops::handle(&link, &ctx, &serde_json::json!({"id": 21, "op": "place.leave"}).to_string()).await;
        let crate::Outgoing::Text(text) = &out else { panic!("a refused leave keeps the daemon serving") };
        let said: serde_json::Value = serde_json::from_str(text).unwrap();
        let line = format!("{} holds 1 commit not pushed and edits it could not read", copy.display());
        assert_eq!(said, serde_json::json!({"id": 21, "ok": false, "code": "bad-request", "error": words::place_leave_unsaved(&[line])}));
        assert!(copy.join(".git").exists() && at.place_file.exists() && at.wsp.exists(), "a refused leave removed something");
        let out = crate::ops::handle(&link, &ctx, &serde_json::json!({"id": 22, "op": "place.leave", "force": true}).to_string()).await;
        let crate::Outgoing::Leave(text) = &out else { panic!("a forced leave ends the daemon after its reply") };
        let said: serde_json::Value = serde_json::from_str(text).unwrap();
        assert!(said["swept"].as_array().unwrap().contains(&serde_json::json!(runtime.to_string_lossy())), "{said}");
        assert!(!runtime.exists());
    }

    #[test]
    fn a_runtime_folder_whose_mount_table_cannot_be_read_stays_and_is_said() {
        let at = box_of_its_own();
        let runtime = runtime_of(&at);
        std::fs::create_dir_all(runtime.join("run/wsp-a/rootfs")).unwrap();
        let unread = Err("/proc/self/mountinfo: stream did not contain valid UTF-8".to_owned());
        assert_eq!(
            sweep_runtime_root(&runtime, &HashSet::new(), &unread, &[]),
            [words::place_kept_mounts_unread(runtime.to_string_lossy(), "/proc/self/mountinfo: stream did not contain valid UTF-8")]
        );
        assert!(runtime.join("run/wsp-a/rootfs").exists());
    }

    #[test]
    fn a_runtime_folder_the_leave_could_not_take_whole_is_said_to_stand() {
        let at = box_of_its_own();
        let runtime = runtime_of(&at);
        std::fs::create_dir_all(runtime.join("state")).unwrap();
        let held = runtime.join("state/held");
        std::fs::write(&held, "kept\n").unwrap();
        // An immutable file is one even root cannot unlink; where the filesystem or the user cannot set one, this case
        // has nothing to hold the folder up with.
        let set = |flag: &str| std::process::Command::new("chattr").arg(flag).arg(&held).status().is_ok_and(|s| s.success());
        if !set("+i") {
            return;
        }
        let swept = sweep_runtime_root(&runtime, &HashSet::new(), &Ok(Vec::new()), &[]);
        set("-i");
        assert_eq!(swept, [words::place_runtime_stands(runtime.to_string_lossy())]);
        assert!(held.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn names_every_checkout_and_workspace_under_the_runtime_folder_with_the_commits_no_remote_has() {
        let at = box_of_its_own();
        let runtime = runtime_of(&at);
        let layout = wsp_runtime::bundle::Layout::new(&runtime);
        assert_eq!(unsaved_under(&runtime), Ok(Vec::<String>::new()));
        let git = |at: &Path, args: &[&str]| {
            let ran = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main"])
                .args(args)
                .current_dir(at)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(ran.status.success(), "git {args:?}");
        };
        // A workspace with no copy, one whose copy holds two commits and a stash, a copy still being made, and a
        // project's checkout with nothing committed yet.
        std::fs::create_dir_all(layout.workspace("w-bare")).unwrap();
        std::fs::create_dir_all(layout.workspace("w-1")).unwrap();
        let copy = layout.copy_of("w-1");
        std::fs::create_dir_all(&copy).unwrap();
        git(&copy, &["init", "-q"]);
        for n in ["one", "two"] {
            std::fs::write(copy.join("a.txt"), n).unwrap();
            git(&copy, &["add", "a.txt"]);
            git(&copy, &["commit", "-q", "-m", n]);
        }
        std::fs::write(copy.join("a.txt"), "three").unwrap();
        git(&copy, &["stash", "-q"]);
        std::fs::create_dir_all(layout.copy_being_made("w-2")).unwrap();
        let checkout = layout.projects().join("p_1/checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        git(&checkout, &["init", "-q"]);
        assert_eq!(
            unsaved_under(&runtime).unwrap(),
            [
                words::place_unread(layout.workspace("w-bare").display()),
                format!("{} holds 2 commits not pushed, edits it could not read and 1 stash", copy.display()),
                format!("{} holds edits it could not read", checkout.display()),
            ]
        );
    }

    #[test]
    fn the_report_says_the_leave_takes_the_runtime_folder_only_as_root_with_a_whole_record_that_does_not_name_it() {
        let runtime = Path::new("/wsp");
        let root = nix::unistd::geteuid().is_root();
        assert!(!leave_takes_runtime(None, runtime));
        assert_eq!(leave_takes_runtime(Some(&HashSet::new()), runtime), root);
        assert!(!leave_takes_runtime(Some(&HashSet::from([runtime.to_path_buf()])), runtime));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_runtime_folder_whose_listing_fails_is_an_error_never_a_folder_holding_nothing() {
        let at = box_of_its_own();
        let runtime = runtime_of(&at);
        let layout = wsp_runtime::bundle::Layout::new(&runtime);
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(layout.copies(), "not a folder").unwrap();
        let why = unsaved_under(&runtime).unwrap_err();
        assert!(why.starts_with(&layout.copies().display().to_string()), "{why}");
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn a_runtime_that_boots_no_workspace_holds_nothing_a_leave_would_lose() {
        let at = box_of_its_own();
        let runtime = runtime_of(&at);
        assert_eq!(unsaved_under(&runtime), Ok(Vec::new()));
        std::fs::create_dir_all(&runtime).unwrap();
        assert_eq!(unsaved_under(&runtime), Ok(Vec::new()));
    }

    #[test]
    fn the_runtime_folder_goes_whole_unless_it_stood_before_the_add_or_something_is_mounted_under_it() {
        let at = box_of_its_own();
        let runtime = runtime_of(&at);
        // What a remove left there before: the runtime's own folders, and a sign-in's log and lock beside the login.
        for folder in ["run", "state", "copies", "projects/p_1/checkout", "put", "logins/codex"] {
            std::fs::create_dir_all(runtime.join(folder)).unwrap();
        }
        std::fs::write(runtime.join("logins/codex/login.log"), "signed in\n").unwrap();
        let mounted = [runtime.join("run/wsp-a/rootfs")];
        assert_eq!(
            sweep_runtime_root(&runtime, &HashSet::new(), &Ok(mounted.to_vec()), &[]),
            [words::place_kept_mounted(runtime.to_string_lossy(), mounted[0].to_string_lossy())]
        );
        assert!(runtime.join("logins/codex/login.log").exists());
        assert_eq!(sweep_runtime_root(&runtime, &HashSet::new(), &Ok(Vec::new()), &[]), [runtime.to_string_lossy().into_owned()]);
        assert!(!runtime.exists());
        assert_eq!(sweep_runtime_root(&runtime, &HashSet::new(), &Ok(Vec::new()), &[]), Vec::<String>::new());
    }

    #[test]
    fn a_runtime_folder_that_stood_before_loses_only_what_wsp_made_there_and_goes_once_nothing_else_is_in_it() {
        let at = box_of_its_own();
        let runtime = runtime_of(&at);
        // What an earlier wsp's remove left, which the next add found standing: its own folders and the checkouts of two
        // projects the host still records, beside a repository and notes of the person's own.
        for folder in [
            "run/wsp-a",
            "state",
            "copies",
            "put",
            "logins",
            "projects/pr_1/checkout",
            "projects/pr_2/checkout",
            "projects/myrepo",
            "notes",
        ] {
            std::fs::create_dir_all(runtime.join(folder)).unwrap();
        }
        std::fs::write(runtime.join("projects/myrepo/notes.md"), "mine\n").unwrap();
        let stood = HashSet::from([runtime.clone()]);
        let named = ["pr_1".to_owned(), "pr_2".to_owned(), "../notes".to_owned(), "pr_gone".to_owned()];
        let swept = sweep_runtime_root(&runtime, &stood, &Ok(Vec::new()), &named);
        let taken: Vec<String> = ["copies", "logins", "put", "run", "state", "projects/pr_1", "projects/pr_2"]
            .iter()
            .map(|f| runtime.join(f).to_string_lossy().into_owned())
            .collect();
        assert_eq!(swept, [taken, vec![words::place_stood_before(runtime.to_string_lossy())]].concat());
        assert!(
            runtime.join("projects/myrepo/notes.md").exists() && runtime.join("notes").is_dir(),
            "the leave took a folder no record names"
        );
        // Once only wsp's are there, the folder goes with them.
        std::fs::remove_dir_all(runtime.join("projects/myrepo")).unwrap();
        std::fs::remove_dir_all(runtime.join("notes")).unwrap();
        std::fs::create_dir_all(runtime.join("projects/pr_1/checkout")).unwrap();
        let swept = sweep_runtime_root(&runtime, &stood, &Ok(Vec::new()), &named);
        assert_eq!(
            swept,
            [runtime.join("projects/pr_1"), runtime.join("projects"), runtime.clone()].map(|p| p.to_string_lossy().into_owned())
        );
        assert!(!runtime.exists());
        // And with something mounted under it, nothing of it goes.
        std::fs::create_dir_all(runtime.join("run/wsp-a/rootfs")).unwrap();
        let mounted = [runtime.join("run/wsp-a/rootfs")];
        assert_eq!(
            sweep_runtime_root(&runtime, &stood, &Ok(mounted.to_vec()), &named),
            [words::place_kept_mounted(runtime.to_string_lossy(), mounted[0].to_string_lossy())]
        );
        assert!(runtime.join("run/wsp-a/rootfs").exists());
    }

    /// A git repository with one commit, cloned from a bare origin and pushed there where `pushed`.
    #[cfg(target_os = "linux")]
    fn repo(at: &Path, pushed: bool) {
        let git = |dir: &Path, args: &[&str]| {
            let ran = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main"])
                .args(args)
                .current_dir(dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap();
            assert!(ran.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ran.stderr));
        };
        std::fs::create_dir_all(at).unwrap();
        git(at, &["init", "-q"]);
        std::fs::write(at.join("notes.md"), "one\n").unwrap();
        git(at, &["add", "notes.md"]);
        git(at, &["commit", "-q", "-m", "one"]);
        if pushed {
            let origin = at.with_extension("origin.git");
            git(at.parent().unwrap(), &["clone", "-q", "--bare", at.to_str().unwrap(), origin.to_str().unwrap()]);
            git(at, &["remote", "add", "origin", origin.to_str().unwrap()]);
            git(at, &["fetch", "-q", "origin"]);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_plain_leave_over_a_runtime_folder_that_stood_keeps_the_persons_repository_and_takes_the_clean_checkouts_it_is_named() {
        if !nix::unistd::geteuid().is_root() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let at = wsp_frames::place_daemon_paths(home.path());
        let runtime = home.path().join("runtime");
        std::fs::create_dir_all(&at.wsp).unwrap();
        std::fs::write(&at.place_file, "{}").unwrap();
        std::fs::write(&at.place_found, format!("{}\0{}\0", runtime.display(), numbers::PLACE_FOUND_END)).unwrap();
        // The person's own repository with a commit on no remote, and two clean, pushed checkouts an older wsp made.
        repo(&runtime.join("projects/myrepo"), false);
        repo(&runtime.join("projects/pr_1/checkout"), true);
        repo(&runtime.join("projects/pr_2/checkout"), true);
        let profile = home.path().join("apparmor.d").join("wsp-workspace");
        let named = ["pr_1".to_owned(), "pr_2".to_owned()];
        let swept = leave_here(home.path(), &profile, &home.path().to_string_lossy(), &runtime, false, &named).unwrap();
        assert!(runtime.join("projects/myrepo/notes.md").exists(), "{swept:?}");
        assert!(!runtime.join("projects/pr_1").exists() && !runtime.join("projects/pr_2").exists(), "{swept:?}");
        assert!(swept.contains(&words::place_stood_before(runtime.to_string_lossy())), "{swept:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_cgroups_wsp_made_go_once_empty_and_one_still_holding_something_is_said() {
        let at = box_of_its_own();
        let workspaces = at.root.path().join("cgroup/wsp");
        let threads = at.root.path().join("cgroup/wsp-threads");
        std::fs::create_dir_all(workspaces.join("wsp-a/wsp-ssh")).unwrap();
        std::fs::create_dir_all(threads.join("t_1")).unwrap();
        // A file stands for the process a cgroup still holds: either way the folder will not go.
        std::fs::write(threads.join("t_1/held"), "").unwrap();
        let gone = at.root.path().join("cgroup/never-made");
        let swept = sweep_cgroup_roots(&[workspaces.clone(), threads.clone(), gone]);
        assert!(!workspaces.exists(), "{swept:?}");
        assert!(threads.join("t_1/held").exists());
        assert_eq!(swept, [workspaces.to_string_lossy().into_owned(), words::place_cgroup_stands(threads.to_string_lossy())]);
    }

    #[test]
    fn with_no_record_nothing_outside_the_home_goes_and_one_line_names_what_stays() {
        let at = box_of_its_own();
        setup_installed(&at);
        let before = tree(at.root.path());
        assert!(place_found(at.home.path()).is_none());
        let never = |_: &str| -> String { panic!("nothing is unloaded without a record") };
        let swept = sweep_outside_owned(
            place_found(at.home.path()).as_ref(),
            &at.profile,
            &install_root(&at),
            &runtime_of(&at),
            &Ok(Vec::new()),
            &[],
            &never,
        );
        assert_eq!(swept, [words::place_owners_unknown(&[at.profile.to_string_lossy(), at.prefix.to_string_lossy()])]);
        assert_eq!(tree(at.root.path()), before);
    }

    #[test]
    fn a_record_cut_short_reads_as_none_and_takes_nothing() {
        let at = box_of_its_own();
        let record = record_under(at.home.path(), &standing(&at.profile, &at.prefix, &at.links));
        let whole = std::fs::read(&record).unwrap();
        setup_installed(&at);
        let before = tree(at.root.path());
        // Cut anywhere short of its end entry: inside a path, after a path, and one byte short of the end.
        for cut in [10, whole.iter().position(|b| *b == 0).unwrap() + 1, whole.len() - 1] {
            std::fs::write(&record, &whole[..cut]).unwrap();
            assert!(place_found(at.home.path()).is_none(), "a record cut at {cut} read as whole");
            let swept = sweep_outside_owned(
                place_found(at.home.path()).as_ref(),
                &at.profile,
                &install_root(&at),
                &runtime_of(&at),
                &Ok(Vec::new()),
                &[],
                &|_| String::new(),
            );
            assert_eq!(swept.len(), 1, "{swept:?}");
            assert_eq!(tree(at.root.path()), before);
        }
        // An empty file and a path that ends where the end entry's name begins are no record either.
        std::fs::write(&record, b"").unwrap();
        assert!(place_found(at.home.path()).is_none());
        std::fs::write(&record, format!("/opt/x{}\0", numbers::PLACE_FOUND_END)).unwrap();
        assert!(place_found(at.home.path()).is_none());
        std::fs::write(&record, &whole).unwrap();
        assert!(place_found(at.home.path()).is_some());
    }

    #[test]
    fn what_the_setup_wrote_inside_a_folder_that_stood_goes_and_every_path_from_before_stays() {
        let at = box_of_its_own();
        let before = tree(&at.prefix);
        record_under(at.home.path(), &standing(&at.profile, &at.prefix, &at.links));
        setup_installed(&at);
        // A file of its own that the setup wrote over stays, as the person's: the record cannot tell its bytes apart.
        std::fs::write(at.prefix.join("rustup/settings.toml"), "written over\n").unwrap();
        let never = |_: &str| -> String { panic!("a profile that stood before the add is not unloaded") };
        let swept = sweep_outside_owned(
            place_found(at.home.path()).as_ref(),
            &at.profile,
            &install_root(&at),
            &runtime_of(&at),
            &Ok(Vec::new()),
            &[],
            &never,
        );
        assert_eq!(tree(&at.prefix), before);
        let said = |p: PathBuf| p.to_string_lossy().into_owned();
        for line in [
            words::place_stood_before(at.profile.to_string_lossy()),
            said(at.links.join("rustc")),
            said(at.prefix.join("rustup/toolchains/stable")),
            said(at.prefix.join("uv")),
            words::place_stood_before(at.prefix.to_string_lossy()),
        ] {
            assert!(swept.contains(&line), "{line} in {swept:?}");
        }
        // The topmost path that went stands for everything under it.
        assert!(!swept.contains(&said(at.prefix.join("uv/bin"))), "{swept:?}");
        let left: Vec<_> = std::fs::read_dir(&at.links).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["rustc-theirs"]);
        assert_eq!(std::fs::read_to_string(&at.profile).unwrap(), "profile theirs {}\n");
    }

    #[test]
    fn where_nothing_stood_the_profile_and_the_folder_go_whole() {
        let at = box_of_its_own();
        std::fs::remove_file(&at.profile).unwrap();
        std::fs::remove_dir_all(&at.prefix).unwrap();
        std::fs::remove_file(at.links.join("rustc-theirs")).unwrap();
        record_under(at.home.path(), &standing(&at.profile, &at.prefix, &at.links));
        assert_eq!(place_found(at.home.path()), Some(HashSet::new()));
        std::fs::write(&at.profile, "profile wsp-test-never-loaded {}\n").unwrap();
        std::fs::create_dir_all(at.prefix.join("uv/bin")).unwrap();
        std::os::unix::fs::symlink(at.prefix.join("uv/bin/uv"), at.links.join("uv")).unwrap();
        let swept = sweep_outside_owned(
            place_found(at.home.path()).as_ref(),
            &at.profile,
            &install_root(&at),
            &runtime_of(&at),
            &Ok(Vec::new()),
            &[],
            &|_| String::new(),
        );
        assert!(!at.profile.exists() && !at.prefix.exists());
        assert!(swept.contains(&at.prefix.to_string_lossy().into_owned()), "{swept:?}");
        assert!(std::fs::read_dir(&at.links).unwrap().next().is_none());
    }
}
