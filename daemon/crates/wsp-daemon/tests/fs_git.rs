// SPDX-License-Identifier: AGPL-3.0-only
//! Every fs and git op over the wire against a real git repo built in a temp root, so the cases cover confinement,
//! git parsing and the byte caps as a client sees them. Each case builds its own tree: cases run in parallel and
//! two of them change the repo they read.

use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_daemon::{Daemon, Options};
use wsp_frames::numbers::{FS_READ_CAP_BYTES, GIT_DIFF_CAP_BYTES};

const TOKEN: &str = "fs-token";

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@x")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@x")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?} in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

struct Tree {
    root: tempfile::TempDir,
    outside: tempfile::TempDir,
}

impl Tree {
    fn root(&self) -> &Path {
        self.root.path()
    }

    fn outside(&self) -> &Path {
        self.outside.path()
    }

    fn repo(&self) -> PathBuf {
        self.root().join("repo")
    }

    /// The daemon reads its roots beside its home; the default names the guest's /root, which no test may reach.
    fn roots_path(&self) -> PathBuf {
        self.root().join(".wsp/roots")
    }
}

/// The node suite's tree: a repo on a feature branch with every status kind, a deep folder, a big file, a
/// multibyte file, and a symlink out of the repo to a folder outside the root.
fn build() -> Tree {
    let root = tempfile::Builder::new().prefix("wsp-fsgit-root-").tempdir().unwrap();
    let outside = tempfile::Builder::new().prefix("wsp-fsgit-outside-").tempdir().unwrap();
    let t = Tree { root, outside };
    let repo = t.repo();
    fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    fs::write(repo.join("README.md"), "# readme\n").unwrap();
    fs::write(repo.join("src/index.ts"), "export const a = 1;\n").unwrap();
    fs::write(repo.join(".gitignore"), "ignored.log\nbuild/\nnode_modules/\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    git(&repo, &["checkout", "-q", "-b", "feature"]);
    fs::write(repo.join("feature.txt"), "feature\n").unwrap();
    git(&repo, &["add", "feature.txt"]);
    git(&repo, &["commit", "-q", "-m", "feature"]);
    fs::write(repo.join("src/index.ts"), "export const a = 2;\n").unwrap();
    fs::write(repo.join("staged.txt"), "staged\n").unwrap();
    git(&repo, &["add", "staged.txt"]);
    git(&repo, &["mv", "README.md", "docs.md"]);
    fs::write(repo.join("untracked.txt"), "untracked\n").unwrap();
    fs::write(repo.join("ignored.log"), "log\n").unwrap();
    fs::create_dir(repo.join("build")).unwrap();
    fs::write(repo.join("build/out.js"), "out\n").unwrap();
    fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
    fs::write(repo.join("node_modules/pkg/index.js"), "module.exports = 1;\n").unwrap();
    fs::write(t.outside().join("secret.txt"), "secret\n").unwrap();
    symlink(t.outside(), repo.join("escape")).unwrap();
    symlink(repo.join("docs.md"), repo.join("docs-link.md")).unwrap();
    let deep = t.root().join("deep");
    fs::create_dir_all(deep.join("wide")).unwrap();
    fs::create_dir(deep.join("src")).unwrap();
    fs::write(deep.join("package.json"), "{}\n").unwrap();
    fs::write(deep.join("src/index.ts"), "export {};\n").unwrap();
    for i in 0..12 {
        fs::write(deep.join(format!("wide/f{i:02}.txt")), "x\n").unwrap();
    }
    fs::write(t.root().join("big.bin"), vec![7u8; FS_READ_CAP_BYTES as usize + 10]).unwrap();
    fs::write(t.root().join("multibyte.txt"), "héllo wörld\n").unwrap();
    fs::create_dir(t.root().join("bigrepo")).unwrap();
    t
}

/// A second repo whose one changed file is far past the diff budget, beside a small change.
fn build_big_repo(t: &Tree) {
    let big = t.root().join("bigrepo");
    git(&big, &["init", "-q", "-b", "main"]);
    git(&big, &["config", "commit.gpgsign", "false"]);
    fs::write(big.join("large.txt"), "one line\n").unwrap();
    fs::write(big.join("small.txt"), "small\n").unwrap();
    git(&big, &["add", "-A"]);
    git(&big, &["commit", "-q", "-m", "init"]);
    let mut lines = String::new();
    for i in 0..120_000 {
        lines.push_str(&format!("line {i} {}\n", "x".repeat(20)));
    }
    fs::write(big.join("large.txt"), lines).unwrap();
    fs::write(big.join("small.txt"), "small changed\n").unwrap();
}

struct Running {
    addr: SocketAddr,
    _token: tempfile::NamedTempFile,
}

async fn start(root: &Path, roots_path: &Path) -> Running {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "{TOKEN}").unwrap();
    let mut options = Options::new(token.path());
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(root.to_path_buf());
    options.roots_path = Some(roots_path.to_path_buf());
    let daemon = Daemon::bind(options).await.unwrap();
    let addr = daemon.local_addr();
    tokio::spawn(daemon.run());
    Running { addr, _token: token }
}

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Client {
    async fn connect(addr: SocketAddr) -> Client {
        let (ws, _) = connect_async(format!("ws://{addr}/")).await.unwrap();
        let mut c = Client { ws, next_id: 0 };
        let auth = c.send(json!({ "op": "auth", "token": TOKEN })).await;
        assert_eq!(auth["ok"], true);
        c
    }

    async fn send(&mut self, mut frame: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        frame["id"] = json!(id);
        self.ws.send(Message::text(frame.to_string())).await.unwrap();
        loop {
            let next =
                tokio::time::timeout(Duration::from_secs(20), self.ws.next()).await.expect("the daemon answers within twenty seconds");
            match next {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap();
                    if v.get("id") == Some(&json!(id)) {
                        return v;
                    }
                }
                Some(Ok(_)) => continue,
                other => panic!("the socket ended while {frame} was pending: {other:?}"),
            }
        }
    }

    async fn request(&mut self, op: &str, params: Value) -> Value {
        let mut frame = json!({ "op": op });
        for (k, v) in params.as_object().unwrap() {
            frame[k] = v.clone();
        }
        self.send(frame).await
    }
}

