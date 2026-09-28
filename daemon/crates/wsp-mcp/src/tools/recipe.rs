// SPDX-License-Identifier: AGPL-3.0-only
//! `recipe` and `recipe_scan`: this computer read against the catalog, which only the TypeScript collector reads, so
//! both run the wsp this server was handed as `wsp recipe --json` and `wsp recipe scan --json` and pass the object
//! it prints through. The text is that object drawn as a terminal with no colour draws it, as
//! packages/host/src/recipe-answer.ts `recipePrintout` and `scanPrintout` draw it.

use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use tokio::process::Command;

use super::said::{fmt_bytes, js_len, js_number, js_space, pad_end, pad_start, plural, quoted_inside, turns};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

pub const RECIPE: Tool =
    Tool { name: "recipe", listed: include_str!("../../record/tools/recipe.json"), call: |host, args| Box::pin(recipe(host, args)) };
pub const SCAN: Tool = Tool {
    name: "recipe_scan",
    listed: include_str!("../../record/tools/recipe_scan.json"),
    call: |host, args| Box::pin(scan(host, args)),
};

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RecipeIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signin: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub add: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub add_check: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ScanIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Vec<String>>,
}

/// The recipe as the command line printed it, every field in the bytes it wrote.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RecipeOut {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<String>"))]
    pub tick: Option<Box<RawValue>>,
    #[cfg_attr(test, schemars(with = "String"))]
    pub at: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "String"))]
    pub out: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub agents: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub tools: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "u64"))]
    pub total_bytes: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub heavy: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub commands: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub custom: Box<RawValue>,
}

/// The scan as the command line printed it, every field in the bytes it wrote.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ScanOut {
    #[cfg_attr(test, schemars(with = "String"))]
    pub tick: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "String"))]
    pub at: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub agents: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub tools: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "u64"))]
    pub total_bytes: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub heavy: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Value"))]
    pub also_here: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub commands: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "Vec<Value>"))]
    pub sign_ins: Box<RawValue>,
}

/// A path the collector reads on this computer, refused unless absolute, since this server's own folder is wherever
/// the agent launched it and a relative path would resolve somewhere neither meant.
fn absolute(template: &str, path: &str) -> Result<(), Failure> {
    if path.starts_with('/') {
        Ok(())
    } else {
        Err(Failure::usage(fill(template, &[("path", &quoted_inside(path))])))
    }
}

fn projects_absolute(projects: Option<&[String]>) -> Result<(), Failure> {
    projects.unwrap_or_default().iter().try_for_each(|p| absolute(&turns().recipe.project_not_absolute, p))
}

fn flags(into: &mut Vec<String>, flag: &str, values: Option<&[String]>) {
    into.extend(values.unwrap_or_default().iter().map(|v| format!("--{flag}={v}")));
}

/// The failure object the command line prints on stderr under --json, read back into the failure it was.
#[derive(Deserialize)]
struct Printed {
    error: String,
    class: String,
    #[allow(dead_code)]
    exit: i32,
}

/// Runs the wsp this server was handed with `words` under --json and answers the one object it printed.
async fn wsp(host: &Host, words: &[String]) -> Result<String, Failure> {
    let Some((program, lead)) = host.args().wsp.split_first() else {
        return Err(Failure::new("this tool server was started without the wsp command the recipe tools run"));
    };
    let ran = Command::new(program)
        .args(lead)
        .args(words)
        .env_clear()
        .envs(host.env())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| Failure::new(format!("{program}: {e}")))?;
    let stdout = String::from_utf8_lossy(&ran.stdout);
    let last = |text: &str| text.lines().rev().find(|l| !l.trim().is_empty()).map(str::to_owned);
    if ran.status.success() {
        return last(&stdout).ok_or_else(|| Failure::new(format!("{program} printed nothing")));
    }
    let stderr = String::from_utf8_lossy(&ran.stderr);
    let printed = stderr.lines().rev().find_map(|l| serde_json::from_str::<Printed>(l).ok());
    Err(match printed {
        Some(Printed { error, class, .. }) => match class.as_str() {
            "usage" | "auth" => Failure::of_kind(error, &class),
            _ => Failure::new(error),
        },
        None => Failure::new(last(&stderr).unwrap_or_else(|| format!("{program} exited with {}", ran.status))),
    })
}

