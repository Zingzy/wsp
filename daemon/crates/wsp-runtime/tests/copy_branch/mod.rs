// SPDX-License-Identifier: AGPL-3.0-only
//! The worktree verb's own tests, kept beside the crate's tests so branch.rs holds the road alone.

use super::*;
use crate::copy_road::rules::repo;
use std::os::unix::fs::PermissionsExt;

fn run(at: &Path, args: &[&'static str]) {
    run_line(at, GitLine::new(args));
}

fn run_line(at: &Path, line: GitLine) {
    let ran = git(at, &line, WRITE_MS).unwrap();
    assert!(ran.ok(), "{:?}: {}", line.argv(), ran.why());
}

/// A project holding what a checkout on this Mac holds: an ignored root and nested `node_modules` with a link
/// between them as pnpm writes, an ignored `.env.local`, and an ignored `target` nobody carries.
fn project(dir: &Path) -> PathBuf {
    let from = dir.join("work");
    repo(&from);
    fs::create_dir_all(from.join("packages/app")).unwrap();
    fs::write(from.join(".gitignore"), b"node_modules/\ntarget/\n*.local\n").unwrap();
    fs::write(from.join("packages/app/index.js"), b"app\n").unwrap();
    fs::write(from.join("pnpm-lock.yaml"), b"lockfileVersion: '9.0'\n").unwrap();
    run(&from, &["add", "."]);
    run(&from, &["commit", "--quiet", "-m", "app"]);
    fs::create_dir_all(from.join("node_modules/.pnpm/dep")).unwrap();
    fs::write(from.join("node_modules/.pnpm/dep/index.js"), b"dep\n").unwrap();
    fs::create_dir_all(from.join("packages/app/node_modules")).unwrap();
    std::os::unix::fs::symlink("../../../node_modules/.pnpm/dep", from.join("packages/app/node_modules/dep")).unwrap();
    fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
    fs::create_dir_all(from.join("target/debug")).unwrap();
    fs::write(from.join("target/debug/big"), b"built\n").unwrap();
    from
}

fn module(id: &str, lockfiles: &[&str], carry: &[&str], never: &[&str]) -> CarryModule {
    let owned = |names: &[&str]| names.iter().map(|n| (*n).to_owned()).collect();
    CarryModule { id: id.to_owned(), lockfiles: owned(lockfiles), carry: owned(carry), never: owned(never), installed: None }
}

fn found(id: &str, folder: &str, rebuild: bool) -> FoundModule {
    FoundModule { id: id.to_owned(), folder: folder.to_owned(), rebuild }
}

/// The modules the catalog hands the verb, as many as these tests need.
fn carry_names() -> Vec<CarryModule> {
    vec![
        CarryModule {
            installed: Some("node_modules/.pnpm/lock.yaml".to_owned()),
            ..module("pnpm", &["pnpm-lock.yaml"], &["node_modules"], &[])
        },
        module("npm", &["package-lock.json"], &["node_modules"], &[]),
        module("uv", &["uv.lock"], &[], &[".venv"]),
        module("poetry", &["poetry.lock"], &[], &[".venv"]),
        module("cargo", &["Cargo.lock"], &[], &["target"]),
        module("go", &["go.sum"], &[], &[]),
        module("composer", &["composer.lock"], &["vendor"], &[]),
    ]
}

fn ask<'a>(from: &'a Path, home: &'a Path, branch: &'a str, modules: &'a [CarryModule]) -> Ask<'a> {
    Ask { from, home, project: "prj_1", branch, modules }
}

/// A clone every disk refuses, so the carry writes every byte: what the tests of a removal's holds stand on,
/// whatever disk they run on.
fn plain(_: &Path, _: &Layer) -> io::Result<Took> {
    Err(io::Error::from_raw_os_error(libc::ENOTSUP))
}

/// A scratch folder that takes down whatever a test left mounted under it before it goes.
struct Scratch(tempfile::TempDir);

impl Scratch {
    fn path(&self) -> &Path {
        self.0.path()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        for at in mounts_under(self.0.path()) {
            let _ = nix::mount::umount2(Path::new(&at), nix::mount::MntFlags::MNT_DETACH);
        }
    }
}

fn scratch() -> Scratch {
    Scratch(tempfile::tempdir().unwrap())
}

/// The mount points under a folder as the kernel lists them, deepest first.
#[cfg(target_os = "linux")]
fn mounts_under(dir: &Path) -> Vec<String> {
    let root = fs::canonicalize(dir).unwrap().display().to_string();
    let listed = fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    let mut at: Vec<String> =
        listed.lines().filter_map(|l| l.split(' ').nth(4)).filter(|p| p.starts_with(&format!("{root}/"))).map(str::to_owned).collect();
    at.sort_by_key(|p| std::cmp::Reverse(p.len()));
    at
}

#[cfg(target_os = "linux")]
fn frozen_of(worktree: &Path) -> PathBuf {
    worktree.parent().unwrap().join(FROZEN)
}

fn worktrees(from: &Path) -> Vec<GitWorktree> {
    listed(from).unwrap()
}

#[cfg(target_os = "macos")]
#[test]
fn a_new_branch_gets_a_worktree_under_the_home_with_the_config_and_one_clone_per_dependency_directory() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CLONES: AtomicUsize = AtomicUsize::new(0);
    fn counted(from: &Path, layer: &Layer) -> io::Result<Took> {
        CLONES.fetch_add(1, Ordering::SeqCst);
        clone_dir(from, layer)
    }
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let head = sha_of(&from, "HEAD").unwrap();
    let names = carry_names();
    let report = make_with(&ask(&from, &home, "feat/x", &names), counted).unwrap();
    let at = fs::canonicalize(&home).unwrap().join("worktrees/prj_1/feat-x");
    assert_eq!(report.path, at.display().to_string());
    assert!(report.made);
    assert_eq!(report.branch, "feat/x");
    assert_eq!(report.carried, [".env.local", "node_modules", "packages/app/node_modules"]);
    assert!(report.plain.is_empty(), "{:?}", report.plain);
    assert!(report.fresh);
    assert_eq!(report.modules, [found("pnpm", ".", true)], "the folder's install left no record of its lockfile");
    assert_eq!(CLONES.load(Ordering::SeqCst), 2, "one clone per directory, never one per file");
    assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
    assert_eq!(
        fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(),
        "dep\n",
        "the link resolves inside the worktree"
    );
    assert_eq!(fs::read_to_string(at.join(".env.local")).unwrap(), "KEY=1\n");
    assert!(!at.join("target").exists(), "a directory nobody named is not carried");
    assert_eq!(fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(git(&at, &GitLine::new(&["rev-parse", "--abbrev-ref", "HEAD"]), READ_MS).unwrap().out(), "feat/x");
    assert_eq!(sha_of(&at, "HEAD").unwrap(), head, "a new branch starts at the folder's HEAD");
    assert_eq!(
        git(&at, &GitLine::new(&["status", "--porcelain"]), READ_MS).unwrap().out(),
        "",
        "what was carried is ignored, so the tree is clean"
    );
    assert_eq!(
        git(&from, &GitLine::new(&["rev-parse", "--abbrev-ref", "HEAD"]), READ_MS).unwrap().out(),
        "main",
        "the project folder stays on its branch"
    );
}

/// A project whose branch tracks these lockfiles and whose folder holds these ignored directories.
fn locked(dir: &Path, lockfiles: &[&str], dirs: &[&str]) -> PathBuf {
    let from = dir.join("work");
    repo(&from);
    let ignore: String = dirs.iter().map(|d| format!("{}/\n", d.split('/').next().unwrap())).collect();
    fs::write(from.join(".gitignore"), ignore).unwrap();
    for f in lockfiles {
        fs::write(from.join(f), b"lock\n").unwrap();
    }
    run(&from, &["add", "."]);
    run(&from, &["commit", "--quiet", "-m", "locks"]);
    for d in dirs {
        fs::create_dir_all(from.join(d)).unwrap();
        fs::write(from.join(d).join("f"), b"x\n").unwrap();
    }
    from
}

#[test]
fn each_module_whose_lockfile_the_branch_holds_carries_its_own_directories_and_never_a_path_bound_one() {
    let dir = scratch();
    let from = locked(dir.path(), &["uv.lock", "Cargo.lock", "go.sum"], &[".venv/bin", "target/debug", "node_modules/dep", "vendor/pkg"]);
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let report = make(&ask(&from, &home, "py", &modules)).unwrap();
    assert!(report.fresh);
    assert_eq!(
        report.modules,
        [found("uv", ".", true), found("cargo", ".", true), found("go", ".", true)],
        "a module that carries nothing always rebuilds"
    );
    assert!(report.carried.is_empty(), "{:?}", report.carried);
    let at = Path::new(&report.path);
    for d in [".venv", "target", "node_modules", "vendor"] {
        assert!(!at.join(d).exists(), "{d} was carried with no module of its own");
    }
    let again = make(&ask(&from, &home, "py", &modules)).unwrap();
    assert!(!again.fresh && again.modules.is_empty(), "{again:?}");

    let dir = scratch();
    let from = locked(dir.path(), &["pnpm-lock.yaml", "composer.lock"], &[".venv/bin", "node_modules/dep", "vendor/pkg", "target/debug"]);
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let report = make(&ask(&from, &home, "web", &modules)).unwrap();
    assert_eq!(report.modules, [found("pnpm", ".", true), found("composer", ".", true)]);
    assert_eq!(report.carried, ["node_modules", "vendor"]);
    let at = Path::new(&report.path);
    assert_eq!(fs::read_to_string(at.join("node_modules/dep/f")).unwrap(), "x\n");
    assert!(!at.join(".venv").exists() && !at.join("target").exists());
}

#[test]
fn a_module_rebuilds_unless_what_came_in_was_installed_from_the_lockfile_the_branch_holds() {
    let dir = scratch();
    let from = locked(dir.path(), &["pnpm-lock.yaml", "composer.lock"], &["node_modules/.pnpm"]);
    fs::write(from.join("node_modules/.pnpm/lock.yaml"), b"lock\n").unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let same = make_with(&ask(&from, &home, "same", &modules), plain).unwrap();
    assert_eq!(same.modules, [found("pnpm", ".", false)], "composer's lockfile counted where the folder installed no vendor");
    // A pull brought a new lockfile and nobody installed it: the folder's node_modules still record the old one.
    fs::write(from.join("pnpm-lock.yaml"), b"lock with zod 4\n").unwrap();
    run(&from, &["commit", "--quiet", "-am", "pull"]);
    let pulled = make_with(&ask(&from, &home, "pulled", &modules), plain).unwrap();
    assert_eq!(pulled.carried, ["node_modules"]);
    assert_eq!(pulled.modules[0], found("pnpm", ".", true), "node_modules installed from the old lockfile came in as built");
}

#[test]
fn a_directory_one_found_module_never_carries_is_not_carried_for_another() {
    let dir = scratch();
    let from = locked(dir.path(), &["a.lock", "b.lock"], &[".venv/bin"]);
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = [module("a", &["a.lock"], &[".venv"], &[]), module("b", &["b.lock"], &[], &[".venv"])];
    let report = make(&ask(&from, &home, "both", &modules)).unwrap();
    assert_eq!(report.modules, [found("a", ".", true), found("b", ".", true)]);
    assert!(report.carried.is_empty(), "{:?}", report.carried);
    assert!(!Path::new(&report.path).join(".venv").exists());
}

#[test]
fn a_lockfile_in_a_subfolder_carries_the_directories_under_it_and_rebuilds_in_that_folder() {
    let dir = scratch();
    let from = dir.path().join("work");
    repo(&from);
    for folder in ["web", "api", "docs"] {
        fs::create_dir_all(from.join(folder)).unwrap();
    }
    fs::write(from.join(".gitignore"), b"node_modules/\n.venv/\n").unwrap();
    // As Yarn documents it: a pattern with a slash in it holds for the folder of its own .gitignore.
    fs::write(from.join("docs/.gitignore"), b".yarn/cache/\n").unwrap();
    fs::write(from.join("web/package-lock.json"), b"lock\n").unwrap();
    fs::write(from.join("api/uv.lock"), b"lock\n").unwrap();
    fs::write(from.join("docs/yarn.lock"), b"lock\n").unwrap();
    run(&from, &["add", "."]);
    run(&from, &["commit", "--quiet", "-m", "apps"]);
    for d in ["web/node_modules/dep", "api/.venv/bin", "docs/.yarn/cache", "node_modules/stray"] {
        fs::create_dir_all(from.join(d)).unwrap();
        fs::write(from.join(d).join("f"), b"x\n").unwrap();
    }
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let mut modules = carry_names();
    modules.push(module("yarn", &["yarn.lock"], &["node_modules", ".yarn/cache"], &[]));
    let report = make_with(&ask(&from, &home, "sub", &modules), plain).unwrap();
    assert_eq!(report.carried, ["docs/.yarn/cache", "web/node_modules"], "the top's node_modules has no lockfile above it");
    assert_eq!(report.modules, [found("uv", "api", true), found("yarn", "docs", true), found("npm", "web", true)]);
    let at = Path::new(&report.path);
    assert_eq!(fs::read_to_string(at.join("web/node_modules/dep/f")).unwrap(), "x\n");
    assert!(!at.join("api/.venv").exists() && !at.join("node_modules").exists());
}

/// The Linux road on any disk: a frozen copy of the folder's directory, and an overlay over it.
#[cfg(target_os = "linux")]
fn overlaid(from: &Path, layer: &Layer) -> io::Result<Took> {
    freeze(from, &layer.beside, &layer.frozen)?;
    overlay(&layer.beside, &frozen_name(&layer.frozen), &layer.worktree, &layer.at, &layer.dir).map(|()| Took::Overlay)
}

#[cfg(target_os = "linux")]
fn frozen_names(worktree: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(frozen_of(worktree))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != NEWEST)
        .collect();
    names.sort();
    names
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn an_overlaid_worktree_keeps_its_dependencies_when_the_folder_reinstalls_and_a_new_lockfile_gets_copies_of_its_own() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let a = make_with(&ask(&from, &home, "a", &modules), overlaid).unwrap();
    assert_eq!(a.overlaid, ["node_modules", "packages/app/node_modules"]);
    let at = PathBuf::from(&a.path);
    let dep = |worktree: &str| fs::read_to_string(Path::new(worktree).join("node_modules/.pnpm/dep/index.js")).unwrap();
    // The folder's dependencies taken away and installed again, as rm -rf node_modules and an install do.
    fs::remove_dir_all(from.join("node_modules")).unwrap();
    assert_eq!(dep(&a.path), "dep\n", "the worktree read the folder's own directory");
    fs::create_dir_all(from.join("node_modules/.pnpm/dep")).unwrap();
    fs::write(from.join("node_modules/.pnpm/dep/index.js"), b"reinstalled\n").unwrap();
    fs::write(from.join("node_modules/.pnpm/extra.js"), b"x\n").unwrap();
    assert_eq!(dep(&a.path), "dep\n");
    assert_eq!(fs::read_dir(at.join("node_modules/.pnpm")).unwrap().count(), 1);
    assert_eq!(fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(), "dep\n");
    // Another worktree of the same lockfile sits on the same frozen copies, one per carried directory.
    let b = make_with(&ask(&from, &home, "b", &modules), overlaid).unwrap();
    assert_eq!(dep(&b.path), "dep\n");
    let first = frozen_names(&at);
    assert_eq!(first.len(), 2, "{first:?}");
    // A new lockfile freezes what the folder holds now, beside the copies the standing worktrees sit on.
    fs::write(from.join("pnpm-lock.yaml"), b"lockfileVersion: '9.1'\n").unwrap();
    run(&from, &["commit", "--quiet", "-am", "bump"]);
    let c = make_with(&ask(&from, &home, "c", &modules), overlaid).unwrap();
    assert_eq!(dep(&c.path), "reinstalled\n");
    assert_eq!(frozen_names(&at).len(), 4);
    // Once no worktree sits on the old copies, the next make takes them away.
    remove(&from, &home, Path::new(&a.path), false).unwrap();
    remove(&from, &home, Path::new(&b.path), false).unwrap();
    let d = make_with(&ask(&from, &home, "d", &modules), overlaid).unwrap();
    assert_eq!(dep(&d.path), "reinstalled\n");
    let left = frozen_names(&at);
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(left.iter().all(|n| !first.contains(n)), "{left:?} {first:?}");
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn an_overlay_comes_back_over_its_own_upper_after_a_restart_and_never_over_what_was_written_while_it_was_down() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    fs::set_permissions(from.join("node_modules"), fs::Permissions::from_mode(0o755)).unwrap();
    let modules = carry_names();
    let report = make_with(&ask(&from, &home, "lay", &modules), overlaid).unwrap();
    let at = PathBuf::from(&report.path);
    assert_eq!(fs::metadata(at.join("node_modules")).unwrap().permissions().mode() & 0o777, 0o755, "the top took upper's mode");
    assert_eq!(fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(), "dep\n");
    fs::write(at.join("node_modules/.pnpm/dep/index.js"), b"edited\n").unwrap();
    fs::write(at.join("node_modules/new.js"), b"new\n").unwrap();
    assert_eq!(fs::read_to_string(from.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n", "a write reached the folder");
    assert!(!from.join("node_modules/new.js").exists());
    assert_eq!(git(&at, &GitLine::new(&["status", "--porcelain"]), READ_MS).unwrap().out(), "");

    // A restart takes the mounts down; the next turn mounts them again over what was written through them.
    unmount_layers(&at);
    assert!(!at.join("node_modules/new.js").exists(), "the mount is still there");
    mount(&from, &home, &at).unwrap();
    assert_eq!(fs::read_to_string(at.join("node_modules/new.js")).unwrap(), "new\n", "the overlay did not come back");
    assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "edited\n");

    // Down again, and an install into the bare folder meanwhile is left in sight rather than mounted over.
    unmount_layers(&at);
    fs::write(at.join("packages/app/node_modules/installed.js"), b"bare\n").unwrap();
    mount(&from, &home, &at).unwrap();
    assert_eq!(fs::read_to_string(at.join("packages/app/node_modules/installed.js")).unwrap(), "bare\n", "a mount hid it");
    assert_eq!(fs::read_to_string(at.join("node_modules/new.js")).unwrap(), "new\n");
    assert!(mount(&from, &home, &from).is_err(), "the project folder is no worktree wsp made");
    fs::remove_file(at.join("packages/app/node_modules/installed.js")).unwrap();

    remove(&from, &home, &at, false).unwrap();
    assert!(!at.exists());
    assert!(mounts_under(dir.path()).is_empty(), "{:?}", mounts_under(dir.path()));
    assert!(!layers_of(&at).exists());
    assert_eq!(fs::read_to_string(from.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn a_link_put_on_the_way_to_a_mount_point_mounts_nothing_where_it_leads_and_takes_nothing_down_there() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let at = PathBuf::from(make_with(&ask(&from, &home, "link", &modules), overlaid).unwrap().path);
    unmount_layers(&at);
    // While the mounts were down the agent put a link to a folder of its own where packages/app was.
    let elsewhere = dir.path().join("elsewhere");
    fs::create_dir_all(elsewhere.join("node_modules")).unwrap();
    fs::rename(at.join("packages/app"), at.join("app-moved")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, at.join("packages/app")).unwrap();
    mount(&from, &home, &at).unwrap();
    assert!(!elsewhere.join("node_modules/dep").exists(), "an overlay was mounted where the link leads");
    assert!(at.join("node_modules/.pnpm/dep/index.js").exists(), "the overlay with no link on its way stayed down");
    // A mount where the link leads is not taken down through it.
    let lower = dir.path().join("lower");
    fs::create_dir_all(&lower).unwrap();
    fs::write(lower.join("kept"), b"kept\n").unwrap();
    overlay(dir.path(), "lower", &elsewhere, "node_modules", "elsewhere-layer").unwrap();
    unmount_layers(&at);
    assert_eq!(fs::read_to_string(elsewhere.join("node_modules/kept")).unwrap(), "kept\n", "a mount was taken down through a link");
}

#[test]
fn a_lockfile_where_the_folder_installed_nothing_of_its_module_costs_no_install() {
    let dir = scratch();
    let from = dir.path().join("work");
    repo(&from);
    for folder in ["web", "fixtures/npm", "fixtures/uv", "fixtures/go"] {
        fs::create_dir_all(from.join(folder)).unwrap();
    }
    fs::write(
        from.join(".gitignore"),
        b"node_modules/
.venv/
",
    )
    .unwrap();
    for lockfile in ["go.sum", "web/package-lock.json", "fixtures/npm/package-lock.json", "fixtures/uv/uv.lock", "fixtures/go/go.sum"] {
        fs::write(from.join(lockfile), b"lock\n").unwrap();
    }
    run(&from, &["add", "."]);
    run(&from, &["commit", "--quiet", "-m", "fixtures"]);
    fs::create_dir_all(from.join("web/node_modules/dep")).unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let report = make_with(&ask(&from, &home, "fixtures", &carry_names()), plain).unwrap();
    assert_eq!(report.modules, [found("go", ".", true), found("npm", "web", true)], "a fixture's lockfile asked for an install");
    assert_eq!(report.carried, ["web/node_modules"]);
}

#[test]
fn a_module_that_carries_nothing_counts_at_the_top_wherever_its_environment_sits_and_a_nested_fixture_still_costs_nothing() {
    let dir = scratch();
    let lockfiles =
        ["uv.lock", "poetry.lock", "Cargo.lock", "fixtures/uv/uv.lock", "fixtures/poetry/poetry.lock", "fixtures/cargo/Cargo.lock"];
    let from = dir.path().join("work");
    repo(&from);
    for lockfile in lockfiles {
        fs::create_dir_all(from.join(lockfile).parent().unwrap()).unwrap();
        fs::write(from.join(lockfile), b"lock\n").unwrap();
    }
    run(&from, &["add", "."]);
    run(&from, &["commit", "--quiet", "-m", "locks"]);
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let report = make_with(&ask(&from, &home, "elsewhere", &carry_names()), plain).unwrap();
    assert_eq!(report.modules, [found("uv", ".", true), found("poetry", ".", true), found("cargo", ".", true)]);
    assert!(report.carried.is_empty(), "{:?}", report.carried);
}

#[test]
fn a_frozen_copy_is_named_by_the_install_record_where_the_module_keeps_one_and_by_the_lockfile_where_it_does_not() {
    let dir = scratch();
    let from = locked(dir.path(), &["pnpm-lock.yaml", "package-lock.json"], &["node_modules/.pnpm"]);
    fs::write(from.join("node_modules/.pnpm/lock.yaml"), b"lock\n").unwrap();
    let modules = carry_names();
    let by = |id: &str, lockfile: &str| {
        frozen_key(
            &from,
            "node_modules",
            &Found { module: modules.iter().find(|m| m.id == id).unwrap(), folder: String::new(), lockfile: lockfile.to_owned() },
        )
    };
    let (pnpm, npm) = (by("pnpm", "pnpm-lock.yaml"), by("npm", "package-lock.json"));
    // A pull brings lockfiles nobody installed: what the folder holds is the same bytes.
    fs::write(from.join("pnpm-lock.yaml"), b"pulled\n").unwrap();
    fs::write(from.join("package-lock.json"), b"pulled\n").unwrap();
    assert_eq!(by("pnpm", "pnpm-lock.yaml"), pnpm, "a lockfile nobody installed named a second copy of the same bytes");
    assert_ne!(by("npm", "package-lock.json"), npm, "npm keeps no record, so its lockfile names the copy");
    fs::write(from.join("node_modules/.pnpm/lock.yaml"), b"pulled\n").unwrap();
    assert_ne!(by("pnpm", "pnpm-lock.yaml"), pnpm, "a new install kept the old copy's name");
}

#[cfg(target_os = "linux")]
#[test]
fn a_carry_whose_overlay_the_kernel_refuses_writes_no_frozen_copy_and_copies_each_folder_once() {
    fn refused(from: &Path, layer: &Layer) -> io::Result<Took> {
        clone_linux(from, layer, |_| false)
    }
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let report = make_with(&ask(&from, &home, "refused", &carry_names()), refused).unwrap();
    let at = Path::new(&report.path);
    if crate::copy_reflink::clones_into(&from, at.parent().unwrap()) {
        return;
    }
    assert_eq!(report.plain, ["node_modules", "packages/app/node_modules"]);
    assert!(report.overlaid.is_empty());
    assert_eq!(frozen_names(at), Vec::<String>::new(), "a frozen copy was made for a mount that was never going to happen");
    let beside: Vec<String> =
        fs::read_dir(at.parent().unwrap()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert!(!beside.iter().any(|n| n.contains("frozen-")), "{beside:?}");
    assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
    if unsafe { libc::geteuid() } != 0 {
        assert!(!may_mount(at.parent().unwrap()), "a login that is not root read as one that may mount");
    }
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn the_newest_frozen_set_stays_as_a_cache_an_older_one_goes_with_its_last_worktree_and_forget_takes_every_one() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let a = PathBuf::from(make_with(&ask(&from, &home, "a", &modules), overlaid).unwrap().path);
    let first = frozen_names(&a);
    assert_eq!(first.len(), 2, "{first:?}");
    fs::write(from.join("pnpm-lock.yaml"), b"lockfileVersion: '9.1'\n").unwrap();
    run(&from, &["commit", "--quiet", "-am", "bump"]);
    let b = PathBuf::from(make_with(&ask(&from, &home, "b", &modules), overlaid).unwrap().path);
    assert_eq!(frozen_names(&a).len(), 4);
    let second: Vec<String> = frozen_names(&a).into_iter().filter(|n| !first.contains(n)).collect();
    // The older set goes with the last worktree that sat on it, not at some later make.
    remove(&from, &home, &a, false).unwrap();
    assert_eq!(frozen_names(&b), second, "the older set outlived its last worktree");
    // The newest stays once no worktree sits on it, and the next worktree reuses it.
    remove(&from, &home, &b, false).unwrap();
    assert_eq!(frozen_names(&b), second, "the newest set went with its last worktree");
    let c = PathBuf::from(make_with(&ask(&from, &home, "c", &modules), overlaid).unwrap().path);
    assert_eq!(frozen_names(&c), second, "the next worktree made copies of its own");
    assert_eq!(fs::read_to_string(c.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
    remove(&from, &home, &c, false).unwrap();
    // The project going takes every set, and its folders once they are empty.
    forget(&from, &home, "prj_1").unwrap();
    assert!(!frozen_of(&c).exists(), "{:?}", fs::read_dir(frozen_of(&c)).map(|e| e.count()));
    assert!(forget(&from, &home, "../out").is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn forget_takes_every_frozen_set_and_the_projects_folder_at_once_even_where_the_project_folder_is_gone() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    let beside = home.join("worktrees").join("prj_1");
    fs::create_dir_all(&beside).unwrap();
    freeze(&from.join("node_modules"), &beside, "older").unwrap();
    freeze(&from.join("node_modules"), &beside, "newest").unwrap();
    keep_newest(&beside, &["newest".to_owned()]);
    fs::remove_dir_all(&from).unwrap();
    forget(&from, &home, "prj_1").unwrap();
    assert!(!beside.exists(), "{:?}", fs::read_dir(&beside).map(|e| e.flatten().map(|e| e.file_name()).collect::<Vec<_>>()));
    assert!(home.join("worktrees").exists());
}

/// The layer folder of the record mounted at `rel`.
#[cfg(target_os = "linux")]
fn layer_at(worktree: &Path, rel: &str) -> PathBuf {
    fs::read_dir(layers_of(worktree))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| fs::read_to_string(p.join(LAYER_AT)).is_ok_and(|at| at == rel))
        .unwrap()
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn two_remounts_at_once_leave_one_mount_per_record_and_a_removal_takes_down_what_is_stacked() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let at = PathBuf::from(make_with(&ask(&from, &home, "both", &modules), overlaid).unwrap().path);
    assert_eq!(mounts_under(&at).len(), 2);
    for _ in 0..20 {
        unmount_layers(&at);
        std::thread::scope(|s| {
            for _ in 0..2 {
                s.spawn(|| mount(&from, &home, &at).unwrap());
            }
        });
        assert_eq!(mounts_under(&at).len(), 2, "{:?}", mounts_under(&at));
    }
    // A mount stacked over one of ours, as two remounts at once once left, goes with the removal.
    nix::mount::mount(Some("tmpfs"), &at.join("node_modules"), Some("tmpfs"), nix::mount::MsFlags::empty(), None::<&str>).unwrap();
    remove(&from, &home, &at, false).unwrap();
    assert!(mounts_under(dir.path()).is_empty(), "{:?}", mounts_under(dir.path()));
    assert!(!at.exists());
    assert_eq!(worktrees(&from).len(), 1);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn a_removal_over_a_mount_wsp_did_not_make_leaves_the_worktree_and_git_record_as_they_were() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let at = PathBuf::from(make_with(&ask(&from, &home, "foreign", &modules), overlaid).unwrap().path);
    fs::create_dir_all(at.join("packages/app/cache")).unwrap();
    nix::mount::mount(Some("tmpfs"), &at.join("packages/app/cache"), Some("tmpfs"), nix::mount::MsFlags::empty(), None::<&str>).unwrap();
    let refused = remove(&from, &home, &at, true).unwrap_err();
    assert_eq!(refused, mounted_inside(&at, 1));
    assert_eq!(worktrees(&from).len(), 2, "git forgot a worktree that still stands");
    assert_eq!(mounts_under(&at).len(), 3, "{:?}", mounts_under(&at));
    assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
    nix::mount::umount2(&at.join("packages/app/cache"), nix::mount::MntFlags::MNT_DETACH).unwrap();
    remove(&from, &home, &at, true).unwrap();
    assert!(mounts_under(dir.path()).is_empty() && !at.exists());
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn a_link_in_the_layers_or_the_frozen_folder_hands_the_kernel_nothing_outside_them() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let at = PathBuf::from(make_with(&ask(&from, &home, "links", &modules), overlaid).unwrap().path);
    unmount_layers(&at);
    let outside = dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    let upper = layer_at(&at, "node_modules").join("upper");
    fs::rename(&upper, upper.with_file_name("upper-moved")).unwrap();
    std::os::unix::fs::symlink(&outside, &upper).unwrap();
    mount(&from, &home, &at).unwrap();
    fs::write(at.join("node_modules/through.txt"), b"written\n").unwrap();
    assert!(!outside.join("through.txt").exists(), "a write in the worktree landed where the link at upper leads");
    assert_eq!(mounts_under(&at).len(), 1, "{:?}", mounts_under(&at));
    fs::remove_file(at.join("node_modules/through.txt")).unwrap();

    // The frozen folder swapped for a link to a folder of the agent's choosing mounts nothing over it.
    unmount_layers(&at);
    let frozen = frozen_of(&at);
    let planted = dir.path().join("planted");
    fs::rename(&frozen, &planted).unwrap();
    std::os::unix::fs::symlink(&planted, &frozen).unwrap();
    mount(&from, &home, &at).unwrap();
    assert!(mounts_under(&at).is_empty(), "{:?}", mounts_under(&at));
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "drives the kernel as root: run the live executable on a box with --ignored"]
fn a_fifo_where_a_layer_record_was_is_never_read_and_holds_neither_a_mount_nor_a_make() {
    assert!(nix::unistd::geteuid().is_root(), "{}", crate::LIVE_REASON);
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let modules = carry_names();
    let at = PathBuf::from(make_with(&ask(&from, &home, "fifo", &modules), overlaid).unwrap().path);
    unmount_layers(&at);
    let fifo = |p: &Path| {
        fs::remove_file(p).unwrap();
        nix::unistd::mkfifo(p, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
    };
    fifo(&layer_at(&at, "node_modules").join(LAYER_LOWER));
    fifo(&layer_at(&at, "packages/app/node_modules").join(LAYER_AT));
    let (from2, home2, at2) = (from.clone(), home.clone(), at.clone());
    let (said, heard) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        mount(&from2, &home2, &at2).unwrap();
        let other = make_with(&ask(&from2, &home2, "other", &carry_names()), overlaid).unwrap();
        said.send(other.path).unwrap();
    });
    let other = heard.recv_timeout(std::time::Duration::from_secs(20)).expect("a FIFO record held the mount or the make");
    assert!(mounts_under(&at).is_empty(), "{:?}", mounts_under(&at));
    assert_eq!(mounts_under(Path::new(&other)).len(), 2);
}

#[test]
fn an_existing_branch_twenty_commits_ahead_is_checked_out_where_its_tip_stands() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    run(&from, &["checkout", "--quiet", "-b", "ahead"]);
    fs::write(from.join(".env.local"), b"BRANCH=1\n").unwrap();
    run(&from, &["add", "--force", ".env.local"]);
    for n in 0..20 {
        fs::write(from.join("README.md"), format!("{n}\n")).unwrap();
        run_line(&from, GitLine::new(&["commit", "--quiet", "-a"]).value("-m", &format!("turn {n}")));
    }
    let tip = sha_of(&from, "ahead").unwrap();
    run(&from, &["checkout", "--quiet", "main"]);
    fs::write(from.join(".env.local"), b"KEY=1\n").unwrap();
    let main = sha_of(&from, "main").unwrap();
    let report = make(&ask(&from, &home, "ahead", &[])).unwrap();
    assert!(report.made);
    assert_eq!(sha_of(&from, "refs/heads/ahead").unwrap(), tip, "the branch moved");
    assert_eq!(sha_of(Path::new(&report.path), "HEAD").unwrap(), tip);
    assert_eq!(sha_of(&from, "main").unwrap(), main);
    assert_eq!(fs::read_to_string(Path::new(&report.path).join("README.md")).unwrap(), "19\n");
    assert_eq!(
        fs::read_to_string(Path::new(&report.path).join(".env.local")).unwrap(),
        "BRANCH=1\n",
        "the branch's own file was overwritten"
    );
    assert!(!report.carried.contains(&".env.local".to_owned()));
}

#[test]
fn a_branch_a_worktree_already_holds_is_answered_with_that_worktree_and_nothing_is_made() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let hand = dir.path().join("by-hand");
    run_line(&from, GitLine::new(&["worktree", "add", "--quiet", "-b", "mine"]).operands(&[&hand.to_string_lossy()]));
    let report = make(&ask(&from, &home, "mine", &carry_names())).unwrap();
    assert_eq!(report.path, fs::canonicalize(&hand).unwrap().display().to_string());
    assert!(!report.made, "a worktree the person made is never wsp's");
    assert!(report.carried.is_empty());
    assert!(!home.join("worktrees").exists(), "nothing was made under the home");
    // The project folder's own branch is held by the project folder.
    let report = make(&ask(&from, &home, "main", &[])).unwrap();
    assert_eq!(report.path, fs::canonicalize(&from).unwrap().display().to_string());
    assert!(!report.made);
    // A worktree wsp made earlier is found again and is still wsp's.
    let first = make(&ask(&from, &home, "again", &[])).unwrap();
    let second = make(&ask(&from, &home, "again", &[])).unwrap();
    assert_eq!(second.path, first.path);
    assert!(first.made && second.made);
}

#[test]
fn two_branches_with_one_folder_name_get_two_folders() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let a = make(&ask(&from, &home, "feat/x", &[])).unwrap();
    let b = make(&ask(&from, &home, "feat-x", &[])).unwrap();
    assert!(a.path.ends_with("/prj_1/feat-x"), "{}", a.path);
    assert!(b.path.ends_with("/prj_1/feat-x-2"), "{}", b.path);
}

#[test]
fn a_project_on_another_volume_than_the_home_keeps_its_worktrees_on_its_own_volume() {
    let home = Path::new("/Users/me/.wsp");
    assert_eq!(root_of(home, 1, Path::new("/"), 1), PathBuf::from("/Users/me/.wsp/worktrees"));
    assert_eq!(root_of(home, 1, Path::new("/Volumes/stick"), 2), PathBuf::from("/Volumes/stick/.wsp/worktrees"));
    let dir = scratch();
    let mount = mount_of(&fs::canonicalize(dir.path()).unwrap());
    assert!(dir.path().canonicalize().unwrap().starts_with(&mount), "{}", mount.display());
    let stick = mount.join(".wsp/worktrees/prj_1/feat-x");
    assert!(made_here(&stick, Path::new("/nowhere")), "a worktree under the volume's own root is wsp's");
}

#[test]
fn a_name_that_is_not_one_folder_or_not_a_branch_is_refused_before_anything_is_written() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    for branch in ["-f", "a..b", "x.lock", "a b"] {
        let refused = make(&ask(&from, &home, branch, &[])).unwrap_err();
        assert_eq!(refused, format!("{branch} is not a name git takes for a branch"));
    }
    let climbing = Ask { project: "../out", ..ask(&from, &home, "ok", &[]) };
    assert!(make(&climbing).unwrap_err().contains("is not a project id"));
    let carried = [module("x", &["x.lock"], &["../x"], &[])];
    assert!(make(&ask(&from, &home, "ok", &carried)).unwrap_err().contains("is not a carried directory name"));
    let locked = [module("x", &["../x.lock"], &[], &[])];
    assert!(make(&ask(&from, &home, "ok", &locked)).unwrap_err().contains("is not a lockfile name"));
    assert!(!home.join("worktrees").exists());
    assert!(make(&ask(&from.join("packages"), &home, "ok", &[])).unwrap_err().contains("is not the top of a git repository"));
}

#[test]
fn a_directory_a_clone_cannot_take_is_copied_byte_for_byte_with_its_links_kept() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let names = carry_names();
    let report = make_with(&ask(&from, &home, "plain", &names), plain).unwrap();
    assert_eq!(report.plain, ["node_modules", "packages/app/node_modules"]);
    let at = Path::new(&report.path);
    assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
    assert!(fs::symlink_metadata(at.join("packages/app/node_modules/dep")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(), "dep\n");
}

#[test]
fn a_carry_that_fails_leaves_no_worktree_and_no_new_branch() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let locked = from.join("node_modules/.pnpm/dep/index.js");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let names = carry_names();
    let refused = make_with(&ask(&from, &home, "half", &names), plain).unwrap_err();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(refused.contains("node_modules"), "{refused}");
    assert!(!has_branch(&from, "half"), "the branch the failed call made is still there");
    assert_eq!(worktrees(&from).len(), 1);
    let leaf = fs::canonicalize(&home).unwrap().join("worktrees/prj_1/half");
    assert!(!leaf.exists());
}