/// One tree, one daemon on it, one authed client.
async fn bench() -> (Tree, Running, Client) {
    let t = build();
    let d = start(t.root(), &t.roots_path()).await;
    let c = Client::connect(d.addr).await;
    (t, d, c)
}

fn names(m: &Value) -> Vec<String> {
    let mut out: Vec<String> = m["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

fn by_name<'a>(m: &'a Value, name: &str) -> &'a Value {
    m["entries"].as_array().unwrap().iter().find(|e| e["name"] == name).unwrap_or_else(|| panic!("no entry {name} in {m}"))
}

fn paths(m: &Value) -> Vec<String> {
    let mut out: Vec<String> = m["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

fn patch_of<'a>(m: &'a Value, path: &str) -> Option<&'a str> {
    m["files"].as_array().unwrap().iter().find(|f| f["path"] == path).map(|f| f["patch"].as_str().unwrap())
}

fn refused(m: &Value, code: &str) {
    assert_eq!((m["ok"].as_bool(), m["code"].as_str()), (Some(false), Some(code)), "{m}");
}

fn b64(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}

#[tokio::test]
async fn fs_list_lists_direct_children_with_type_size_and_mtime() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("fs.list", json!({ "path": "repo" })).await;
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["truncated"], false);
    let mut expected: Vec<&str> = vec![
        ".git",
        ".gitignore",
        "build",
        "docs-link.md",
        "docs.md",
        "escape",
        "feature.txt",
        "ignored.log",
        "node_modules",
        "src",
        "staged.txt",
        "untracked.txt",
    ];
    expected.sort_unstable();
    assert_eq!(names(&res), expected);
    assert_eq!((by_name(&res, "src")["type"].as_str(), by_name(&res, "src")["size"].as_u64()), (Some("dir"), Some(0)));
    assert_eq!(by_name(&res, "escape")["type"], "symlink");
    assert_eq!(by_name(&res, "docs-link.md")["type"], "symlink");
    let staged = by_name(&res, "staged.txt");
    assert_eq!((staged["type"].as_str(), staged["size"].as_u64()), (Some("file"), Some(7)));
    assert!(staged["mtime"].as_i64().unwrap() > 1_600_000_000_000);
}