async fn recipe(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RecipeIn { tick, set, signin, add, add_check, why, engine, project, out } = input("recipe", arguments)?;
    if let Some(out) = &out {
        absolute(&turns().recipe.out_not_absolute, out)?;
    }
    projects_absolute(project.as_deref())?;
    let mut words = vec!["recipe".to_owned(), "--json".to_owned(), "--state".to_owned(), host.args().state.to_string_lossy().into_owned()];
    flags(&mut words, "tick", tick.as_slice().into());
    flags(&mut words, "set", set.as_deref());
    flags(&mut words, "signin", signin.as_deref());
    flags(&mut words, "add", add.as_deref());
    flags(&mut words, "add-check", add_check.as_deref());
    flags(&mut words, "why", why.as_slice().into());
    if engine == Some(true) {
        words.push("--engine".to_owned());
    }
    flags(&mut words, "project", project.as_deref());
    flags(&mut words, "out", out.as_slice().into());
    let printed = wsp(&host, &words).await?;
    let answer: RecipeOut = serde_json::from_str(&printed).map_err(|e| Failure::new(format!("wsp recipe: {e}")))?;
    let drawn: Drawn = serde_json::from_str(&printed).map_err(|e| Failure::new(format!("wsp recipe: {e}")))?;
    Ok(Answer::text(recipe_printout(&drawn).join("\n"), &answer))
}

async fn scan(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ScanIn { project } = input("recipe_scan", arguments)?;
    projects_absolute(project.as_deref())?;
    let mut words = ["recipe", "scan", "--json", "--state"].map(str::to_owned).to_vec();
    words.push(host.args().state.to_string_lossy().into_owned());
    flags(&mut words, "project", project.as_deref());
    let printed = wsp(&host, &words).await?;
    let answer: ScanOut = serde_json::from_str(&printed).map_err(|e| Failure::new(format!("wsp recipe scan: {e}")))?;
    let drawn: Drawn = serde_json::from_str(&printed).map_err(|e| Failure::new(format!("wsp recipe scan: {e}")))?;
    Ok(Answer::text(scan_printout(&drawn, platform()).join("\n"), &answer))
}

/// This computer as the collector names its platform.
fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// What the tables are drawn from, read off the same object either tool answers with.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Drawn {
    #[serde(default)]
    tick: Option<String>,
    agents: Vec<Row>,
    tools: Vec<Row>,
    commands: Vec<Ran>,
    #[serde(default)]
    also_here: Option<AlsoHere>,
    #[serde(default)]
    sign_ins: Vec<SignIn>,
}

#[derive(Deserialize)]
struct Row {
    name: String,
    on: bool,
    group: String,
    why: String,
    #[serde(default)]
    size: Option<f64>,
    #[serde(default)]
    pin: Option<Pin>,
    #[serde(default)]
    recommended: Option<Advice>,
}

#[derive(Deserialize)]
struct Pin {
    tag: String,
    #[serde(default)]
    latest: Option<bool>,
}

#[derive(Deserialize)]
struct Advice {
    value: String,
}

#[derive(Deserialize)]
struct Ran {
    name: String,
    calls: f64,
    sessions: f64,
}

#[derive(Deserialize)]
struct AlsoHere {
    scanned: bool,
    managers: Vec<Manager>,
}

#[derive(Deserialize)]
struct Manager {
    manager: String,
    rows: Vec<Package>,
}

