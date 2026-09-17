// SPDX-License-Identifier: AGPL-3.0-only
//! Verbs beside the daemon: run in the foreground, do one thing, exit. `runtime ask` answers one machine frame
//! from the runtime under a root, so a create or a wake can be driven and timed on a box with nothing else
//! running. `runtime create` and `runtime exec` are the fresh processes the daemon runs youki's clone in;
//! `runtime init` is a workspace's first process. `copy` makes and removes the copy a workspace on the computer
//! somebody sits at is: the host runs it as a child and reads one JSON line back, so the road picking and the two
//! rules live in the daemon's own code without the door answering a new op.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use clap::Subcommand;
use wsp_frames::{numbers, CopyAsk, CopyRoadName};

#[derive(Debug, Subcommand)]
pub(crate) enum Verb {
    /// The workspace runtime's own verbs.
    Runtime {
        #[command(subcommand)]
        verb: RuntimeVerb,
    },
    /// The copy a workspace on the computer somebody sits at is made of: one JSON line on stdout when it stands,
    /// one sentence on stderr and exit 1 when it does not.
    Copy {
        #[command(subcommand)]
        verb: CopyVerb,
    },
    /// The wsp a process inside this machine runs: the whole line goes to the host over this machine's own daemon.
    /// Nothing here reads a verb or a flag, so the words the host's command line takes are the words that work.
    #[command(disable_help_flag = true)]
    Wsp {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        line: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum RuntimeVerb {
    /// One machine frame answered by the runtime under the root, as the daemon answers it on its link: the frame's
    /// JSON without its id, the reply printed with the milliseconds the op took. Not for a root a daemon is serving,
    /// which is why the root has no default: it is named on purpose every time.
    Ask {
        /// The frame: {"op":"machine.create","spec":{"kind":"sandbox","cpu":1,"memMb":512}}
        frame: String,
        /// The runtime root the frame is answered under; never the one a running daemon serves.
        #[arg(long, value_name = "dir")]
        root: PathBuf,
    },
    /// youki's create for the bundle the daemon wrote under <root>/run/<id>; the daemon runs this as a fresh process.
    Create {
        #[arg(long, value_name = "dir")]
        root: PathBuf,
        #[arg(long)]
        id: String,
    },
    /// A command inside a workspace as a tenant, this process's stdio as the command's; exits with its code, 124
    /// past the deadline.
    Exec {
        #[arg(long, value_name = "dir")]
        root: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long, value_name = "n")]
        timeout_ms: u64,
        #[arg(last = true, required = true)]
        cmd: Vec<String>,
    },
    /// A workspace's first process: runs the boot command and reaps what it leaves behind.
    Init {
        #[arg(last = true, required = true)]
        cmd: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum CopyVerb {
    /// Copies the folder to a path of its own by the best road this computer has, then makes it a clean checkout.
    Make {
        /// The project folder, which is the top of a git work tree.
        #[arg(long, value_name = "dir")]
        from: PathBuf,
        /// Where the copy lands; it must not be there yet.
        #[arg(long, value_name = "dir")]
        to: PathBuf,
        /// The ref the copy is reset to; the folder's default branch when absent.
        #[arg(long, value_name = "ref")]
        base: Option<String>,
        /// A directory removed from the copy so it rebuilds at the new path, once per directory.
        #[arg(long, value_name = "dir")]
        exclude: Vec<String>,
        /// Apparent size above which the directory clone is not taken.
        #[arg(long, default_value_t = u64::MAX, value_name = "n")]
        size_line_bytes: u64,
        /// A road named outright; the picker's own choice when absent.
        #[arg(long, value_name = "clonefile|worktree", value_parser = road_of)]
        road: Option<CopyRoadName>,
    },
    /// Takes a copy away by the road that made it.
    Remove {
        #[arg(long, value_name = "dir")]
        from: PathBuf,
        #[arg(long, value_name = "dir")]
        to: PathBuf,
        #[arg(long, value_name = "clonefile|worktree", value_parser = road_of)]
        road: CopyRoadName,
    },
}

/// The road a person or a host names on the line, in the words the wire carries.
fn road_of(word: &str) -> Result<CopyRoadName, String> {
    match word {
        "clonefile" => Ok(CopyRoadName::Clonefile),
        "worktree" => Ok(CopyRoadName::Worktree),
        "in-place" => Ok(CopyRoadName::InPlace),
        other => Err(format!("{other} is not a road: clonefile, worktree or in-place")),
    }
}

/// The copy, with its report as the one line on stdout. Nothing else is printed there, so a caller reads the line
/// and parses it; the reason a copy was refused goes to stderr as one sentence.
fn copy(verb: CopyVerb) -> i32 {
    let done = match verb {
        CopyVerb::Make { from, to, base, exclude, size_line_bytes, road } => {
            let ask = CopyAsk {
                from: from.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
                base,
                exclude,
                size_line_bytes,
                road,
            };
            wsp_runtime::copy_road::make(&ask).and_then(|report| serde_json::to_string(&report).map_err(|e| e.to_string()))
        }
        CopyVerb::Remove { from, to, road } => wsp_runtime::copy_road::remove(&from, &to, road).map(|()| String::new()),
    };
    match done {
        Ok(line) => {
            if !line.is_empty() {
                println!("{line}");
            }
            0
        }
        Err(why) => {
            eprintln!("{why}");
            1
        }
    }
}

pub(crate) fn run(verb: Verb) -> i32 {
    match verb {
        Verb::Runtime { verb: RuntimeVerb::Ask { frame, root } } => linux::ask(&root, &frame),
        Verb::Runtime { verb: RuntimeVerb::Create { root, id } } => linux::create(&root, &id),
        Verb::Runtime { verb: RuntimeVerb::Exec { root, id, timeout_ms, cmd } } => linux::exec(&root, &id, cmd, timeout_ms),
        Verb::Runtime { verb: RuntimeVerb::Init { cmd } } => linux::init(&cmd),
        Verb::Copy { verb } => copy(verb),
        Verb::Wsp { line } => {
            let daemon = SocketAddr::from((Ipv4Addr::LOCALHOST, numbers::DEFAULT_PORT));
            wsp_guest::run(&line, &|name| std::env::var(name).ok(), daemon, Path::new(numbers::DEFAULT_TOKEN_PATH))
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::path::Path;
    use std::time::Duration;

    use wsp_runtime::runtime::{helper_create, helper_exec, helper_failure_line, HELPER_FAILED};

    pub(super) fn ask(root: &Path, frame: &str) -> i32 {
        match answer(root, frame) {
            Ok((reply, ms)) => {
                println!("{reply}");
                println!("{ms} ms");
                0
            }
            Err(e) => {
                eprintln!("runtime ask: {e}");
                1
            }
        }
    }

    /// The frame under a fresh id, answered by the ops on a runtime of this process's own; the network's forwards
    /// live on that runtime and end with the process. A snapshot is a job the ops name at once, so the verb asks
    /// after it every second, each reading on stderr, and prints the reading that ends it.
    fn answer(root: &Path, frame: &str) -> Result<(String, u128), Box<dyn std::error::Error>> {
        let mut frame: serde_json::Value = serde_json::from_str(frame)?;
        frame["id"] = serde_json::Value::from(1);
        let exe = std::env::current_exe()?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        runtime.block_on(async {
            let ops = wsp_runtime::ops::Ops::open(root, exe)?;
            ops.restore().await?;
            let started = std::time::Instant::now();
            let mut reply = ops.answer(Some(wsp_frames::RequestId::from(1)), &frame).await;
            let job = serde_json::from_str::<serde_json::Value>(&reply).ok().and_then(|v| v["job"].as_str().map(str::to_owned));
            if let Some(job) = job {
                loop {
                    let ask = serde_json::json!({ "id": 1, "op": "machine.snapshotJob", "job": job });
                    reply = ops.answer(Some(wsp_frames::RequestId::from(1)), &ask).await;
                    let read: serde_json::Value = serde_json::from_str(&reply)?;
                    if read["state"] != "running" {
                        break;
                    }
                    eprintln!("{} ms {reply}", started.elapsed().as_millis());
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
            Ok((reply, started.elapsed().as_millis()))
        })
    }

    pub(super) fn create(root: &Path, id: &str) -> i32 {
        crate::score::for_workspace();
        match helper_create(root, id) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{}", helper_failure_line(&e));
                HELPER_FAILED
            }
        }
    }

    pub(super) fn exec(root: &Path, id: &str, cmd: Vec<String>, timeout_ms: u64) -> i32 {
        crate::score::for_workspace();
        match helper_exec(root, id, cmd, Duration::from_millis(timeout_ms)) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("{}", helper_failure_line(&e));
                HELPER_FAILED
            }
        }
    }

    pub(super) fn init(cmd: &[String]) -> i32 {
        wsp_runtime::init::run(cmd)
    }
}

#[cfg(not(target_os = "linux"))]
mod linux {
    use std::path::Path;

    const NOT_HERE: &str = "workspaces run on Linux alone";

    pub(super) fn ask(_root: &Path, _frame: &str) -> i32 {
        eprintln!("runtime ask: {NOT_HERE}");
        1
    }

    pub(super) fn create(_root: &Path, _id: &str) -> i32 {
        eprintln!("runtime create: {NOT_HERE}");
        1
    }

    pub(super) fn exec(_root: &Path, _id: &str, _cmd: Vec<String>, _timeout_ms: u64) -> i32 {
        eprintln!("runtime exec: {NOT_HERE}");
        1
    }

    pub(super) fn init(_cmd: &[String]) -> i32 {
        eprintln!("runtime init: {NOT_HERE}");
        1
    }
}