#[tokio::test]
async fn fs_list_orders_directories_first_then_by_name() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("fs.list", json!({ "path": "repo", "gitignore": true })).await;
    let order: Vec<String> = res["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| format!("{}:{}", e["type"].as_str().unwrap(), e["name"].as_str().unwrap()))
        .collect();
    let first_file = order.iter().position(|x| !x.starts_with("dir:")).unwrap();
    assert!(order[..first_file].iter().all(|x| x.starts_with("dir:")), "{order:?}");
    assert!(!order[first_file..].iter().any(|x| x.starts_with("dir:")), "{order:?}");
}

#[tokio::test]
async fn fs_list_lists_one_level_only_with_the_count_and_never_through_symlinks() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("fs.list", json!({ "path": "repo", "gitignore": true })).await;
    assert_eq!(res["total"].as_u64().unwrap() as usize, res["entries"].as_array().unwrap().len());
    assert!(!names(&res).iter().any(|n| n.contains('/')));
    let inside = c.request("fs.list", json!({ "path": "repo/src" })).await;
    assert_eq!(names(&inside), ["index.ts"]);
    refused(&c.request("fs.list", json!({ "path": "repo/escape" })).await, "outside-root");
}

#[tokio::test]
async fn fs_list_hides_git_and_gitignored_entries_when_asked_and_an_ignored_directory_still_lists_in_full() {
    let (_t, _d, mut c) = bench().await;
    let plain = names(&c.request("fs.list", json!({ "path": "repo" })).await);
    assert!(plain.contains(&"ignored.log".to_owned()));
    assert!(plain.contains(&".git".to_owned()));
    let filtered = names(&c.request("fs.list", json!({ "path": "repo", "gitignore": true })).await);
    for hidden in ["ignored.log", "build", "node_modules", ".git"] {
        assert!(!filtered.contains(&hidden.to_owned()), "{hidden} in {filtered:?}");
    }
    assert!(filtered.contains(&"untracked.txt".to_owned()));
    assert!(filtered.contains(&".gitignore".to_owned()));
    assert_eq!(names(&c.request("fs.list", json!({ "path": "repo/build", "gitignore": true })).await), ["out.js"]);
    let modules = c.request("fs.list", json!({ "path": "repo/node_modules", "gitignore": true })).await;
    assert_eq!(names(&modules), ["pkg"]);
    assert_eq!(modules["total"], 1);
    assert_eq!(names(&c.request("fs.list", json!({ "path": "repo/node_modules/pkg", "gitignore": true })).await), ["index.js"]);
}

#[tokio::test]
async fn fs_list_treats_the_gitignore_flag_as_a_no_op_outside_a_git_repo() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("fs.list", json!({ "path": ".", "gitignore": true })).await;
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(names(&res), ["big.bin", "bigrepo", "deep", "multibyte.txt", "repo"]);
}

#[tokio::test]
async fn fs_list_accepts_an_absolute_path_inside_the_root_and_refuses_one_outside() {
    let (t, _d, mut c) = bench().await;
    let inside = c.request("fs.list", json!({ "path": t.repo().join("src") })).await;
    assert_eq!(names(&inside), ["index.ts"]);
    refused(&c.request("fs.list", json!({ "path": t.outside() })).await, "outside-root");
}

