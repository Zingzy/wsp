// SPDX-License-Identifier: AGPL-3.0-only
//! The two tools that act on what changed in the folder a thread works in: commit makes a commit of it, its message
//! drafted by the thread's agent where none is given, and discard puts one changed file back as the last commit has
//! it. Each answer names the other threads that work in that folder, whose changes the act took in too.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use super::named::{sharing_with, thread_at, thread_label, with_shared, Aim};
use super::target::refusal_line;
use super::workspace::{self, awake, counted_number, params, read, Workspace};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct CommitIn {
    pub thread: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub files: Option<Vec<String>>,
}

/// packages/protocol's GitCommitReply, in its order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CommitOut {
    oid: String,
    subject: String,
    #[cfg_attr(test, schemars(with = "i64"))]
    files_changed: Number,
    #[cfg_attr(test, schemars(with = "i64"))]
    insertions: Number,
    #[cfg_attr(test, schemars(with = "i64"))]
    deletions: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_with: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DiscardIn {
    pub thread: String,
    pub path: String,
}

/// packages/protocol's GitDiscardReply, with the threads that share the folder.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DiscardOut {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_with: Option<Vec<String>>,
}

/// The threads an act took in, as an answer carries them: absent where none do.
pub fn shared_of(shared: Vec<String>) -> Option<Vec<String>> {
    (!shared.is_empty()).then_some(shared)
}

#[derive(Deserialize)]
struct Woken {
    id: String,
}

const COMMIT_NAME: &str = "commit";

pub const COMMIT: Tool = Tool {
    name: COMMIT_NAME,
    listed: include_str!(concat!(env!("OUT_DIR"), "/record/tools/commit.json")),
    call: |host, args| Box::pin(commit(host, args)),
};

const DISCARD_NAME: &str = "discard";

pub const DISCARD: Tool = Tool {
    name: DISCARD_NAME,
    listed: include_str!(concat!(env!("OUT_DIR"), "/record/tools/discard.json")),
    call: |host, args| Box::pin(discard(host, args)),
};

/// The files named go with the draft and the commit alike; without them every changed file does.
async fn commit(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Draft {
        message: Option<String>,
        #[serde(default)]
        note: Option<String>,
    }
    let CommitIn { thread, message, files } = input(COMMIT_NAME, arguments)?;
    let client = host.client().await?;
    let words = workspace::words();
    let aim = Aim { line: "wsp commit", or_computer: false, cloud: host.cloud() };
    let (thread, source): (_, Workspace) = thread_at(&client, &thread, &aim).await?;
    let woken: Woken = read(&awake(&client, &source, "commit").await?, "workspaces.wake")?;
    let named = |mut asked: serde_json::Map<String, Value>| {
        if let Some(files) = files.as_ref().filter(|files| !files.is_empty()) {
            asked.insert("paths".to_owned(), Value::from(files.clone()));
        }
        asked
    };
    let message = match message {
        Some(message) => message,
        None => {
            let mut asked = named(params([("workspaceId", Value::from(woken.id.as_str()))]));
            asked.insert("threadId".to_owned(), Value::from(thread.runtime_id()));
            let draft: Draft = client.request("workspaces.commitDraft", asked).await?;
            match draft.message {
                Some(message) => message,
                None => {
                    let said = draft.note.map_or_else(|| words.no_draft_bare.clone(), |note| fill(&words.no_draft, &[("note", &note)]));
                    return Err(Failure::usage(refusal_line(&said, &words.no_draft_fix)).into());
                }
            }
        }
    };
    let asked = named(params([
        ("workspaceId", Value::from(woken.id.as_str())),
        ("message", Value::from(message)),
        ("threadId", Value::from(thread.runtime_id())),
    ]));
    let mut made: CommitOut = client.request("workspaces.commit", asked).await?;
    let short: String = made.oid.chars().take(7).collect();
    let line = counted_number(&made.files_changed, &words.committed_one, &words.committed_many);
    let shared = sharing_with(&client, &thread, &source.id).await?;
    let said = with_shared(fill(&line, &[("name", &thread_label(&thread)), ("oid", &short), ("subject", &made.subject)]), &shared);
    made.shared_with = shared_of(shared);
    Ok(Answer::text(said, &made))
}

async fn discard(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let DiscardIn { thread, path } = input(DISCARD_NAME, arguments)?;
    let client = host.client().await?;
    let words = workspace::words();
    let aim = Aim { line: "wsp discard", or_computer: false, cloud: host.cloud() };
    let (thread, source): (_, Workspace) = thread_at(&client, &thread, &aim).await?;
    let woken: Woken = read(&awake(&client, &source, "discard").await?, "workspaces.wake")?;
    let mut put: DiscardOut = client
        .request(
            "workspaces.discard",
            params([("workspaceId", Value::from(woken.id)), ("path", Value::from(path)), ("threadId", Value::from(thread.runtime_id()))]),
        )
        .await?;
    let shared = sharing_with(&client, &thread, &source.id).await?;
    let said = with_shared(fill(&words.discarded, &[("name", &thread_label(&thread)), ("path", &put.path)]), &shared);
    put.shared_with = shared_of(shared);
    Ok(Answer::text(said, &put))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<CommitIn, CommitOut>(COMMIT.listed);
        to_the_record::<DiscardIn, DiscardOut>(DISCARD.listed);
    }
}