#[test]
fn a_worktree_with_uncommitted_files_stays_unless_forced_and_a_clean_one_goes_with_its_branch_kept() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let names = carry_names();
    let report = make(&ask(&from, &home, "work", &names)).unwrap();
    let at = PathBuf::from(&report.path);
    fs::write(at.join("README.md"), b"edited\n").unwrap();
    fs::write(at.join("new.txt"), b"untracked\n").unwrap();
    let refused = remove(&from, &home, &at, false).unwrap_err();
    assert_eq!(refused, uncommitted(&at, 2));
    assert_eq!(
        refused,
        format!("{} has 2 files not committed, so it was not removed; commit them, or remove it with --force", at.display())
    );
    assert!(at.join("new.txt").is_file() && at.join("node_modules/.pnpm/dep/index.js").is_file(), "a refused removal took something");
    run(&at, &["add", "."]);
    run(&at, &["commit", "--quiet", "-m", "work"]);
    let tip = sha_of(&at, "HEAD").unwrap();
    let removed = remove(&from, &home, &at, false).unwrap();
    assert_eq!(removed, WorktreeRemoval { path: at.display().to_string(), rescued: None });
    assert!(!at.exists());
    assert!(held_beside(&at).is_empty(), "a removal git agreed to left its directories held, where no sweep takes them");
    assert_eq!(sha_of(&from, "refs/heads/work").unwrap(), tip, "the branch keeps its commits");
    assert_eq!(worktrees(&from).len(), 1);
    // Forced, the files go with it.
    let report = make(&ask(&from, &home, "scratch", &names)).unwrap();
    let at = PathBuf::from(&report.path);
    fs::write(at.join("new.txt"), b"untracked\n").unwrap();
    remove(&from, &home, &at, true).unwrap();
    assert!(!at.exists());
}

