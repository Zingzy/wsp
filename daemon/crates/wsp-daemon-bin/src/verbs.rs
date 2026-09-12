// SPDX-License-Identifier: AGPL-3.0-only
//! Debug verbs beside the daemon: run in the foreground, print what happened, exit. `runtime pull` fills the
//! layer store the way a machine create will, so the fetch can be timed and sized on a box by itself.

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
