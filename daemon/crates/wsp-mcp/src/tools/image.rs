// SPDX-License-Identifier: AGPL-3.0-only
//! The image tools: the record this host owns with its copies and project images, a copy built at a place, a
//! workspace moved onto the newest version, and a project image removed. What the TypeScript tool parses through
//! the protocol's schema is typed here in that schema's order, a field it does not know dropped as the parse drops
//! it; the recipe a record carries passes through as the host wrote it.

use serde::{Deserialize, Serialize};
use serde_json::value::{to_raw_value, RawValue};
use serde_json::{Map, Number, Value};

use super::workspace::{self, counted, fmt_bytes, js_prefix, js_sorted, name_list, params, read, rebuilt_line, workspace_of, Phase};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

/// packages/protocol's SealedImage.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedImage {
    name: String,
    version: Number,
    hash: String,
    recipe_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recipe: Option<Box<RawValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pins: Option<Vec<SealedPin>>,
    logins: Vec<Login>,
    sealed_at: String,
    sealed_from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vault: Option<SealedVault>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    used_bytes: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    place: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SealedPin {
    tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    latest: Option<bool>,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    road: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Login {
    name: String,
    state: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedVault {
    sha256: String,
    bytes: Number,
    paths: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    held: Option<Vec<String>>,
    taken_at: String,
}

/// packages/protocol's SealedImageCopy.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedImageCopy {
    place: String,
    version: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    snapshot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    template_id: Option<String>,
    built_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size_bytes: Option<Number>,
}

/// packages/protocol's ProjectGolden, and with `size_bytes` its SealedProjectImage.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGolden {
    snapshot_id: String,
    projects: Vec<WorkspaceProject>,
    golden: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<Number>,
    workspace_id: String,
    workspace_name: String,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    place: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size_bytes: Option<Number>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    name: String,
    dest: String,
    imported_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<Number>,
}

/// packages/protocol's SealedImageView.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ImageOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    image: Option<SealedImage>,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    copies: Vec<SealedImageCopy>,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    projects: Vec<ProjectGolden>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ImageIn {}

fn f64_of(n: &Number) -> f64 {
    n.as_f64().unwrap_or(0.0)
}

/// Whether the copy was built from the record as it is now; nothing where the record holds no vault, since such a
/// record was read back off its copies and judges none of them.
fn standing(image: &SealedImage, copy: &SealedImageCopy) -> Option<String> {
    let words = workspace::words();
    image.vault.as_ref()?;
    Some(if copy.hash.as_deref() == Some(image.hash.as_str()) { words.copy_current } else { words.copy_stale })
}

fn copy_line(image: &SealedImage, copy: &SealedImageCopy) -> String {
    let mut parts = vec![copy.place.clone(), format!("v{}", copy.version)];
    parts.extend(copy.size_bytes.as_ref().map(|n| fmt_bytes(f64_of(n))));
    parts.extend(standing(image, copy));
    parts.join("  ")
}

fn image_line(image: &SealedImage) -> String {
    let words = workspace::words();
    let held = match &image.vault {
        None => words.image_no_vault,
        Some(vault) => {
            let signed = image.logins.iter().filter(|l| words.logins_held.contains(&l.state)).count();
            format!("{} held, {}", workspace::plural(&Number::from(signed), "sign-in"), workspace::plural(&vault.paths, "path"))
        }
    };
    let mut parts = vec![format!("{} v{}", image.name, image.version), image.hash.clone(), held];
    parts.extend(image.used_bytes.as_ref().map(|n| fmt_bytes(f64_of(n))));
    parts.push(format!("sealed on {}", image.sealed_from));
    parts.join("  ")
}

