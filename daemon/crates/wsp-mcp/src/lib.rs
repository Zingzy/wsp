// SPDX-License-Identifier: AGPL-3.0-only
//! The wsp tools for an agent on this computer: an MCP server on stdio that dials the host the way the command line
//! does and answers each tool with the value the command line prints under --json. What it lists and every sentence
//! it says are recorded off the TypeScript package under record/, so a description or a refusal has one home there.
//! The greeting and the list need nothing but this binary; a tool call dials, and brings a host up with the wsp
//! it was handed when none serves the state file.

mod aim;
mod checked;
mod client;
mod failure;
mod host;
mod js;
mod json;
mod record;
mod start;
mod stdio;
mod tools;
mod transcript;
mod words;
mod zod;

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncBufRead, AsyncWrite, BufReader};

use crate::failure::Failure;

/// The words `wsp-daemon mcp` was started with.
#[derive(Debug, Default, Clone)]
pub struct Args {
    /// The state file whose host a call dials; which file a bare wsp works on is the command line's to say.
    pub state: PathBuf,
    /// The host a line names outright, by alias or address.
    pub host: Option<String>,
    /// A thread's own tools: they refuse unless the launch left the thread's address and token in the environment.
    pub scoped: bool,
    /// A thread another thread started, which has no slate: its greeting says nothing of one.
    pub no_slate: bool,
    /// A refusal before the server runs is the failure object rather than its sentence.
    pub json: bool,
    /// A session from inside a machine, served on this computer: a path or a folder it names is on its machine, so
    /// it is refused rather than read here, and a tool whose work reads this computer is not listed.
    pub guest: bool,
    /// The wsp that brings a host up when none serves the state file, and that the recipe tools run; nothing starts
    /// one when it is empty.
    pub wsp: Vec<String>,
}

/// The environment the server runs in, read once and handed down, so a case says what a call is told.
pub type Env = HashMap<String, String>;

/// Serves this process's stdio until the agent closes stdin, and answers with the code to exit.
pub fn run(args: &Args) -> i32 {
    let env: Env = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    if let Some(refused) = refused_before(args, &env) {
        let object = refused.object();
        let said = if args.json { json::js_line(&object, false) } else { refused.message };
        let _ = writeln!(std::io::stderr(), "{said}");
        return object.exit;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "{e}");
            return 1;
        }
    };
    // A guest's folder is on its machine, and this process's is nothing of the guest's.
    let cwd = if args.guest { None } else { std::env::current_dir().ok() };
    let host = host::Host::new(args, &env, cwd);
    runtime.block_on(stdio::pump(Arc::new(host), BufReader::new(tokio::io::stdin()), tokio::io::stdout()))
}

/// A scoped server missing its pair refuses before anything else is read: it would otherwise dial this computer's
/// host on the host's own token, which is acting as the person.
fn refused_before(args: &Args, env: &Env) -> Option<Failure> {
    (args.scoped && aim::launched(env).is_none()).then(|| Failure::auth(record::words().scoped_no_pair))
}

pub async fn serve<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(args: &Args, env: &Env, input: R, output: W) -> i32 {
    let cwd = if args.guest { None } else { std::env::current_dir().ok() };
    stdio::pump(Arc::new(host::Host::new(args, env, cwd)), input, output).await
}
