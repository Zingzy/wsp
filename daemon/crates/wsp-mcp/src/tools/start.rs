// SPDX-License-Identifier: AGPL-3.0-only
//! The three tools that start from a link and review: start makes a workspace off an issue or a pull request with a
//! thread on its task, review starts a read-only reviewer on a pull request, and review_post posts the review it left
//! as the person. Who may ask for each is the host's to say off the token.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value};

use super::said::turns;
use super::workspace::{self, counted_number, params, read, workspace_of};
use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct StartIn {
    pub link: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub access: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ReviewIn {
    pub target: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// packages/protocol's StartResult, the workspace in the host's own bytes as a create's is.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct StartOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    workspace: Box<RawValue>,
    thread_id: String,
    session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ReviewPostIn {
    pub workspace: String,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

/// packages/protocol's ReviewPostResult, in its order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ReviewPostOut {
    url: String,
    #[cfg_attr(test, schemars(with = "i64"))]
    number: Number,
    #[cfg_attr(test, schemars(with = "i64"))]
    comments: Number,
    #[cfg_attr(test, schemars(with = "i64"))]
    folded: Number,
}

/// What the lines read off the workspace a start made.
#[derive(Deserialize)]
struct Made {
    name: String,
    #[serde(default)]
    from: Option<From>,
}

#[derive(Deserialize)]
struct From {
    kind: String,
    number: Number,
}

const START_NAME: &str = "start";
const REVIEW_NAME: &str = "review";
const REVIEW_POST_NAME: &str = "review_post";

pub const START: Tool =
    Tool { name: START_NAME, listed: include_str!("../../record/tools/start.json"), call: |host, args| Box::pin(start(host, args)) };
pub const REVIEW: Tool =
    Tool { name: REVIEW_NAME, listed: include_str!("../../record/tools/review.json"), call: |host, args| Box::pin(review(host, args)) };
pub const REVIEW_POST: Tool = Tool {
    name: REVIEW_POST_NAME,
    listed: include_str!("../../record/tools/review_post.json"),
    call: |host, args| Box::pin(review_post(host, args)),
};

/// The fields named, in the order given, each left out where absent.
fn named<const N: usize>(fields: [(&str, Option<Value>); N]) -> Map<String, Value> {
    fields.into_iter().filter_map(|(key, value)| value.map(|v| (key.to_owned(), v))).collect()
}

/// What was made from what, then the thread as a detached run prints it.
fn started_lines(done: &StartOut) -> Result<String, Refused> {
    let made: Made = read(&done.workspace, "workspaces.start")?;
    let words = workspace::words();
    let line = match &made.from {
        None => fill(&words.made_bare, &[("name", &made.name)]),
        Some(from) => {
            let template = if from.kind == "issue" { &words.made_issue } else { &words.made_pull_request };
            fill(template, &[("name", &made.name), ("number", &from.number.to_string())])
        }
    };
    Ok(format!("{line}\n{}", fill(&turns().opened_thread, &[("thread", &done.thread_id)])))
}

async fn start(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let StartIn { link, project, agent, model, effort, access } = input(START_NAME, arguments)?;
    let client = host.client().await?;
    // wsp's access word, refused before anything is asked where it is none of the four: `startedFrom`.
    let picks = super::turn::Picks { access, ..super::turn::Picks::default() };
    let access = picks.access_word()?.map(str::to_owned);
    let asked = named([
        ("url", Some(Value::from(link))),
        ("project", project.map(Value::from)),
        ("agent", agent.map(Value::from)),
        ("model", model.map(Value::from)),
        ("effort", effort.map(Value::from)),
        ("access", access.map(Value::from)),
    ]);
    let done: StartOut = client.request("workspaces.start", asked).await?;
    Ok(Answer::text(started_lines(&done)?, &done))
}

/// A link is reviewed off its pull request; any other target is a workspace, whose own pull request is.
async fn review(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ReviewIn { target, agent, model, effort } = input(REVIEW_NAME, arguments)?;
    let client = host.client().await?;
    let on = if target.starts_with("http://") || target.starts_with("https://") {
        ("url", Value::from(target))
    } else {
        ("workspaceId", Value::from(workspace_of(&client, &target).await?.id))
    };
    let asked = named([
        (on.0, Some(on.1)),
        ("agent", agent.map(Value::from)),
        ("model", model.map(Value::from)),
        ("effort", effort.map(Value::from)),
    ]);
    let done: StartOut = client.request("workspaces.review", asked).await?;
    Ok(Answer::text(started_lines(&done)?, &done))
}

/// A verdict or a summary named edits the draft first, so the post carries them.
async fn review_post(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ReviewPostIn { workspace, verdict, summary } = input(REVIEW_POST_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    if verdict.is_some() || summary.is_some() {
        let edits = named([
            ("workspaceId", Some(Value::from(source.id.as_str()))),
            ("verdict", verdict.map(Value::from)),
            ("summary", summary.map(Value::from)),
        ]);
        let _: Value = client.request("workspaces.reviewDraft", edits).await?;
    }
    let done: ReviewPostOut = client.request("workspaces.reviewPost", params([("workspaceId", Value::from(source.id.as_str()))])).await?;
    let words = workspace::words();
    let template = counted_number(&done.comments, &words.posted_one, &words.posted_many);
    let said = fill(&template, &[("name", &source.name), ("number", &done.number.to_string()), ("folded", &done.folded.to_string())]);
    Ok(Answer::text(said, &done))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<StartIn, StartOut>(START.listed);
        to_the_record::<ReviewIn, StartOut>(REVIEW.listed);
        to_the_record::<ReviewPostIn, ReviewPostOut>(REVIEW_POST.listed);
    }
}