#[test]
fn a_removal_git_refuses_leaves_the_worktree_as_it_was() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let names = carry_names();
    let at = PathBuf::from(make(&ask(&from, &home, "held", &names)).unwrap().path);
    run_line(&from, GitLine::new(&["worktree", "lock"]).operands(&[&at.to_string_lossy()]));
    // A make for another branch sweeps this project's folder while git is still deciding; what the removal
    // holds aside is not the sweep's to take.
    let swept = |beside: &Path| {
        let failed = sweep([beside], |p| fs::remove_dir_all(p));
        assert!(failed.is_empty(), "{failed:?}");
    };
    let refused = remove_with(&from, &home, &at, false, &swept).unwrap_err();
    assert_eq!(refused, "fatal: cannot remove a locked working tree;");
    assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n", "the dependencies went with a refusal");
    assert!(at.join("packages/app/node_modules/dep").exists());
    assert!(held_beside(&at).is_empty(), "a refusal left something held beside the worktree");
}

fn make_with_plain(ask: &Ask) -> Result<WorktreeReport, String> {
    make_with(ask, plain)
}

fn held_beside(at: &Path) -> Vec<String> {
    fs::read_dir(at.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(HOLDING_PREFIX))
        .collect()
}

#[test]
fn nothing_is_carried_through_a_link_the_branch_tracks() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    run(&from, &["checkout", "--quiet", "-b", "linked"]);
    run(&from, &["rm", "--quiet", "-r", "packages/app"]);
    fs::remove_dir_all(from.join("packages/app")).unwrap();
    std::os::unix::fs::symlink(&outside, from.join("packages/app")).unwrap();
    run(&from, &["add", "packages/app"]);
    run(&from, &["commit", "--quiet", "-m", "link"]);
    run(&from, &["checkout", "--quiet", "main"]);
    fs::create_dir_all(from.join("packages/app/node_modules/pkg")).unwrap();
    let names = carry_names();
    let report = make(&ask(&from, &home, "linked", &names)).unwrap();
    assert!(!report.carried.contains(&"packages/app/node_modules".to_owned()), "{:?}", report.carried);
    assert!(!outside.join("node_modules").exists(), "a directory was carried out of the worktree");
    assert!(report.carried.contains(&"node_modules".to_owned()));
}

