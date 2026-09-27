// SPDX-License-Identifier: AGPL-3.0-only
//! The host the tools speak to: one socket kept across calls, dropped when it closes so the next call dials again,
//! and the aim read afresh at every dial, as packages/host/src/mcp.ts `dialer` keeps it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::aim::{self, Aim, Pick};
use crate::client::{self, Client};
use crate::failure::Failure;
use crate::record::{self, fill};
use crate::start;
use crate::{Args, Env};

/// What a call aimed at a host that pins a key gets from this server, which opens no seal: the command line's own
/// server opens one, so the line that reaches that host is the same words typed to the wsp command.
const SEALED_ROAD: &str =
    "the host at {where} pins the key it proves, and this tool server opens no sealed road; run wsp mcp from the wsp command to reach it";

/// Whether the cloud is on, read off the variable as the protocol's cloudFromEnv reads it: the greeting and the list
/// are the TypeScript server's for that state.
pub fn cloud_on(env: &Env) -> bool {
    env.get(&record::host().env.cloud).is_some_and(|value| value == "1")
}

pub struct Host {
    args: Args,
    env: Env,
    home: PathBuf,
    held: Mutex<Option<Arc<Client>>>,
}

impl Host {
    pub fn cloud(&self) -> bool {
        cloud_on(&self.env)
    }

    pub fn new(args: &Args, env: &Env) -> Host {
        Host { args: args.clone(), env: env.clone(), home: aim::wsp_home(env), held: Mutex::new(None) }
    }

    /// The socket the last call opened while it is still open; a fresh dial otherwise. Two calls at once share one
    /// dial, since the second waits on the first's.
    pub async fn client(&self) -> Result<Arc<Client>, Failure> {
        let mut held = self.held.lock().await;
        if let Some(open) = held.as_ref().filter(|c| !c.is_closed()) {
            return Ok(open.clone());
        }
        let dialled = Arc::new(self.dial().await?);
        *held = Some(dialled.clone());
        Ok(dialled)
    }

    async fn dial(&self) -> Result<Client, Failure> {
        let pick = Pick { host: self.args.host.as_deref(), env: &self.env, home: self.home.clone() };
        let state = &self.args.state;
        let aim = aim::aimed(state, &pick)?;
        let window = Duration::from_millis(aim::window_ms(&aim));
        match &aim {
            Aim::Here => {
                if aim::serving(state).is_none() && !self.args.wsp.is_empty() {
                    start::started(state, &self.args.wsp, &self.env, &mut |line| eprintln!("{line}")).await?;
                }
                let (url, token, at) = aim::here_door(state)?;
                client::dial(&url, &token, &at, window, None).await
            }
            Aim::Url { url, token, host_key } => {
                let Some(token) = token else {
                    return Err(Failure::usage(fill(&record::words().address_not_paired, &[("url", url)])));
                };
                if host_key.is_some() {
                    return Err(Failure::new(fill(SEALED_ROAD, &[("where", url)])));
                }
                client::dial(&ws_url(url)?, token, url, window, None).await
            }
            Aim::Alias { alias, record } => {
                if record.host_key.is_some() || record.device_token.is_empty() {
                    return Err(Failure::new(fill(SEALED_ROAD, &[("where", &record.url)])));
                }
                client::dial(&ws_url(&record.url)?, &record.device_token, &record.url, window, Some(alias)).await
            }
        }
    }
}

fn ws_url(url: &str) -> Result<String, Failure> {
    aim::ws_url_of(url).ok_or_else(|| Failure::new(fill(&record::words().no_answer, &[("where", url), ("why", "not an address")])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_cloud_flag_as_the_protocol_does() {
        for (word, want) in record::host().clouds {
            let env: Env = [("WSP_CLOUD".to_owned(), word.clone())].into_iter().collect();
            assert_eq!(cloud_on(&env), want, "WSP_CLOUD={word:?}");
        }
        assert!(!cloud_on(&Env::new()));
    }
}
