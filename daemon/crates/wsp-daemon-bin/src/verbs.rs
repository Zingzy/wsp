// SPDX-License-Identifier: AGPL-3.0-only
//! Verbs beside the daemon: run in the foreground, do one thing, exit. `runtime pull` fills the layer store the
//! way a machine create will, so the fetch can be timed on a box by itself. `runtime ask` answers one machine
//! frame from the runtime under a root, so a snapshot or a wake can be driven and timed on a box with nothing else
//! running. `runtime create` and `runtime exec` are the fresh processes the daemon runs youki's clone in;
//! `runtime init` is a workspace's first process.

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Instant;

use clap::Subcommand;
use wsp_runtime::fetch::{Client, Reference};
use wsp_runtime::store::Store;

#[derive(Debug, Subcommand)]
pub(crate) enum Verb {
    /// The workspace runtime's own verbs.
    Runtime {
        #[command(subcommand)]
        verb: RuntimeVerb,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum RuntimeVerb {
    /// Pull an image into the layer store under the runtime root, or say it is already there.
    Pull {
        /// The image as people write it: ubuntu:24.04, ghcr.io/org/app:tag.
        image: String,
        /// The runtime's root; the store lives under <root>/layers.
        #[arg(long, default_value = wsp_runtime::DEFAULT_ROOT, value_name = "dir")]
        root: PathBuf,
    },
    /// One machine frame answered by the runtime under the root, as the daemon answers it on its link: the frame's
    /// JSON without its id, the reply printed with the milliseconds the op took. Not for a root a daemon is serving,
    /// which is why the root has no default: it is named on purpose every time.
    Ask {
        /// The frame: {"op":"machine.snapshot","machineId":"wsp-x","name":"v1","life":{"firstLife":true}}
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

pub(crate) fn run(verb: Verb) -> i32 {
    match verb {
        Verb::Runtime { verb: RuntimeVerb::Pull { image, root } } => match pull(&image, &root) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("runtime pull {image}: {e}");
                1
            }
        },
        Verb::Runtime { verb: RuntimeVerb::Ask { frame, root } } => linux::ask(&root, &frame),
        Verb::Runtime { verb: RuntimeVerb::Create { root, id } } => linux::create(&root, &id),
        Verb::Runtime { verb: RuntimeVerb::Exec { root, id, timeout_ms, cmd } } => linux::exec(&root, &id, cmd, timeout_ms),
        Verb::Runtime { verb: RuntimeVerb::Init { cmd } } => linux::init(&cmd),
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
    /// live on that runtime and end with the process.
    fn answer(root: &Path, frame: &str) -> Result<(String, u128), Box<dyn std::error::Error>> {
        let mut frame: serde_json::Value = serde_json::from_str(frame)?;
        frame["id"] = serde_json::Value::from(1);
        let exe = std::env::current_exe()?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        runtime.block_on(async {
            let ops = wsp_runtime::ops::Ops::open(root, exe)?;
            ops.restore().await?;
            let started = std::time::Instant::now();
            let reply = ops.answer(Some(wsp_frames::RequestId::from(1)), &frame).await;
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

fn pull(image: &str, root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let source = Reference::parse(image)?;
    let store = Store::open(root)?;
    let pulled = store.pull(image, &source, &mut Client::new())?;
    let verb = if pulled.fetched { "pulled" } else { "in the store" };
    let mut lines = vec![
        format!("{verb} {image} in {} ms from {}", started.elapsed().as_millis(), pulled.image.source),
        format!("manifest {}", pulled.image.manifest),
        format!("config {}", pulled.image.chain.config),
    ];
    lines.extend(
        pulled.image.chain.layers.iter().zip(&pulled.image.layer_bytes).map(|(digest, bytes)| format!("layer {digest} {bytes} bytes")),
    );
    let mut out = io::stdout().lock();
    for line in lines {
        // A reader that went away (a pipe into head) ends the report, not the process.
        if writeln!(out, "{line}").is_err() {
            break;
        }
    }
    Ok(())
}