/// The id of a process that has exited, and a moment older than a git write may take.
fn killed() -> (u32, u128) {
    let mut done = std::process::Command::new("true").spawn().unwrap();
    let pid = done.id();
    done.wait().unwrap();
    (pid, now_nanos() - u128::from(WRITE_MS + 1_000) * 1_000_000)
}

fn beside_names(at: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(at.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(HOLDING_PREFIX))
        .collect();
    names.sort();
    names
}

#[test]
fn a_hold_a_killed_removal_left_goes_back_into_its_worktree_at_the_next_make() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let names = carry_names();
    let at = PathBuf::from(make_with_plain(&ask(&from, &home, "held", &names)).unwrap().path);
    let (pid, then) = killed();
    let held = hold_as(&at, pid, then);
    assert_eq!(held.len(), 2, "{held:?}");
    assert!(!at.join("node_modules").exists() && beside_names(&at).len() == 4, "{:?}", beside_names(&at));
    make_with_plain(&ask(&from, &home, "other", &names)).unwrap();
    assert_eq!(fs::read_to_string(at.join("node_modules/.pnpm/dep/index.js")).unwrap(), "dep\n");
    assert_eq!(fs::read_to_string(at.join("packages/app/node_modules/dep/index.js")).unwrap(), "dep\n");
    assert!(beside_names(&at).is_empty(), "{:?}", beside_names(&at));
    assert_eq!(git(&at, &GitLine::new(&["status", "--porcelain"]), READ_MS).unwrap().out(), "");
}