#[derive(Deserialize)]
struct Package {
    id: String,
    install: String,
    #[serde(default)]
    size: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignIn {
    id: String,
    sign_in: String,
    recommended: Advice,
}

fn trim_end(text: String) -> String {
    text.trim_end_matches(js_space).to_owned()
}

/// Columns as wide as their widest cell, flush right where `right` says, apart by the gutter.
fn table(rows: &[Vec<String>], right: &[bool]) -> Vec<String> {
    let gutter = &turns().recipe.gutter;
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if widths.len() <= i {
                widths.push(0);
            }
            widths[i] = widths[i].max(js_len(cell));
        }
    }
    rows.iter()
        .map(|row| {
            let cells: Vec<String> = row
                .iter()
                .enumerate()
                .map(|(i, c)| if right.get(i) == Some(&true) { pad_start(c, widths[i]) } else { pad_end(c, widths[i]) })
                .collect();
            trim_end(cells.join(gutter))
        })
        .collect()
}

fn size_text(size: Option<f64>) -> String {
    size.map_or_else(|| turns().recipe.unknown_size.clone(), fmt_bytes)
}

/// The rows as lines: the tick, the name, the group's word and why the row is here, the size flush right, and once
/// any row carries one, what the last seal installed.
fn table_lines(rows: &[Row]) -> Vec<String> {
    let words = &turns().recipe;
    let label_width = words.group_labels.values().map(|l| js_len(l)).max().unwrap_or(0);
    let cells: Vec<(String, String, String)> = rows
        .iter()
        .map(|r| {
            let label = words.group_labels.get(&r.group).map_or("", String::as_str);
            let why = format!("{}{}{}", pad_end(label, label_width), words.gutter, r.why);
            let pin = r.pin.as_ref().map_or_else(String::new, |p| {
                if p.latest == Some(true) {
                    fill(&words.pin_latest, &[("tag", &p.tag)])
                } else {
                    p.tag.clone()
                }
            });
            (why, size_text(r.size), pin)
        })
        .collect();
    let name_width = rows.iter().map(|r| js_len(&r.name)).max().unwrap_or(0);
    let why_width = cells.iter().map(|c| js_len(&c.0)).max().unwrap_or(0);
    let size_width = cells.iter().map(|c| js_len(&c.1)).max().unwrap_or(0);
    let pinned = cells.iter().any(|c| !c.2.is_empty());
    rows.iter()
        .zip(&cells)
        .map(|(r, (why, size, pin))| {
            let tick = if r.on { &words.tick_on } else { &words.tick_off };
            let mut parts = vec![tick.clone(), pad_end(&r.name, name_width), pad_end(why, why_width), pad_start(size, size_width)];
            if pinned {
                parts.push(pin.clone());
            }
            trim_end(parts.join(&words.gutter))
        })
        .collect()
}

fn totals_line(rows: &[Row], noun: &str) -> String {
    let words = &turns().recipe;
    let on: Vec<&Row> = rows.iter().filter(|r| r.on).collect();
    let bytes: f64 = on.iter().map(|r| r.size.unwrap_or(0.0)).sum();
    let unknown = on.iter().filter(|r| r.size.is_none()).count();
    let mut line = fill(&words.totals, &[("on", &plural(on.len(), noun)), ("bytes", &fmt_bytes(bytes))]);
    if unknown > 0 {
        line.push_str(&fill(&words.totals_unknown, &[("unknown", &unknown.to_string())]));
    }
    line
}

fn floor_lines(tick: Option<&str>) -> Vec<String> {
    let words = &turns().recipe;
    if words.floor_applies.get(tick.unwrap_or("none")).copied().unwrap_or(false) {
        vec![words.floor_line.clone()]
    } else {
        Vec::new()
    }
}