fn pin_line(pin: &SealedPin) -> String {
    let words = workspace::words();
    let name = words.catalog_names.get(&pin.id).cloned().unwrap_or_else(|| pin.id.split('/').skip(2).collect::<Vec<_>>().join("/"));
    let mut parts = vec![name, pin.tag.clone()];
    parts.extend(pin.sha256.as_ref().map(|sum| format!("checksum {}", js_prefix(sum, words.sum_shown))));
    if pin.latest == Some(true) {
        let road = pin.road.as_ref().and_then(|r| words.road_words.get(r));
        parts.push(road.map_or(words.installs_latest.clone(), |said| format!("{} {said}", words.installs_latest)));
    }
    format!("  {}", parts.join("  "))
}

fn project_line(project: &ProjectGolden) -> String {
    let mut parts = vec![
        project.snapshot_id.clone(),
        format!("project {}", project.workspace_name),
        project.projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "),
    ];
    parts.extend(project.size_bytes.as_ref().map(|n| fmt_bytes(f64_of(n))));
    parts.push(project.created_at.clone());
    parts.join("  ")
}

fn image_lines(view: &ImageOut) -> String {
    let Some(image) = &view.image else { return workspace::words().no_sealed_image };
    let mut lines = vec![image_line(image)];
    lines.extend(view.copies.iter().map(|c| copy_line(image, c)));
    lines.extend(image.pins.iter().flatten().map(pin_line));
    lines.extend(view.projects.iter().map(project_line));
    lines.join("\n")
}

async fn image_view(client: &crate::client::Client) -> Result<ImageOut, Failure> {
    #[derive(Deserialize)]
    struct Got {
        view: Box<RawValue>,
    }
    let got: Got = client.request("image.get", Map::new()).await?;
    read(&got.view, "image.get")
}

const IMAGE_NAME: &str = "image";

pub const IMAGE: Tool =
    Tool { name: IMAGE_NAME, listed: include_str!("../../record/tools/image.json"), call: |host, args| Box::pin(image(host, args)) };

async fn image(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ImageIn {} = input(IMAGE_NAME, arguments)?;
    let client = host.client().await?;
    let view = image_view(&client).await?;
    Ok(Answer::text(image_lines(&view), &view))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct BuildIn {
    pub place: String,
    #[serde(default)]
    pub force: Option<bool>,
}

/// packages/protocol's SealedImageBuilt.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct BuildOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    copy: SealedImageCopy,
    built: bool,
}

const BUILD_NAME: &str = "image_build";

pub const BUILD: Tool =
    Tool { name: BUILD_NAME, listed: include_str!("../../record/tools/image_build.json"), call: |host, args| Box::pin(build(host, args)) };