#[test]
fn a_hold_whose_process_lives_or_that_is_younger_than_a_git_write_stays_where_it_is() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let names = carry_names();
    let at = PathBuf::from(make_with_plain(&ask(&from, &home, "held", &names)).unwrap().path);
    let (dead, then) = killed();
    hold_as(&at, std::process::id(), then);
    make_with_plain(&ask(&from, &home, "other", &names)).unwrap();
    assert!(!at.join("node_modules").exists(), "a hold whose process lives was taken");
    let living = beside_names(&at);
    for name in living.iter().filter(|n| !n.ends_with(FROM_SUFFIX)) {
        let held = at.parent().unwrap().join(name);
        let fresh =
            at.parent().unwrap().join(name.replace(&format!("-{}-{then}-", std::process::id()), &format!("-{dead}-{}-", now_nanos())));
        fs::rename(&held, &fresh).unwrap();
        fs::rename(sidecar(&held), sidecar(&fresh)).unwrap();
    }
    make_with_plain(&ask(&from, &home, "third", &names)).unwrap();
    assert!(!at.join("node_modules").exists(), "a hold younger than a git write was taken");
    assert_eq!(beside_names(&at).len(), 4);
}

#[test]
fn a_hold_whose_worktree_git_already_removed_goes_on_its_way_out_at_the_next_removal() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let names = carry_names();
    let gone = PathBuf::from(make_with_plain(&ask(&from, &home, "gone", &names)).unwrap().path);
    let kept = PathBuf::from(make_with_plain(&ask(&from, &home, "kept", &names)).unwrap().path);
    let (pid, then) = killed();
    hold_as(&gone, pid, then);
    run_line(&from, GitLine::new(&["worktree", "remove", "--force"]).operands(&[&gone.to_string_lossy()]));
    // The removal of another worktree here takes it, and the worktree a hold of its own came back into goes whole.
    hold_as(&kept, pid, then);
    let removed = remove(&from, &home, &kept, false).unwrap();
    assert_eq!(removed.path, kept.display().to_string());
    assert!(!gone.exists() && !kept.exists());
    assert!(beside_names(&kept).is_empty(), "{:?}", beside_names(&kept));
}

