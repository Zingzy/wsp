// SPDX-License-Identifier: AGPL-3.0-only
//! `exec`: a command on the workspace's machine, each word as given, followed to its exit through the frames the host
//! pushes for it; the output lines, the exit code and the folder it ran in are the answer.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

use super::named::{absolute_folder, awake, params, workspace_of};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;

const NAME: &str = "exec";

pub const TOOL: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/exec.json"), call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {
    pub workspace: String,
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// The exit code passes through in the bytes the host wrote it, a number or null.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Out {
    #[cfg_attr(test, schemars(with = "Value"))]
    pub exit_code: Box<RawValue>,
    pub output: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    exec_id: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pushed {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    exec_id: Option<String>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    exit_code: Option<Box<RawValue>>,
    #[serde(default)]
    error: Option<String>,
}

async fn call(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let In { workspace, argv, cwd } = input(NAME, arguments)?;
    let asked = absolute_folder(cwd.as_deref())?.map(str::to_owned);
    let client = host.client().await?;
    let target = awake(&client, &workspace_of(&client, &workspace).await?, NAME).await?.workspace;
    let mut frames = client.frames();
    let mut run = params([("workspaceId", Value::from(target.id.as_str())), ("argv", Value::from(argv))]);
    if let Some(folder) = asked {
        run.insert("cwd".to_owned(), Value::from(folder));
    }
    let Started { exec_id, cwd: ran_in } = client.request("workspaces.exec", run).await?;
    let mut output = Vec::new();
    loop {
        let Some(text) = frames.next().await else { return Err(Failure::new(client.close_words()).into()) };
        let Ok(pushed) = serde_json::from_str::<Pushed>(&text) else { continue };
        if pushed.exec_id.as_deref() != Some(exec_id.as_str()) {
            continue;
        }
        match pushed.kind.as_str() {
            "exec.output" => output.push(pushed.text),
            "exec.exit" => {
                if let Some(error) = pushed.error {
                    return Err(Failure::new(error).into());
                }
                let exit_code = pushed.exit_code.unwrap_or_else(|| RawValue::from_string("null".to_owned()).unwrap());
                return Ok(Answer::text(output.join("\n"), &Out { exit_code, output, cwd: ran_in }));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Out>(super::TOOL.listed);
    }
}