/// The build's frames carry the place's id whichever word named it; a word the list does not hold goes to the host
/// as typed, since the host is the one judge of what it names.
async fn build(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    struct Place {
        id: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct Places {
        places: Vec<Place>,
    }
    #[derive(Deserialize)]
    struct Built {
        build: Box<RawValue>,
    }
    let BuildIn { place, force } = input(BUILD_NAME, arguments)?;
    let client = host.client().await?;
    let listed: Places = client.request("places.list", Map::new()).await?;
    let id = listed.places.into_iter().find(|p| p.id == place || p.name == place).map_or(place, |p| p.id);
    let mut asked = params([("place", Value::from(id))]);
    if force == Some(true) {
        asked.insert("force".to_owned(), Value::Bool(true));
    }
    let built: Built = client.request("image.build", asked).await?;
    let view = image_view(&client).await?;
    let Some(image) = &view.image else { return Err(Failure::new(workspace::words().no_sealed_image).into()) };
    let built: BuildOut = read(&built.build, "image.build")?;
    let line = copy_line(image, &built.copy);
    let said = if built.built { line } else { format!("{line}  already built from this image; nothing was built") };
    Ok(Answer::text(said, &built))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MoveIn {
    pub workspace: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct MoveOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    workspace: Box<RawValue>,
    moved: bool,
    kept: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fallback: Option<bool>,
}

const MOVE_NAME: &str = "image_move";

pub const MOVE: Tool = Tool {
    name: MOVE_NAME,
    listed: include_str!("../../record/tools/image_move.json"),
    call: |host, args| Box::pin(move_image(host, args)),
};

async fn move_image(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Now {
        name: String,
        machine_id: String,
        phase: Phase,
    }
    let MoveIn { workspace } = input(MOVE_NAME, arguments)?;
    let client = host.client().await?;
    let source = workspace_of(&client, &workspace).await?;
    let mut moved: MoveOut = client.request("workspaces.updateImage", params([("workspaceId", Value::from(source.id))])).await?;
    moved.fallback = moved.fallback.filter(|f| *f);
    let now: Now = read(&moved.workspace, "workspaces.updateImage")?;
    let words = workspace::words();
    let kept = if !moved.moved {
        words.already_newest
    } else if moved.fallback == Some(true) {
        words.kept_fallback
    } else if moved.kept.is_empty() {
        words.kept_none
    } else {
        let names = name_list(&js_sorted(moved.kept.clone()));
        fill(&counted(moved.kept.len() as u64, &words.kept_one, &words.kept_many), &[("names", &names)])
    };
    let said = fill(&words.moved, &[("rebuilt", &rebuilt_line(&now.name, now.phase, &now.machine_id)), ("kept", &kept)]);
    Ok(Answer::text(said, &moved))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveIn {
    pub image: String,
    #[serde(default)]
    pub confirm: Option<bool>,
}

/// packages/protocol's ProjectGoldenRemoved. The record is the list's row as the host sent it on an unconfirmed
/// call, and the parsed record the removal answers with on a confirmed one.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RemoveOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    project_golden: Box<RawValue>,
    already_gone: bool,
}

const REMOVE_NAME: &str = "image_remove";

pub const REMOVE: Tool = Tool {
    name: REMOVE_NAME,
    listed: include_str!("../../record/tools/image_remove.json"),
    call: |host, args| Box::pin(remove(host, args)),
};

/// A remove takes the snapshot id alone, never a project's name. Without confirm nothing goes and the answer is what
/// would, which is the line to put to the person.
async fn remove(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        snapshot_id: String,
        workspace_name: String,
        created_at: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Listed {
        project_goldens: Vec<Box<RawValue>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Removed {
        project_golden: ProjectGolden,
        already_gone: bool,
    }
    let RemoveIn { image: id, confirm } = input(REMOVE_NAME, arguments)?;
    let client = host.client().await?;
    let words = workspace::words();
    let listed: Listed = client.request("projectGoldens.list", Map::new()).await?;
    let mut found = None;
    for raw in listed.project_goldens {
        let row: Row = read(&raw, "projectGoldens.list")?;
        if row.snapshot_id == id {
            found = Some((raw, row));
            break;
        }
    }
    let Some((raw, row)) = found else { return Err(Failure::of_kind(fill(&words.no_project_image, &[("id", &id)]), "not-found").into()) };
    if confirm != Some(true) {
        let notice = fill(&words.remove_notice, &[("workspace", &row.workspace_name), ("date", &js_prefix(&row.created_at, 10))]);
        let said = fill(&words.remove_kept, &[("id", &id), ("notice", &notice)]);
        return Ok(Answer::text_error(said, &RemoveOut { project_golden: raw, already_gone: false }));
    }
    let mut removed: Removed = client.request("projectGoldens.remove", params([("snapshotId", Value::from(id.as_str()))])).await?;
    removed.project_golden.size_bytes = None;
    let said = fill(if removed.already_gone { &words.removed_gone } else { &words.removed_now }, &[("id", &id)]);
    let project_golden = to_raw_value(&removed.project_golden).map_err(|e| Failure::new(e.to_string()))?;
    Ok(Answer::text(said, &RemoveOut { project_golden, already_gone: removed.already_gone }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<ImageIn, ImageOut>(IMAGE.listed);
        to_the_record::<BuildIn, BuildOut>(BUILD.listed);
        to_the_record::<MoveIn, MoveOut>(MOVE.listed);
        to_the_record::<RemoveIn, RemoveOut>(REMOVE.listed);
    }
}
