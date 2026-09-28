// SPDX-License-Identifier: AGPL-3.0-only
//! `folders`: one level of a computer's folders, or every repo under its home, as the host lists them. The listing is
//! answered in the host's own bytes; its text is the table and the line the command line prints under it.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::agents::place_named;
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::{self, fill};
use crate::words::{plural, table};

const NAME: &str = "folders";

pub const TOOL: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/folders.json"), call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repos: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
}

/// What the text reads off the listing, which is answered whole as the host sent it.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Listing {
    pub dir: String,
    pub roots: Vec<String>,
    pub folders: Vec<Folder>,
    pub hidden: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<f64>"))]
    pub touched_at: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Listed {
    listing: Box<RawValue>,
}

/// `absolutePath`: a folder the host would read against a working folder the caller cannot see is refused.
fn absolute(folder: &str, refused: &str) -> Result<String, Failure> {
    if folder.starts_with('/') {
        return Ok(folder.to_owned());
    }
    let quoted = serde_json::to_string(folder).unwrap_or_default();
    Err(Failure::usage(fill(refused, &[("path", &quoted[1..quoted.len() - 1])])))
}

async fn call(host: std::sync::Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let asked: In = input(NAME, arguments)?;
    let client = host.client().await?;
    let words = record::words();
    let elsewhere = match &asked.on {
        Some(on) => Some(place_named(&client, on).await?).filter(|(id, _)| id != "here"),
        None => None,
    };
    let mut params = Map::new();
    if let Some(folder) = &asked.folder {
        let dir = match &elsewhere {
            None => absolute(folder, &words.folder_here)?,
            Some((_, name)) => absolute(folder, &fill(&words.folder_on, &[("name", name)]))?,
        };
        params.insert("dir".to_owned(), Value::from(dir));
    }
    if asked.hidden == Some(true) {
        params.insert("hidden".to_owned(), Value::from(true));
    }
    if asked.repos == Some(true) {
        params.insert("repos".to_owned(), Value::from(true));
    }
    if let Some((id, _)) = &elsewhere {
        params.insert("on".to_owned(), Value::from(id.as_str()));
    }
    let Listed { listing } = client.request::<Listed>("host.folders", params).await?;
    let read: Listing = serde_json::from_str(listing.get()).map_err(|e| Failure::new(format!("host.folders: {e}")))?;
    Ok(Answer::text(lines(&read).join("\n"), &listing))
}

/// `folderLines`, with `folderLevelLine` under the table.
fn lines(listing: &Listing) -> Vec<String> {
    let mut rows = vec![vec!["FOLDER".to_owned(), "GIT".to_owned()]];
    rows.extend(
        listing
            .folders
            .iter()
            .map(|f| vec![f.path.clone(), if f.repo { f.branch.clone().unwrap_or_else(|| "git".to_owned()) } else { String::new() }]),
    );
    let held = if listing.hidden == 0 { String::new() } else { format!(", {} hidden", listing.hidden) };
    let level = if listing.folders.is_empty() {
        format!("No folders in {}{held}.", listing.dir)
    } else {
        format!("{} in {}{held}.", plural(listing.folders.len(), "folder"), listing.dir)
    };
    let mut out = table(&rows);
    out.push(format!("{level} Browsable: {}.", listing.roots.join(", ")));
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<super::In, super::Listing>(super::TOOL.listed);
    }
}
