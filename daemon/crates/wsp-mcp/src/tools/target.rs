// SPDX-License-Identifier: AGPL-3.0-only
//! What the tools that act on one computer or workspace share with packages/host/src/verbs.ts: the target a
//! workspace or a computer names (`agentsTarget`), a project asked by flag or by name (`projectAsked`), and a line
//! as a terminal prints it (`cell`, `printable`, `table`). Every sentence is the recorded one.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::client::Client;
use crate::failure::Failure;
use crate::record::{fill, Words};

/// A tool's `project`: true for the workspace's own, or a project's name.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum ProjectIn {
    Own(bool),
    Named(String),
}

/// A project as the act reads it: not a project's, the workspace's own, or a project on a computer by its name.
#[derive(Debug, Default)]
pub struct Asked {
    pub project: bool,
    pub name: Option<String>,
}

/// What a tool answers after a refusal of what it was given.
pub fn usage(words: &Words, tool: &str) -> String {
    fill(&words.aimed_usage, &[("tool", tool)])
}

/// A recorded refusal with its fix filled by the tool's usage.
pub fn refused(template: &str, fills: &[(&str, &str)], usage: &str) -> Failure {
    let mut all = fills.to_vec();
    all.push(("usage", usage));
    Failure::usage(fill(template, &all))
}

pub fn project_asked(words: &Words, value: Option<&ProjectIn>, on: Option<&str>, usage: &str) -> Result<Asked, Failure> {
    match value {
        None | Some(ProjectIn::Own(false)) => Ok(Asked::default()),
        Some(ProjectIn::Own(true)) => own_project(words, on, usage),
        Some(ProjectIn::Named(name)) if name.is_empty() => own_project(words, on, usage),
        Some(ProjectIn::Named(name)) => match on {
            None => Err(refused(&words.project_off_computer, &[("value", name)], usage)),
            Some(_) => Ok(Asked { project: true, name: Some(name.clone()) }),
        },
    }
}

fn own_project(words: &Words, on: Option<&str>, usage: &str) -> Result<Asked, Failure> {
    match on {
        Some(_) => Err(refused(&words.project_unnamed, &[], usage)),
        None => Ok(Asked { project: true, name: None }),
    }
}

/// The computer or workspace a call names: a workspace by its name, a computer by the name computers lists it
/// under, and the computer the host runs on where neither is given; a project on that computer by its name.
pub async fn target(
    client: &Client,
    words: &Words,
    workspace: Option<&str>,
    on: Option<&str>,
    usage: &str,
    project: Option<&str>,
) -> Result<Value, Failure> {
    let mut target = Map::new();
    match (workspace, on) {
        (Some(_), Some(_)) => return Err(refused(&words.aimed_both, &[], usage)),
        (Some(workspace), None) => {
            target.insert("workspaceId".to_owned(), Value::from(workspace_id(client, words, workspace).await?));
        }
        (None, Some(on)) => {
            target.insert("placeId".to_owned(), Value::from(place_id(client, words, on).await?));
            if let Some(project) = project {
                target.insert("project".to_owned(), Value::from(project));
            }
        }
        (None, None) => {
            target.insert("placeId".to_owned(), Value::from(words.here_place_id.as_str()));
        }
    }
    Ok(Value::Object(target))
}

/// A workspace by id, or by its name where one carries it, as the host resolves it.
async fn workspace_id(client: &Client, words: &Words, reference: &str) -> Result<String, Failure> {
    #[derive(Deserialize)]
    struct Resolved {
        #[serde(default)]
        workspace: Option<Value>,
    }
    let mut asked = Map::new();
    asked.insert("ref".to_owned(), Value::from(reference));
    let resolved: Resolved = client.request("workspaces.resolve", asked).await?;
    match resolved.workspace.as_ref().and_then(|w| w.get("id")).and_then(Value::as_str) {
        Some(id) => Ok(id.to_owned()),
        None => Err(Failure::new(fill(&words.other_version, &[("op", "workspaces.resolve")]))),
    }
}

