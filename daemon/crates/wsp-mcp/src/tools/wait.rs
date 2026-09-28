// SPDX-License-Identifier: AGPL-3.0-only
//! `threads_wait`, which blocks until one of the named threads leaves running and answers with its end, and
//! `restart`, which has the host come back on its own road and answers once it serves. Both dial the host again
//! when it stops under them, as packages/host/src/verbs.ts `waitThrough` and `restartHost` do.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use super::named::{history, threads, threads_of, Thread};
use super::said::{fmt_cost, fmt_duration, js_head, last_line, turns};
use super::{input, Answer, Refused, Tool};
use crate::client::Client;
use crate::failure::Failure;
use crate::host::Host;
use crate::record::{self, fill};

pub const WAIT: Tool = Tool {
    name: "threads_wait",
    listed: include_str!("../../record/tools/threads_wait.json"),
    call: |host, args| Box::pin(wait(host, args)),
};
pub const RESTART: Tool =
    Tool { name: "restart", listed: include_str!("../../record/tools/restart.json"), call: |host, args| Box::pin(restart(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct WaitIn {
    pub threads: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WaitOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished: Option<Finished>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
}

/// The thread that left running: its outcome and the figures the harness reported, the reply cut to its last line.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub thread_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub duration_ms: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub cost_usd: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
}

/// A turn's result as the runtime reports it, as far as an end is said from it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub duration_ms: Option<Number>,
    #[serde(default)]
    pub waited_ms: Option<Number>,
    #[serde(default)]
    pub cost_usd: Option<Number>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub refusal: Option<String>,
}

impl TurnResult {
    fn failed(error: Option<String>) -> TurnResult {
        TurnResult { status: "failed".to_owned(), error, ..TurnResult::default() }
    }

    /// The reply's last line, or the error where there is none; a turn that did not complete says its error first.
    fn tail(&self) -> Option<String> {
        let reply = last_line(self.text.as_deref().unwrap_or(""));
        if self.status == "completed" {
            reply.or_else(|| self.error.clone())
        } else {
            self.error.clone().or(reply)
        }
    }

    /// How long the turn worked: its wall time less the spans it stood on a prompt nobody answered.
    fn worked_ms(&self) -> Option<f64> {
        let duration = self.duration_ms.as_ref()?.as_f64()?;
        let waited = self.waited_ms.as_ref().and_then(Number::as_f64).filter(|w| *w > 0.0).unwrap_or(0.0).min(duration);
        Some(duration - waited)
    }

    /// The one line a thread's end sends, and the one a wait prints.
    fn notify_line(&self, thread_id: &str) -> String {
        let mut facts = vec![self.status.clone()];
        facts.extend(self.worked_ms().map(fmt_duration));
        facts.extend(self.cost_usd.as_ref().and_then(Number::as_f64).map(fmt_cost));
        let words = turns();
        let filled = [("thread", js_head(thread_id, 8)), ("facts", facts.join(", ")), ("body", self.tail().unwrap_or_default())];
        let filled: Vec<(&str, &str)> = filled.iter().map(|(k, v)| (*k, v.as_str())).collect();
        fill(if self.tail().is_some() { &words.finished } else { &words.finished_bare }, &filled)
    }
}

/// The thread's latest turn as its transcript ended it, as packages/protocol/src/thread-read.ts `threadResult` reads
/// it: newest first, the done of the turn the latest end closed, else failed with the end's reason.
pub fn thread_result(events: &[Value], thread_id: &str) -> Option<TurnResult> {
    let mut end: Option<&Value> = None;
    for event in events.iter().rev().filter(|e| e.get("threadId").and_then(Value::as_str) == Some(thread_id)) {
        match event.get("type").and_then(Value::as_str) {
            Some("session.end") => {
                if end.is_some() {
                    break;
                }
                end = Some(event);
            }
            Some("session.done") if end.is_none_or(|end| end.get("turnId") == event.get("turnId")) => {
                return Some(serde_json::from_value(event.get("result").cloned().unwrap_or_default()).unwrap_or_default());
            }
            Some("session.start") if end.is_some_and(|end| end.get("turnId") == event.get("turnId")) => break,
            _ => {}
        }
    }
    let reason = end?.get("reason").and_then(Value::as_str).map_or_else(|| turns().no_result.clone(), str::to_owned);
    Some(TurnResult::failed(Some(reason)))
}

enum Waited {
    Ended { thread_id: String, result: TurnResult },
    TimedOut { ms: f64 },
}

async fn ended_of(client: &Client, workspace_id: &str, thread_id: &str, ended: TurnResult) -> Result<Waited, Failure> {
    let result = thread_result(&history(client, workspace_id).await?, thread_id).unwrap_or(ended);
    Ok(Waited::Ended { thread_id: thread_id.to_owned(), result })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pushed {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    result: Option<TurnResult>,
    #[serde(default)]
    reason: Option<String>,
}

/// The first of the named threads to leave running: at once for one already over, else on the first done or end the
/// host pushes for any of them; the deadline when it passes first. The rows are read after the subscription, so an
/// end between the two is a held frame and not a gap. A named thread the listing no longer holds is over too.
async fn first_ended(client: &Client, named: &[Thread], timeout_ms: Option<f64>) -> Result<Waited, Failure> {
    let mut frames = client.frames();
    client.events().await?;
    let rows = threads(client, None).await?;
    if let Some(gone) = named.iter().find(|t| rows.iter().all(|r| r.runtime_id() != t.runtime_id())) {
        return ended_of(client, &gone.workspace_id, gone.runtime_id(), TurnResult::failed(None)).await;
    }
    let over = named.iter().filter_map(|t| rows.iter().find(|r| r.id == t.id)).find(|r| r.status != "running");
    if let Some(over) = over {
        let ended = TurnResult { status: over.status.clone(), ..TurnResult::default() };
        return ended_of(client, &over.workspace_id, over.runtime_id(), ended).await;
    }
    let ids: Vec<&str> = named.iter().map(Thread::runtime_id).collect();
    let deadline = async {
        match timeout_ms {
            Some(ms) => tokio::time::sleep(Duration::from_secs_f64(ms / 1_000.0)).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            frame = frames.next() => {
                let Some(text) = frame else { return Err(Failure::new(client.close_words())) };
                let Ok(pushed) = serde_json::from_str::<Pushed>(&text) else { continue };
                let Some(thread_id) = pushed.thread_id.filter(|id| ids.contains(&id.as_str())) else { continue };
                match pushed.kind.as_str() {
                    "session.done" => return Ok(Waited::Ended { thread_id, result: pushed.result.unwrap_or_default() }),
                    "session.end" => return ended_of(client, &pushed.workspace_id, &thread_id, TurnResult::failed(pushed.reason)).await,
                    _ => {}
                }
            }
            () = &mut deadline => return Ok(Waited::TimedOut { ms: timeout_ms.unwrap_or_default() }),
        }
    }
}

fn start_wait() -> Duration {
    Duration::from_millis(record::host().start_wait_ms)
}

async fn wait(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let WaitIn { threads: named, timeout } = input("threads_wait", arguments)?;
    let timeout_ms = timeout.map(|s| s * 1_000.0);
    let mut client = host.client().await?;
    let named = threads_of(&client, &named).await?;
    let until = timeout_ms.map(|ms| tokio::time::Instant::now() + Duration::from_secs_f64(ms / 1_000.0));
    let left = || until.map(|until| until.saturating_duration_since(tokio::time::Instant::now()));
    let waited = loop {
        match first_ended(&client, &named, left().map(|d| d.as_secs_f64() * 1_000.0)).await {
            Ok(Waited::TimedOut { .. }) => break Waited::TimedOut { ms: timeout_ms.unwrap_or_default() },
            Ok(waited) => break waited,
            Err(failure) if !client.stopped_under() => return Err(failure.into()),
            Err(_) => match host.back_within(left().map_or(start_wait(), |left| left.min(start_wait()))).await {
                Ok(back) => client = back,
                Err(_) if left() == Some(Duration::ZERO) => break Waited::TimedOut { ms: timeout_ms.unwrap_or_default() },
                Err(refused) => return Err(refused.into()),
            },
        }
    };
    let words = turns();
    Ok(match waited {
        Waited::Ended { thread_id, result } => {
            let line = result.notify_line(&thread_id);
            let finished = Finished {
                status: result.status.clone(),
                duration_ms: result.duration_ms.clone(),
                cost_usd: result.cost_usd.clone(),
                reply: result.tail(),
                thread_id,
            };
            Answer::text(line, &WaitOut { finished: Some(finished), timed_out: None })
        }
        Waited::TimedOut { ms } => {
            let after = fmt_duration(ms);
            let line = match named.as_slice() {
                [one] => fill(&words.timed_out_one, &[("thread", &js_head(one.runtime_id(), 8)), ("after", &after)]),
                several => fill(&words.timed_out_some, &[("count", &several.len().to_string()), ("after", &after)]),
            };
            Answer::text(line, &WaitOut { finished: None, timed_out: Some(true) })
        }
    })
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RestartIn {}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RestartOut {
    pub running: Vec<String>,
}

/// The host answers the ask before it closes, so the close after the answer is the restart under way; a road that
/// would not bring it back refuses the ask in its own words, before anything stops.
async fn restart(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RestartIn {} = input("restart", arguments)?;
    let client = host.client().await?;
    client.request::<Value>("host.restart", Map::new()).await?;
    if tokio::time::timeout(start_wait(), client.closed()).await.is_err() {
        return Err(Failure::new(turns().host_did_not_stop.clone()).into());
    }
    let back = host.back_within(start_wait()).await?;
    let running: Vec<String> =
        threads(&back, None).await?.iter().filter(|t| t.status == "running").map(|t| t.runtime_id().to_owned()).collect();
    let words = &turns().restarted;
    let heads: Vec<String> = running.iter().map(|id| js_head(id, 8)).collect();
    let line = match running.len() {
        0 => words.none.clone(),
        1 => fill(&words.one, &[("ids", &heads[0])]),
        n => fill(&words.some, &[("count", &n.to_string()), ("ids", &heads.join(", "))]),
    };
    Ok(Answer::text(line, &RestartOut { running }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::tools::held::to_the_record;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<WaitIn, WaitOut>(WAIT.listed);
        to_the_record::<RestartIn, RestartOut>(RESTART.listed);
    }

    #[test]
    fn a_thread_ends_as_its_latest_turn_did() {
        let event = |kind: &str, turn: &str, extra: Value| {
            let mut e = json!({ "type": kind, "threadId": "t", "turnId": turn });
            e.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            e
        };
        let done = |turn: &str, text: &str| event("session.done", turn, json!({ "result": { "status": "completed", "text": text } }));
        let ended = [
            event("session.start", "1", json!({})),
            done("1", "one"),
            event("session.end", "1", json!({})),
            event("session.start", "2", json!({})),
            done("2", "two"),
        ];
        assert_eq!(thread_result(&ended, "t").unwrap().text.as_deref(), Some("two"));
        let cut = [done("1", "one"), event("session.start", "2", json!({})), event("session.end", "2", json!({ "reason": "cut" }))];
        assert_eq!(thread_result(&cut, "t").unwrap().error.as_deref(), Some("cut"));
        assert!(thread_result(&cut, "u").is_none());
        let bare = [event("session.end", "2", json!({}))];
        assert_eq!(thread_result(&bare, "t").unwrap().error, Some(turns().no_result.clone()));
    }
}
