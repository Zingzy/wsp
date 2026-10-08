// SPDX-License-Identifier: AGPL-3.0-only
//! The record this server serves from, copied into the build's own folder, which every tool embeds it from. A public
//! build (PUBLIC_BUILD=1, which the release sets) carries no cloud: no tool's cloud-on entry, the greetings with the
//! cloud on said as the ones with it off, and no provider the add tool refuses as a computer, since the public host
//! registers none. Any other build copies the record as it stands.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::Path;

use serde_json::value::RawValue;
use serde_json::Value;

fn main() {
    println!("cargo::rerun-if-env-changed=PUBLIC_BUILD");
    println!("cargo::rerun-if-changed=record");
    println!("cargo::rustc-check-cfg=cfg(wsp_public)");
    let public = env::var("PUBLIC_BUILD").as_deref() == Ok("1");
    if public {
        println!("cargo::rustc-cfg=wsp_public");
    }
    let out = Path::new(&env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("record");
    copy(Path::new("record"), &out, public);
}

fn copy(from: &Path, to: &Path, public: bool) {
    fs::create_dir_all(to).unwrap_or_else(|e| panic!("{}: {e}", to.display()));
    for entry in fs::read_dir(from).unwrap_or_else(|e| panic!("{}: {e}", from.display())) {
        let path = entry.expect("a record entry").path();
        let target = to.join(path.file_name().expect("a named entry"));
        if path.is_dir() {
            copy(&path, &target, public);
            continue;
        }
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let text = if public { without_cloud(&path, &text) } else { text };
        fs::write(&target, text).unwrap_or_else(|e| panic!("{}: {e}", target.display()));
    }
}

/// One record file as a build with no cloud serves it. A tool's cloud-off entry keeps the bytes it was recorded in.
fn without_cloud(path: &Path, text: &str) -> String {
    let file = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let in_tools = path.parent().and_then(Path::file_name).is_some_and(|n| n == "tools");
    let read = |text: &str| -> Value { serde_json::from_str(text).unwrap_or_else(|e| panic!("{}: {e}", path.display())) };
    if in_tools {
        let entries: BTreeMap<String, &RawValue> = serde_json::from_str(text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let off = entries.get("cloudOff").map_or("null", |raw| raw.get());
        return format!("{{\"cloudOff\": {off}, \"cloudOn\": null}}\n");
    }
    match file {
        "words.json" => {
            let mut words = read(text);
            words["add"]["providers"] = Value::Array(Vec::new());
            serde_json::to_string_pretty(&words).expect("words serialize")
        }
        "server.json" => {
            let mut server = read(text);
            for (on, off) in
                [("cloudOn", "cloudOff"), ("scopedCloudOn", "scopedCloudOff"), ("scopedNoSlateCloudOn", "scopedNoSlateCloudOff")]
            {
                server["instructions"][on] = server["instructions"][off].clone();
            }
            serde_json::to_string_pretty(&server).expect("server serializes")
        }
        _ => text.to_owned(),
    }
}