#[tokio::test]
async fn fs_list_refuses_dot_dot_escapes_and_symlinks_that_leave_the_root_with_a_typed_error() {
    let (_t, _d, mut c) = bench().await;
    refused(&c.request("fs.list", json!({ "path": ".." })).await, "outside-root");
    refused(&c.request("fs.list", json!({ "path": "repo/../.." })).await, "outside-root");
    refused(&c.request("fs.list", json!({ "path": "repo/escape" })).await, "outside-root");
}

#[tokio::test]
async fn fs_list_types_a_file_target_and_a_missing_target() {
    let (_t, _d, mut c) = bench().await;
    refused(&c.request("fs.list", json!({ "path": "repo/docs.md" })).await, "not-a-directory");
    refused(&c.request("fs.list", json!({ "path": "repo/nope" })).await, "not-found");
    refused(&c.request("fs.list", json!({ "path": 7 })).await, "bad-request");
}

#[tokio::test]
async fn fs_read_reads_utf8_by_default_and_reports_the_byte_size() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("fs.read", json!({ "path": "repo/staged.txt" })).await;
    assert_eq!(res, json!({ "id": 1, "ok": true, "content": "staged\n", "size": 7, "truncated": false }));
    let mb = c.request("fs.read", json!({ "path": "multibyte.txt" })).await;
    assert_eq!(mb["content"], "héllo wörld\n");
    assert_eq!(mb["size"].as_u64(), Some("héllo wörld\n".len() as u64));
}

#[tokio::test]
async fn fs_read_reads_base64_when_asked() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("fs.read", json!({ "path": "repo/staged.txt", "encoding": "base64" })).await;
    assert_eq!(b64(res["content"].as_str().unwrap()), b"staged\n");
}

#[tokio::test]
async fn fs_read_follows_a_symlink_that_stays_inside_and_refuses_one_that_leaves() {
    let (_t, _d, mut c) = bench().await;
    let ok = c.request("fs.read", json!({ "path": "repo/docs-link.md" })).await;
    assert_eq!((ok["ok"].as_bool(), ok["content"].as_str()), (Some(true), Some("# readme\n")));
    refused(&c.request("fs.read", json!({ "path": "repo/escape/secret.txt" })).await, "outside-root");
}

#[tokio::test]
async fn fs_read_caps_content_at_2_mib_and_flags_the_cut() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("fs.read", json!({ "path": "big.bin", "encoding": "base64" })).await;
    assert_eq!(res["truncated"], true);
    assert_eq!(res["size"].as_u64(), Some(FS_READ_CAP_BYTES + 10));
    assert_eq!(b64(res["content"].as_str().unwrap()).len() as u64, FS_READ_CAP_BYTES);
}

#[tokio::test]
async fn fs_read_types_directories_missing_files_and_bad_encodings() {
    let (_t, _d, mut c) = bench().await;
    refused(&c.request("fs.read", json!({ "path": "repo/src" })).await, "not-a-file");
    refused(&c.request("fs.read", json!({ "path": "repo/none.txt" })).await, "not-found");
    refused(&c.request("fs.read", json!({ "path": "repo/docs.md", "encoding": "hex" })).await, "bad-request");
}

#[tokio::test]
async fn git_status_parses_the_branch_header_and_every_entry_kind_from_porcelain_v2() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("git.status", json!({ "cwd": "repo" })).await;
    assert_eq!(res["ok"], true, "{res}");
    let branch = &res["branch"];
    assert_eq!(branch["head"], "feature");
    let oid = branch["oid"].as_str().unwrap();
    assert!(oid.len() == 40 && oid.chars().all(|c| c.is_ascii_hexdigit()), "{oid}");
    assert_eq!((branch["ahead"].as_u64(), branch["behind"].as_u64()), (Some(0), Some(0)));
    assert!(branch.get("upstream").is_none(), "{branch}");
    let entries = res["entries"].as_array().unwrap();
    assert!(entries.contains(&json!({ "xy": ".M", "path": "src/index.ts" })), "{entries:?}");
    assert!(entries.contains(&json!({ "xy": "A.", "path": "staged.txt" })), "{entries:?}");
    assert!(entries.contains(&json!({ "xy": "R.", "path": "docs.md", "origPath": "README.md" })), "{entries:?}");
    assert!(entries.contains(&json!({ "xy": "??", "path": "untracked.txt" })), "{entries:?}");
    assert!(!entries.iter().any(|e| e["path"] == "ignored.log"));
}

