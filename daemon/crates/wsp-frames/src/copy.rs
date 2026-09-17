// SPDX-License-Identifier: AGPL-3.0-only
//! The copy a workspace on the computer somebody sits at is made of: what the `copy` verb is asked for and the one
//! line it prints back. A computer that runs no workspaces of its own still makes a workspace, by copying the
//! project folder to a path of its own; which road made that copy, what rode along in it and what it stands on are
//! facts the host keeps on the workspace's record, so a row and a delete read them rather than asking the disk
//! again.

use serde::{Deserialize, Serialize};

/// Which road made a workspace's copy on a computer that copies by directory: a directory clone of the folder, a
/// git worktree of it, or the folder itself worked where it sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CopyRoadName {
    Clonefile,
    Worktree,
    InPlace,
}

impl CopyRoadName {
    /// The word the wire carries, which is also the word the verb's `--road` takes.
    pub fn word(self) -> &'static str {
        match self {
            CopyRoadName::Clonefile => "clonefile",
            CopyRoadName::Worktree => "worktree",
            CopyRoadName::InPlace => "in-place",
        }
    }
}

/// What rode along in the copy: everything the folder held that git ignores (the dependencies and the config
/// files), the config files alone, or nothing at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Carried {
    DepsAndConfig,
    ConfigOnly,
    Nothing,
}

/// One copy as `wsp-daemon copy make` is asked for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyAsk {
    pub from: String,
    pub to: String,
    /// The ref the copy is reset to; the folder's default branch when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Directories removed after the copy so they rebuild at the new path.
    pub exclude: Vec<String>,
    /// Apparent size above which the directory clone is not taken.
    pub size_line_bytes: u64,
    /// A road named outright; the picker's own choice when absent. Tests and the fallback proof name one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub road: Option<CopyRoadName>,
}

/// The one JSON line the verb prints when the copy stands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub road: CopyRoadName,
    pub path: String,
    /// The sha the copy stands at.
    pub base: String,
    /// The branch checked out in the copy; empty on a detached worktree.
    pub branch: String,
    /// Whether the fetch of the default branch landed before the reset.
    pub fetched: bool,
    pub carried: Carried,
    pub excluded: Vec<String>,
    /// The folder's apparent size as the walk read it.
    pub bytes: u64,
    pub ms: u64,
    /// Why the first road was not taken; absent when it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fell_back: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_road_words_are_the_words_the_wire_carries() {
        for road in [CopyRoadName::Clonefile, CopyRoadName::Worktree, CopyRoadName::InPlace] {
            assert_eq!(serde_json::to_value(road).unwrap(), serde_json::Value::from(road.word()));
        }
    }

    #[test]
    fn a_report_naming_a_road_nothing_here_has_is_refused() {
        let report = serde_json::json!({
            "road": "rsync",
            "path": "/tmp/x",
            "base": "abc",
            "branch": "main",
            "fetched": true,
            "carried": "deps-and-config",
            "excluded": [],
            "bytes": 1,
            "ms": 2
        });
        assert!(serde_json::from_value::<CopyReport>(report).is_err());
    }

    #[test]
    fn a_report_with_no_road_taken_leaves_the_reason_out_of_the_line() {
        let report = CopyReport {
            road: CopyRoadName::Clonefile,
            path: "/tmp/x".to_owned(),
            base: "abc".to_owned(),
            branch: "main".to_owned(),
            fetched: false,
            carried: Carried::DepsAndConfig,
            excluded: vec![".next".to_owned()],
            bytes: 7,
            ms: 8,
            fell_back: None,
        };
        let line = serde_json::to_string(&report).unwrap();
        assert!(!line.contains("fellBack"), "{line}");
        assert_eq!(serde_json::from_str::<CopyReport>(&line).unwrap(), report);
    }

    #[test]
    fn an_ask_carries_the_exclusions_and_the_size_line_and_leaves_the_rest_out() {
        let ask = CopyAsk {
            from: "/a".to_owned(),
            to: "/b".to_owned(),
            base: None,
            exclude: vec![".venv".to_owned()],
            size_line_bytes: 1024,
            road: None,
        };
        assert_eq!(
            serde_json::to_value(&ask).unwrap(),
            serde_json::json!({ "from": "/a", "to": "/b", "exclude": [".venv"], "sizeLineBytes": 1024 })
        );
    }
}
