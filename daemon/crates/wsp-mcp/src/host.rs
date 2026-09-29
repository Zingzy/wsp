// SPDX-License-Identifier: AGPL-3.0-only
//! The host the tools speak to: one socket kept across calls, dropped when it closes so the next call dials again,
//! and the aim read afresh at every dial, as packages/host/src/mcp.ts `dialer` keeps it. A host on the account that
//! holds no token of this computer's yet, or no longer takes the one it holds, admits it on its device key once, and
//! the token it answers is written into the record, as packages/host/src/verbs.ts `dialHost` does.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::aim::{self, Aim, HostRecord, Pick};
use crate::client::{self, Admit, Client, Dial, Presents};
use crate::failure::Failure;
use crate::record::{self, fill};
use crate::start;
use crate::{Args, Env};

/// Whether the cloud is on, read off the variable as the protocol's cloudFromEnv reads it: the greeting and the list
/// are the TypeScript server's for that state.
pub fn cloud_on(env: &Env) -> bool {
    env.get(&record::host().env.cloud).is_some_and(|value| value == "1")
}

pub struct Host {
    args: Args,
    /// The environment the server runs in, which the dial, the aim and the cloud flag read.
    process_env: Env,
    /// What a tool reads a value it sends by name from: the whole environment, and for a guest the pair its launch
    /// carries and the turn's token alone, as the TypeScript server's guest tools read them.
    env: Env,
    home: PathBuf,
    /// The folder the server runs in, where a thread named with no workspace finds its repo; none finds none.
    cwd: Option<PathBuf>,
    held: Mutex<Option<Arc<Client>>>,
}

impl Host {
    pub fn cloud(&self) -> bool {
        cloud_on(&self.process_env)
    }

    pub fn new(args: &Args, env: &Env, cwd: Option<PathBuf>) -> Host {
        let readable: Env = if args.guest {
            let names = [&record::host().env.url, &record::host().env.token, crate::tools::turn_token_env()];
            env.iter().filter(|(name, _)| names.contains(name)).map(|(k, v)| (k.clone(), v.clone())).collect()
        } else {
            env.clone()
        };
        Host { args: args.clone(), process_env: env.clone(), env: readable, home: aim::wsp_home(env), cwd, held: Mutex::new(None) }
    }

    /// The environment a tool reads a value it sends by name from.
    pub fn env(&self) -> &Env {
        &self.env
    }

    /// The socket the last call opened while it is still open; a fresh dial otherwise. Two calls at once share one
    /// dial, since the second waits on the first's.
    pub async fn client(&self) -> Result<Arc<Client>, Failure> {
        self.held(None).await
    }

    /// The host that came back after it stopped under a wait, within `window`: dialled until one answers, each dial
    /// handed what is left as its own deadline and none of them starting a host, as `hostAgain` in
    /// packages/host/src/verbs.ts dials. Past the window the last dial's refusal says what stands now.
    pub async fn back_within(&self, window: Duration) -> Result<Arc<Client>, Failure> {
        let until = Instant::now() + window;
        loop {
            let left = until.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            match self.held(Some(left)).await {
                Ok(client) => return Ok(client),
                Err(refused) if Instant::now() >= until => return Err(refused),
                Err(_) => {}
            }
            let poll = Duration::from_millis(record::host().poll_ms);
            tokio::time::sleep(poll.min(until.saturating_duration_since(Instant::now()))).await;
        }
    }

    pub fn args(&self) -> &Args {
        &self.args
    }

    pub fn cwd(&self) -> Option<&Path> {
        self.cwd.as_deref()
    }

    async fn held(&self, again: Option<Duration>) -> Result<Arc<Client>, Failure> {
        let mut held = self.held.lock().await;
        if let Some(open) = held.as_ref().filter(|c| !c.is_closed()) {
            return Ok(open.clone());
        }
        let dialled = Arc::new(self.dial(again).await?);
        *held = Some(dialled.clone());
        Ok(dialled)
    }

