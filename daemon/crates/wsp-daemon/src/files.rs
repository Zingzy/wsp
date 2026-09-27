// SPDX-License-Identifier: AGPL-3.0-only
//! The checkout's files as git shows them, for the composer's file mention: `git ls-files` in the folder asked about,
//! kept per folder until a folder holding one of them changes, so a second `@` in the same copy answers from memory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use notify::{RecursiveMode, Watcher};
use wsp_frames::{numbers, FsFilesReply};

use crate::git::{check, run_git, Runs};
use crate::paths::OpError;

/// Folders whose lists are kept at once; one more drops another.
const KEPT_CAP: usize = 32;
/// Folders one kept list watches on Linux, one inotify watch each; a checkout with more is listed afresh every time.
#[cfg(target_os = "linux")]
const WATCHED_DIRS_CAP: usize = 4096;
/// Bytes of `git ls-files -z` read before the program is cut: past the entry cap on any real tree of paths.
const LISTING_CAP_BYTES: usize = 8 * 1024 * 1024;

struct Kept {
    reply: FsFilesReply,
    changed: Arc<AtomicBool>,
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
pub(crate) struct FileLists {
    kept: Mutex<HashMap<PathBuf, Kept>>,
}

impl FileLists {
    /// The files under `at`, as the way of running sees it, kept under `under`, the same folder as this daemon reads
    /// it: a workspace's checkout is watched through its rootfs on this side.
    pub(crate) async fn of<R: Runs>(&self, runner: &R, under: PathBuf, at: &Path) -> Result<FsFilesReply, OpError> {
        {
            let kept = self.kept.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(list) = kept.get(&under).filter(|list| !list.changed.load(Ordering::Relaxed)) {
                return Ok(list.reply.clone());
            }
        }
        let changed = Arc::new(AtomicBool::new(false));
        let watcher = watcher(&under, &changed);
        #[cfg(target_os = "linux")]
        let since = std::time::SystemTime::now() - std::time::Duration::from_secs(1);
        let reply = list(runner, at).await?;
        #[cfg(target_os = "linux")]
        let watcher = watcher.and_then(|w| watch_listed(w, &under, &reply.files, &changed, since));
        let mut kept = self.kept.lock().unwrap_or_else(|e| e.into_inner());
        kept.remove(&under);
        if let Some(watcher) = watcher {
            if kept.len() >= KEPT_CAP {
                let dropped = kept.keys().next().cloned();
                if let Some(dropped) = dropped {
                    kept.remove(&dropped);
                }
            }
            kept.insert(under, Kept { reply: reply.clone(), changed, _watcher: watcher });
        }
        Ok(reply)
    }
}

/// Tracked files and untracked ones git does not ignore, relative to the folder. The fsmonitor is turned off for
/// the run: a checkout's config is the agent's to write, and that setting names a program git would start.
pub(crate) async fn list<R: Runs>(runner: &R, at: &Path) -> Result<FsFilesReply, OpError> {
    let args = ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
    let res = run_git(runner, at, &args, None, Some(LISTING_CAP_BYTES)).await?;
    check(&res, "ls-files")?;
    let text = String::from_utf8_lossy(&res.stdout);
    let mut names = text.split('\0').filter(|name| !name.is_empty());
    let files: Vec<String> = names.by_ref().take(numbers::FS_FILES_CAP_ENTRIES).map(str::to_owned).collect();
    let truncated = res.truncated || names.next().is_some();
    Ok(FsFilesReply { files, truncated })
}

/// A watcher that marks `changed` at the first change under the folder, installed before the folder is listed so a
/// file landing meanwhile is not missed; none where the platform refuses one, and then the list is not kept. Off
/// Linux the platform watches the whole tree in one go.
fn watcher(under: &Path, changed: &Arc<AtomicBool>) -> Option<notify::RecommendedWatcher> {
    let marks = Arc::clone(changed);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
        Ok(event) if matches!(event.kind, notify::EventKind::Access(_)) => {}
        _ => marks.store(true, Ordering::Relaxed),
    })
    .ok()?;
    #[cfg(target_os = "linux")]
    watcher.watch(under, RecursiveMode::NonRecursive).ok()?;
    #[cfg(not(target_os = "linux"))]
    watcher.watch(under, RecursiveMode::Recursive).ok()?;
    Some(watcher)
}