#[tokio::test]
async fn git_status_reports_ahead_and_behind_against_an_upstream() {
    let (t, _d, mut c) = bench().await;
    git(&t.repo(), &["branch", "--set-upstream-to=main", "feature"]);
    let res = c.request("git.status", json!({ "cwd": "repo" })).await;
    assert_eq!(res["branch"]["upstream"], "main");
    assert_eq!((res["branch"]["ahead"].as_u64(), res["branch"]["behind"].as_u64()), (Some(1), Some(0)));
    git(&t.repo(), &["branch", "--unset-upstream", "feature"]);
}

#[tokio::test]
async fn git_status_works_from_a_subdirectory_reports_repo_relative_paths_and_names_the_top_level() {
    let (t, _d, mut c) = bench().await;
    let res = c.request("git.status", json!({ "cwd": "repo/src" })).await;
    let entries = res["entries"].as_array().unwrap();
    assert!(entries.contains(&json!({ "xy": ".M", "path": "src/index.ts" })), "{entries:?}");
    assert_eq!(res["root"], fs::canonicalize(t.repo()).unwrap().to_str().unwrap());
}

#[tokio::test]
async fn git_status_types_a_non_repo_and_a_confined_cwd() {
    let (_t, _d, mut c) = bench().await;
    refused(&c.request("git.status", json!({ "cwd": "." })).await, "not-a-git-repo");
    refused(&c.request("git.status", json!({ "cwd": "../" })).await, "outside-root");
}

#[tokio::test]
async fn git_diff_unstaged_is_the_working_tree_against_the_index() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("git.diff", json!({ "cwd": "repo", "scope": "unstaged" })).await;
    assert_eq!((res["ok"].as_bool(), res["base"].is_null(), res["truncated"].as_bool()), (Some(true), true, Some(false)), "{res}");
    assert_eq!(paths(&res), ["src/index.ts"]);
    let patch = patch_of(&res, "src/index.ts").unwrap();
    assert!(patch.contains("diff --git a/src/index.ts b/src/index.ts"));
    assert!(patch.contains("-export const a = 1;"));
    assert!(patch.contains("+export const a = 2;"));
}

#[tokio::test]
async fn git_diff_staged_is_the_index_against_head_renames_kept_as_renames() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("git.diff", json!({ "cwd": "repo", "scope": "staged" })).await;
    assert_eq!(paths(&res), ["docs.md", "staged.txt"]);
    assert!(patch_of(&res, "docs.md").unwrap().contains("rename from README.md"));
    assert!(patch_of(&res, "staged.txt").unwrap().contains("+staged"));
}

#[tokio::test]
async fn git_diff_branch_is_everything_since_the_merge_base_with_the_default_branch() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("git.diff", json!({ "cwd": "repo", "scope": "branch" })).await;
    assert_eq!(res["base"], "main");
    assert_eq!(paths(&res), ["docs.md", "feature.txt", "src/index.ts", "staged.txt"]);
    assert!(patch_of(&res, "feature.txt").unwrap().contains("+feature"));
}

#[tokio::test]
async fn git_diff_narrows_to_a_path() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("git.diff", json!({ "cwd": "repo", "scope": "branch", "path": "src" })).await;
    assert_eq!(paths(&res), ["src/index.ts"]);
    let none = c.request("git.diff", json!({ "cwd": "repo", "scope": "unstaged", "path": "feature.txt" })).await;
    assert_eq!((none["ok"].as_bool(), none["files"].as_array().map(Vec::len)), (Some(true), Some(0)), "{none}");
}

