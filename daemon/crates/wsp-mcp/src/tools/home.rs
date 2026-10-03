// SPDX-License-Identifier: AGPL-3.0-only
//! The tool that brings work off a workspace's machine: export brings a project folder and its agents' sessions home
//! to this computer.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

use super::workspace::{params, workspace_of};
use super::{input, Answer, Refused, Tool};
use crate::host::Host;

type Arc<T> = std::sync::Arc<T>;

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
        to_the_record::<ExportIn, ExportShape>(EXPORT.listed);
    }
}