/// A computer by the name or the id the list carries; a word nothing holds is refused with the names there are.
pub async fn place_id(client: &Client, words: &Words, word: &str) -> Result<String, Failure> {
    #[derive(Deserialize)]
    struct Place {
        id: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct Places {
        places: Vec<Place>,
    }
    let Places { places } = client.request("places.list", Map::new()).await?;
    if let Some(place) = places.iter().find(|p| p.id == word || p.name == word) {
        return Ok(place.id.clone());
    }
    let held = places.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
    Err(Failure::usage(refusal_line(&fill(&words.no_such_place, &[("word", word), ("held", &held)]), &words.places_fix)))
}

/// `refusalLine`: what happened, closed with a full stop where it does not close itself, then the fix.
pub fn refusal_line(happened: &str, fix: &str) -> String {
    let said = happened.trim_end_matches(js_space);
    let stop = if said.ends_with(['.', '!', '?', ':']) { "" } else { "." };
    format!("{said}{stop} {fix}")
}

/// An agent as the catalog names it; an id the catalog does not know reads as itself.
pub fn agent_name(words: &Words, id: &str) -> String {
    words.agent_names.get(id).cloned().unwrap_or_else(|| id.to_owned())
}

/// What JavaScript's `\s` and `trimEnd` take as a space.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Text as a terminal may print it: no control character but newline and tab.
pub fn printable(text: &str) -> String {
    text.chars().filter(|&c| !(matches!(c, '\0'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))).collect()
}

/// A name a line prints: on one line, and with no control character.
pub fn cell(text: &str) -> String {
    text.chars()
        .filter_map(|c| if c == '\n' || c == '\t' { Some(' ') } else { (!matches!(c, '\0'..='\u{1f}' | '\u{7f}'..='\u{9f}')).then_some(c) })
        .collect()
}

/// Columns padded to their widest cell, two spaces apart, the last never padded: widths in UTF-16 units, as
/// JavaScript's `length` and `padEnd` count them.
pub fn table(rows: &[Vec<String>]) -> Vec<String> {
    let width = |s: &str| s.encode_utf16().count();
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            match widths.get_mut(i) {
                Some(w) => *w = (*w).max(width(cell)),
                None => widths.push(width(cell)),
            }
        }
    }
    rows.iter()
        .map(|row| {
            let cells: Vec<String> =
                row.iter()
                    .enumerate()
                    .map(|(i, cell)| {
                        if i == row.len() - 1 {
                            cell.clone()
                        } else {
                            format!("{cell}{}", " ".repeat(widths[i].saturating_sub(width(cell))))
                        }
                    })
                    .collect();
            cells.join("  ").trim_end_matches(js_space).to_owned()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::words;

    #[test]
    fn a_table_pads_by_what_javascript_counts() {
        let rows = vec![vec!["A".to_owned(), "B".to_owned()], vec!["🧪".to_owned(), "x ".to_owned()]];
        assert_eq!(table(&rows), ["A   B", "🧪  x"]);
    }

    #[test]
    fn a_refusal_closes_what_happened_once() {
        assert_eq!(refusal_line("no place named x; you have a. ", "Run it."), "no place named x; you have a. Run it.");
        assert_eq!(refusal_line("you have ", "Run it."), "you have. Run it.");
    }

    #[test]
    fn a_project_is_asked_by_flag_with_a_workspace_and_by_name_with_a_computer() {
        let words = words();
        let asked = |value: ProjectIn, on: Option<&str>| project_asked(&words, Some(&value), on, "u").map(|a| (a.project, a.name));
        assert_eq!(asked(ProjectIn::Own(true), None).unwrap(), (true, None));
        assert_eq!(asked(ProjectIn::Named(String::new()), None).unwrap(), (true, None));
        assert_eq!(asked(ProjectIn::Named("api".into()), Some("attic")).unwrap(), (true, Some("api".into())));
        assert_eq!(asked(ProjectIn::Own(false), Some("attic")).unwrap(), (false, None));
        assert!(asked(ProjectIn::Own(true), Some("attic")).is_err());
        assert!(asked(ProjectIn::Named("api".into()), None).is_err());
    }
}