/// On Linux each folder holding a listed file is watched on its own, so an ignored tree such as node_modules takes
/// no inotify watch. Those watches can only follow the listing, so a folder whose entries changed since it began
/// marks the list changed.
#[cfg(target_os = "linux")]
fn watch_listed(
    mut watcher: notify::RecommendedWatcher,
    under: &Path,
    files: &[String],
    changed: &AtomicBool,
    since: std::time::SystemTime,
) -> Option<notify::RecommendedWatcher> {
    let mut dirs: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::from([under.to_path_buf()]);
    for file in files {
        let mut dir = Path::new(file).parent();
        while let Some(parent) = dir.filter(|d| !d.as_os_str().is_empty()) {
            if !dirs.insert(under.join(parent)) {
                break;
            }
            dir = parent.parent();
        }
        if dirs.len() > WATCHED_DIRS_CAP {
            return None;
        }
    }
    for dir in &dirs {
        watcher.watch(dir, RecursiveMode::NonRecursive).ok()?;
        if std::fs::metadata(dir).and_then(|m| m.modified()).map_or(true, |at| at >= since) {
            changed.store(true, Ordering::Relaxed);
        }
    }
    Some(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::here::Here;

    fn git(dir: &Path, args: &[&str]) {
        let done = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(done.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&done.stderr));
    }

    /// A checkout with a tracked file, an untracked one and the kinds of tree a project ignores.
    fn checkout() -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix("wsp-files-").tempdir().unwrap();
        let at = dir.path();
        git(at, &["init", "-q"]);
        std::fs::write(at.join(".gitignore"), "node_modules/\n.next/\n*.log\n").unwrap();
        std::fs::create_dir_all(at.join("src/components")).unwrap();
        std::fs::write(at.join("src/components/ChatView.tsx"), "export {};\n").unwrap();
        git(at, &["add", "."]);
        std::fs::write(at.join("src/notes.md"), "untracked\n").unwrap();
        std::fs::create_dir_all(at.join("node_modules/react")).unwrap();
        std::fs::write(at.join("node_modules/react/index.js"), "").unwrap();
        std::fs::create_dir_all(at.join(".next")).unwrap();
        std::fs::write(at.join(".next/build.js"), "").unwrap();
        std::fs::write(at.join("debug.log"), "").unwrap();
        dir
    }

    #[tokio::test]
    async fn an_ignored_file_never_appears_and_an_untracked_one_does() {
        let dir = checkout();
        let reply = list(&Here::new(), dir.path()).await.unwrap();
        let mut files = reply.files.clone();
        files.sort();
        assert_eq!(files, [".gitignore", "src/components/ChatView.tsx", "src/notes.md"]);
        assert!(!reply.truncated);
        // A folder under the checkout answers with paths relative to itself.
        let under = list(&Here::new(), &dir.path().join("src")).await.unwrap();
        let mut files = under.files;
        files.sort();
        assert_eq!(files, ["components/ChatView.tsx", "notes.md"]);
    }

    #[tokio::test]
    async fn a_folder_outside_any_checkout_is_refused_as_no_repository() {
        let dir = tempfile::Builder::new().prefix("wsp-files-bare-").tempdir().unwrap();
        let err = list(&Here::new(), dir.path()).await.unwrap_err();
        assert_eq!(err.code, Some(wsp_frames::DaemonErrorCode::NotAGitRepo));
    }

    #[tokio::test]
    async fn a_kept_list_answers_again_until_a_file_lands_beside_the_listed_ones() {
        let dir = checkout();
        let lists = FileLists::default();
        let under = dir.path().canonicalize().unwrap();
        let first = lists.of(&Here::new(), under.clone(), &under).await.unwrap();
        assert!(lists.kept.lock().unwrap().contains_key(&under), "the list was not kept");
        assert_eq!(lists.of(&Here::new(), under.clone(), &under).await.unwrap(), first);
        std::fs::write(under.join("src/components/Composer.tsx"), "").unwrap();
        let mut seen = false;
        for _ in 0..100 {
            if lists.of(&Here::new(), under.clone(), &under).await.unwrap().files.iter().any(|f| f == "src/components/Composer.tsx") {
                seen = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(seen, "a new file never reached the kept list");
    }

    /// Git through the real runner, with a file landing in the checkout the moment ls-files has answered.
    struct LandsAfterListing(PathBuf);

    impl Runs for LandsAfterListing {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            max_bytes: Option<usize>,
        ) -> Result<crate::git::GitResult, OpError> {
            let res = Here::new().run(cwd, program, args, input, max_bytes).await;
            std::fs::write(&self.0, "").unwrap();
            res
        }

        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            Here::new().on_path(program).await
        }
    }

    #[tokio::test]
    async fn a_file_that_lands_while_git_lists_reaches_the_kept_list() {
        let dir = checkout();
        let lists = FileLists::default();
        let under = dir.path().canonicalize().unwrap();
        let landed = under.join("src/components/Composer.tsx");
        let first = lists.of(&LandsAfterListing(landed), under.clone(), &under).await.unwrap();
        assert!(!first.files.iter().any(|f| f == "src/components/Composer.tsx"));
        let mut seen = false;
        for _ in 0..40 {
            if lists.of(&Here::new(), under.clone(), &under).await.unwrap().files.iter().any(|f| f == "src/components/Composer.tsx") {
                seen = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(seen, "a file that landed between the listing and the watch never reached the kept list");
    }
}