#[test]
fn nothing_but_a_worktree_wsp_made_of_this_folder_is_removed() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let hand = dir.path().join("by-hand");
    run_line(&from, GitLine::new(&["worktree", "add", "--quiet", "-b", "mine"]).operands(&[&hand.to_string_lossy()]));
    let stray = fs::canonicalize(&home).unwrap().join("worktrees/prj_1/stray");
    fs::create_dir_all(&stray).unwrap();
    for path in [&from, &hand, &stray] {
        let refused = remove(&from, &home, path, true).unwrap_err();
        assert_eq!(refused, not_made_here(path, &fs::canonicalize(&home).unwrap()));
    }
    assert!(from.join("README.md").is_file() && hand.join("README.md").is_file() && stray.is_dir());
}

#[test]
fn a_detached_worktree_saves_its_commit_to_a_ref_before_it_goes() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let at = PathBuf::from(make(&ask(&from, &home, "loose", &[])).unwrap().path);
    run(&at, &["checkout", "--quiet", "--detach"]);
    fs::write(at.join("README.md"), b"only here\n").unwrap();
    run(&at, &["commit", "--quiet", "-am", "only here"]);
    let sha = sha_of(&at, "HEAD").unwrap();
    let removed = remove(&from, &home, &at, false).unwrap();
    let name = format!("refs/rescue/prj_1/loose/{}", &sha[..12]);
    assert_eq!(removed.rescued.as_deref(), Some(name.as_str()));
    assert_eq!(sha_of(&from, &name).unwrap(), sha);
}

