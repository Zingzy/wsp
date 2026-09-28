// SPDX-License-Identifier: AGPL-3.0-only
//! The two tools that bring work off a workspace's machine: bring back pushes its branch and opens the pull request,
//! and export brings a project folder and its agents' sessions home to this computer.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Number, Value};

use super::workspace::{self, awake, counted_number, params, read, workspace_of};
use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct BringBackIn {
    pub workspace: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

/// packages/protocol's BringBackResult, in its order: the push, then the pull request or why there is none.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct BringBackOut {
    branch: String,
    base: String,
    #[cfg_attr(test, schemars(with = "i64"))]
    ahead: Number,
    #[cfg_attr(test, schemars(with = "i64"))]
    uncommitted: Number,
    stat: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<serde_json::Value>"))]
    pr: Option<PullRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refused: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PullRequest {
    number: Number,
    url: String,
    state: String,
    host: String,
}

const BRING_BACK_NAME: &str = "bring_back";

pub const BRING_BACK: Tool = Tool {
    name: BRING_BACK_NAME,
    listed: include_str!("../../record/tools/bring_back.json"),
    call: |host, args| Box::pin(bring_back(host, args)),
};

/// The push's lines come first whatever the pull request half said, since that half runs after the branch landed.
fn brought_back_line(name: &str, back: &BringBackOut) -> String {
    let words = workspace::words();
    let pushed = counted_number(&back.ahead, &words.pushed_one, &words.pushed_many);
    let mut lines = vec![fill(&pushed, &[("name", name), ("branch", &back.branch), ("base", &back.base)])];
    lines.extend(back.stat.iter().cloned());
    match &back.pr {
        Some(pr) => lines.push(fill(&words.pr_line, &[("url", &pr.url), ("state", &pr.state)])),
        None => lines.extend(back.note.clone().or_else(|| back.refused.clone())),
    }
    if back.uncommitted.as_f64() != Some(0.0) {
        lines.push(counted_number(&back.uncommitted, &words.left_one, &words.left_many));
    }
    lines.join("\n")
}

/// The push is reported either way; a pull request half that refused marks the call an error under it.
async fn bring_back(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Woken {
        id: String,
        name: String,
    }
    let BringBackIn { workspace, title, body } = input(BRING_BACK_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let woken: Woken = read(&awake(&client, &source, "bring back").await?, "workspaces.wake")?;
    let mut asked = params([("workspaceId", Value::from(woken.id))]);
    for (key, value) in [("title", title), ("body", body)] {
        if let Some(value) = value {
            asked.insert(key.to_owned(), Value::from(value));
        }
    }
    let back: BringBackOut = client.request("workspaces.bringBack", asked).await?;
    let said = brought_back_line(&woken.name, &back);
    Ok(if back.refused.is_none() { Answer::text(said, &back) } else { Answer::text_error(said, &back) })
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ExportIn {
    pub workspace: String,
    pub folder: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub replace: Option<bool>,
    #[serde(default)]
    pub agents: Option<Vec<String>>,
}

/// packages/protocol's ProjectExportResult, passed through as the host wrote it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExportOut(Box<RawValue>);

/// The fields that result carries, which the check below holds to the recorded schema.
#[cfg(test)]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct ExportShape {
    dest: String,
    files: f64,
    bytes: f64,
    excluded: Vec<String>,
    agents: Vec<serde_json::Value>,
}

const EXPORT_NAME: &str = "export";

pub const EXPORT: Tool =
    Tool { name: EXPORT_NAME, listed: include_str!("../../record/tools/export.json"), call: |host, args| Box::pin(export(host, args)) };

/// The text is the runtime's own line for the export's end, which it pushes as the last frame of that export: frames
/// for another export to another folder are another call's.
async fn export(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Stage {
        #[serde(rename = "type")]
        kind: Option<String>,
        workspace_id: Option<String>,
        dest: Option<String>,
        stage: Option<String>,
        message: Option<String>,
    }
    #[derive(Deserialize)]
    struct Exported {
        exported: ExportOut,
    }
    let ExportIn { workspace, folder, from, replace, agents } = input(EXPORT_NAME, arguments)?;
    let client = host.client().await?;
    let target = workspace_of(&client, &workspace).await?;
    let mut frames = client.frames();
    client.events().await?;
    let mut asked = params([
        ("workspaceId", Value::from(target.id.as_str())),
        ("source", Value::from(from.unwrap_or_else(|| folder.clone()))),
        ("dest", Value::from(folder.as_str())),
    ]);
    if let Some(replace) = replace {
        asked.insert("replace".to_owned(), Value::Bool(replace));
    }
    if let Some(agents) = agents {
        asked.insert("agents".to_owned(), Value::from(agents));
    }
    let Exported { exported } = client.request("project.export", asked).await?;
    let mut done = String::new();
    while let Some(frame) = frames.try_next() {
        let Ok(stage) = serde_json::from_str::<Stage>(&frame) else { continue };
        let ours = stage.kind.as_deref() == Some("project.export")
            && stage.workspace_id.as_deref() == Some(target.id.as_str())
            && stage.dest.as_deref() == Some(folder.as_str());
        if ours && stage.stage.as_deref() == Some("done") {
            done = stage.message.unwrap_or_default();
        }
    }
    Ok(Answer::text(done, &exported))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<BringBackIn, BringBackOut>(BRING_BACK.listed);
        to_the_record::<ExportIn, ExportShape>(EXPORT.listed);
    }
}