    /// `again` is a dial after the host stopped: it starts nothing and is bounded by what the wait has left.
    async fn dial(&self, again: Option<Duration>) -> Result<Client, Failure> {
        let pick = Pick { host: self.args.host.as_deref(), env: &self.process_env, home: self.home.clone() };
        let state = &self.args.state;
        let aim = aim::aimed(state, &pick)?;
        let window = again.unwrap_or_else(|| Duration::from_millis(aim::window_ms(&aim)));
        match &aim {
            Aim::Here => {
                if again.is_none() && aim::serving(state).is_none() && !self.args.wsp.is_empty() {
                    start::started(state, &self.args.wsp, &self.process_env, &mut |line| eprintln!("{line}")).await?;
                }
                let (url, token, at) = aim::here_door(state)?;
                let to = Dial { url: &url, at: &at, window, pinned: None, alias: None };
                Ok(client::dial(&to, Presents::Token(&token)).await.map_err(|r| r.failure)?.0)
            }
            Aim::Url { url, token, host_key } => {
                let Some(token) = token else {
                    return Err(Failure::usage(fill(&record::words().address_not_paired, &[("url", url)])));
                };
                let to = Dial { url: &ws_url(url)?, at: url, window, pinned: host_key.as_deref(), alias: None };
                Ok(client::dial(&to, Presents::Token(token)).await.map_err(|r| r.failure)?.0)
            }
            Aim::Alias { alias, record } => self.dial_account(alias, record, window).await,
        }
    }

    /// A host on the account. A record written off the listing holds no token until its first dial, which is
    /// admitted on the key this computer signs with; a token that host took away while the account still names this
    /// computer is one more dial, proving the key. Either way the token it answers is written into the record.
    async fn dial_account(&self, alias: &str, record: &HostRecord, window: Duration) -> Result<Client, Failure> {
        let admitting = || -> Option<Admit> {
            record.host_key.as_ref()?;
            let key = aim::device_key(&self.home)?;
            Some(Admit { name: hostname(), public_key: key.public_key, private_key_pem: key.private_key_pem })
        };
        let admit = if record.device_token.is_empty() { admitting() } else { None };
        let url = ws_url(&record.url)?;
        let to = Dial { url: &url, at: &record.url, window, pinned: record.host_key.as_deref(), alias: Some(alias) };
        let first = match &admit {
            Some(key) => Presents::Admit(key),
            None => Presents::Token(&record.device_token),
        };
        let (client, paired) = match client::dial(&to, first).await {
            Ok(dialled) => dialled,
            Err(refused) if admit.is_none() && refused.token && refused.failure.kind.as_deref() == Some("auth") => {
                let Some(key) = admitting() else { return Err(refused.failure) };
                client::dial(&to, Presents::Admit(&key)).await.map_err(|r| r.failure)?
            }
            Err(refused) => return Err(refused.failure),
        };
        if let Some(paired) = paired {
            let mut kept = record.clone();
            (kept.device_id, kept.device_token) = (paired.device_id, paired.device_token);
            aim::write_host(&self.home, alias, &kept).map_err(|e| Failure::new(e.to_string()))?;
        }
        Ok(client)
    }
}

/// What this computer calls itself, as node's os.hostname reads it: the name an admission gives the host's listing.
fn hostname() -> String {
    let mut name = [0u8; 256];
    // SAFETY: the buffer is ours and its length is the one handed in.
    let read = unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) };
    if read != 0 {
        return String::new();
    }
    let end = name.iter().position(|b| *b == 0).unwrap_or(name.len());
    String::from_utf8_lossy(&name[..end]).into_owned()
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

    #[test]
    fn a_guest_reads_no_value_by_name_but_its_launch_pair_and_turn() {
        let env: Env =
            [("WSP_HOST_URL", "u"), ("WSP_HOST_TOKEN", "t"), ("WSP_TURN", "turn"), ("TZ", "UTC"), ("WSP_CLOUD", "1"), ("KEY", "k")]
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .into_iter()
                .collect();
        let guest = Host::new(&Args { guest: true, ..Args::default() }, &env, None);
        let mut read: Vec<&str> = guest.env().keys().map(String::as_str).collect();
        read.sort_unstable();
        assert_eq!(read, ["WSP_HOST_TOKEN", "WSP_HOST_URL", "WSP_TURN"]);
        // The cloud's state is still the host's to say.
        assert!(guest.cloud());
        assert_eq!(Host::new(&Args::default(), &env, None).env().len(), env.len());
    }
}