#[test]
fn a_worktree_removed_by_hand_is_dropped_by_git_and_its_branch_can_be_made_again() {
    let dir = scratch();
    let from = project(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let at = PathBuf::from(make(&ask(&from, &home, "again", &[])).unwrap().path);
    fs::remove_dir_all(&at).unwrap();
    let again = make(&ask(&from, &home, "again", &[])).unwrap();
    assert!(again.made && Path::new(&again.path).join("README.md").is_file(), "{again:?}");
    fs::remove_dir_all(&again.path).unwrap();
    remove(&from, &home, Path::new(&again.path), false).unwrap();
    assert_eq!(worktrees(&from).len(), 1);
}

#[test]
fn the_listing_reads_paths_branches_and_the_prunable_mark() {
    let out = "worktree /a\0HEAD 1\0branch refs/heads/main\0\0worktree /b c\0HEAD 2\0detached\0\0worktree /d\0HEAD 3\0branch refs/heads/feat/x\0prunable gitdir file points to non-existent location\0\0";
    assert_eq!(
        worktrees_of(out),
        [
            GitWorktree { path: "/a".into(), branch: Some("main".into()), head: Some("1".into()), prunable: false },
            GitWorktree { path: "/b c".into(), branch: None, head: Some("2".into()), prunable: false },
            GitWorktree { path: "/d".into(), branch: Some("feat/x".into()), head: Some("3".into()), prunable: true },
        ]
    );
    assert_eq!(safe("feat/x y@{1}"), "feat-x-y--1-");
}