/// The agents and the tools, each under its title with its totals, the floor under the tools; `advice` adds the do
/// column the scan carries.
fn tables(drawn: &Drawn, advice: bool) -> Vec<String> {
    let words = &turns().recipe;
    let mut lines = Vec::new();
    for (i, (title, rows, noun)) in
        [(&words.agents_title, &drawn.agents, "agent"), (&words.tools_title, &drawn.tools, "tool")].into_iter().enumerate()
    {
        if i > 0 {
            lines.push(String::new());
        }
        lines.push(title.clone());
        let drawn_rows = table_lines(rows);
        if advice {
            let width = drawn_rows.iter().map(|l| js_len(l)).max().unwrap_or(0);
            let done = rows.iter().map(|r| r.recommended.as_ref().map_or("", |a| a.value.as_str()));
            lines.extend(drawn_rows.iter().zip(done).map(|(l, value)| format!("{}{}{value}", pad_end(l, width), words.gutter)));
        } else {
            lines.extend(drawn_rows);
        }
        lines.push(totals_line(rows, noun));
        if noun == "tool" {
            lines.extend(floor_lines(drawn.tick.as_deref()));
        }
    }
    lines
}

fn command_lines(commands: &[Ran]) -> Vec<String> {
    let words = &turns().recipe;
    if commands.is_empty() {
        return vec![words.commands_title.clone(), words.none.clone()];
    }
    let shown = &commands[..commands.len().min(words.commands_shown)];
    let mut rows = vec![words.commands_head.clone()];
    rows.extend(shown.iter().map(|c| vec![c.name.clone(), js_number(c.calls), js_number(c.sessions)]));
    let mut lines = vec![words.commands_title.clone()];
    lines.extend(table(&rows, &[false, true, true]).into_iter().map(|l| format!("{}{l}", words.gutter)));
    if commands.len() > shown.len() {
        lines.push(fill(&words.more, &[("count", &(commands.len() - shown.len()).to_string())]));
    }
    lines
}

fn recipe_printout(drawn: &Drawn) -> Vec<String> {
    let mut lines = tables(drawn, false);
    lines.push(String::new());
    lines.extend(command_lines(&drawn.commands));
    lines
}

fn also_here_lines(also: Option<&AlsoHere>, platform: &str) -> Vec<String> {
    let words = &turns().recipe;
    let mut lines = vec![words.also_title.get(platform).cloned().unwrap_or_default()];
    match also {
        Some(also) if also.scanned && !also.managers.is_empty() => {
            for m in &also.managers {
                lines.push(format!("{}{}", words.gutter, m.manager));
                let rows: Vec<Vec<String>> = m.rows.iter().map(|r| vec![r.id.clone(), r.install.clone(), size_text(r.size)]).collect();
                lines.extend(table(&rows, &[false, false, true]).into_iter().map(|l| format!("{0}{0}{l}", words.gutter)));
            }
        }
        Some(also) if also.scanned => lines.push(words.none.clone()),
        _ => lines.push(format!("{}{}", words.gutter, words.not_scanned)),
    }
    lines
}

fn sign_in_lines(rows: &[SignIn]) -> Vec<String> {
    let words = &turns().recipe;
    if rows.is_empty() {
        return vec![words.sign_ins_title.clone(), words.none.clone()];
    }
    let mut table_rows = vec![words.sign_ins_head.clone()];
    table_rows.extend(rows.iter().map(|r| vec![r.id.clone(), r.sign_in.clone(), r.recommended.value.clone()]));
    let mut lines = vec![words.sign_ins_title.clone()];
    lines.extend(table(&table_rows, &[]).into_iter().map(|l| format!("{}{l}", words.gutter)));
    lines
}

fn scan_printout(drawn: &Drawn, platform: &str) -> Vec<String> {
    let mut lines = tables(drawn, true);
    lines.push(String::new());
    lines.extend(also_here_lines(drawn.also_here.as_ref(), platform));
    lines.push(String::new());
    lines.extend(command_lines(&drawn.commands));
    lines.push(String::new());
    lines.extend(sign_in_lines(&drawn.sign_ins));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::held::to_the_record;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<RecipeIn, RecipeOut>(RECIPE.listed);
        to_the_record::<ScanIn, ScanOut>(SCAN.listed);
    }
}