#[tokio::test]
async fn git_diff_from_a_subdirectory_reports_repo_relative_paths_with_their_patches() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("git.diff", json!({ "cwd": "repo/src", "scope": "unstaged" })).await;
    assert_eq!(paths(&res), ["src/index.ts"]);
    assert!(patch_of(&res, "src/index.ts").unwrap().contains("+export const a = 2;"), "{res}");
    let staged = c.request("git.diff", json!({ "cwd": "repo/src", "scope": "staged" })).await;
    assert_eq!(paths(&staged), ["docs.md", "staged.txt"]);
    assert!(patch_of(&staged, "docs.md").unwrap().contains("rename from README.md"), "{staged}");
}

#[tokio::test]
async fn git_diff_stays_clean_on_a_branch_with_nothing_to_show() {
    let (_t, _d, mut c) = bench().await;
    let res = c.request("git.diff", json!({ "cwd": "repo", "scope": "staged", "path": "src" })).await;
    assert_eq!(
        (res["ok"].as_bool(), res["files"].as_array().map(Vec::len), res["truncated"].as_bool()),
        (Some(true), Some(0), Some(false)),
        "{res}"
    );
}

#[tokio::test]
async fn git_diff_caps_the_total_patch_bytes_and_flags_the_cut_without_dropping_small_files_silently() {
    let (t, _d, mut c) = bench().await;
    build_big_repo(&t);
    let res = c.request("git.diff", json!({ "cwd": "bigrepo", "scope": "unstaged" })).await;
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["truncated"], true);
    let files = res["files"].as_array().unwrap();
    let total: usize = files.iter().map(|f| f["patch"].as_str().unwrap().len()).sum();
    assert!(total <= GIT_DIFF_CAP_BYTES, "{total}");
    let listed: Vec<&str> = files.iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(listed, ["large.txt", "small.txt"]);
    assert_eq!(patch_of(&res, "small.txt"), Some(""));
    assert!(patch_of(&res, "large.txt").unwrap().starts_with("diff --git a/large.txt b/large.txt"));
}

#[tokio::test]
async fn git_diff_types_bad_scopes_non_repos_and_confined_cwds() {
    let (_t, _d, mut c) = bench().await;
    refused(&c.request("git.diff", json!({ "cwd": "repo", "scope": "all" })).await, "bad-request");
    refused(&c.request("git.diff", json!({ "cwd": ".", "scope": "unstaged" })).await, "not-a-git-repo");
    refused(&c.request("git.diff", json!({ "cwd": "repo/escape", "scope": "unstaged" })).await, "outside-root");
}

#[tokio::test]
async fn roots_beyond_home_are_listed_and_read_what_is_outside_every_root_is_refused_and_a_later_line_counts_without_a_restart() {
    let t = build();
    let project = tempfile::Builder::new().prefix("wsp-fsgit-project-").tempdir().unwrap();
    fs::write(project.path().join("README.md"), "# proj\n").unwrap();
    fs::create_dir_all(t.root().join(".wsp")).unwrap();
    fs::write(t.roots_path(), format!("{}\n", project.path().display())).unwrap();
    let d = start(t.root(), &t.roots_path()).await;
    let mut c = Client::connect(d.addr).await;
    assert_eq!(names(&c.request("fs.list", json!({ "path": project.path() })).await), ["README.md"]);
    let read = c.request("fs.read", json!({ "path": project.path().join("README.md") })).await;
    assert_eq!((read["ok"].as_bool(), read["content"].as_str()), (Some(true), Some("# proj\n")));
    assert_eq!(c.request("fs.list", json!({ "path": "." })).await["ok"], true);
    let out = c.request("fs.list", json!({ "path": t.outside() })).await;
    refused(&out, "outside-root");
    assert_eq!(out["error"], format!("{} resolves outside the workspace root", t.outside().display()));
    refused(&c.request("git.status", json!({ "cwd": t.outside() })).await, "outside-root");
    fs::write(t.roots_path(), format!("{}\n{}\n", project.path().display(), t.outside().display())).unwrap();
    assert_eq!(c.request("fs.list", json!({ "path": t.outside() })).await["ok"], true);
}
