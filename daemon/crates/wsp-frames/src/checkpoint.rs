// SPDX-License-Identifier: AGPL-3.0-only
//! Where a checkout keeps the record of its tree at each turn's end: one ref per turn, under a prefix named by the
//! copy's own folder, so the one copy that shares its git directory with the person's folder (a worktree) takes
//! its refs with it when it goes, by deleting that prefix, without asking which threads it held.

/// Every checkpoint's ref starts here, outside `refs/heads` and `refs/tags`: no push sends it and no branch view
/// lists it.
pub const CHECKPOINT_REFS: &str = "refs/wsp/checkpoints";

/// The part of a ref that names the copy: its folder's name, every character outside letters, digits, `.`, `_`
/// and `-` read as `-`, and never a name git refuses as a ref component (empty, dot-led or `.lock`-ended).
pub fn checkpoint_copy_part(folder_name: &str) -> String {
    let named: String =
        folder_name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' }).collect();
    let named = named.trim_start_matches('.').trim_end_matches(".lock").replace("..", "-");
    if named.is_empty() {
        "copy".to_owned()
    } else {
        named
    }
}

/// The prefix every checkpoint of the copy in that folder lives under, with its closing slash.
pub fn checkpoint_prefix(folder_name: &str) -> String {
    format!("{CHECKPOINT_REFS}/{}/", checkpoint_copy_part(folder_name))
}

/// Whether an id the host names a thread or a turn by may stand as one ref component as it is.
pub fn checkpoint_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_name_becomes_one_ref_component_git_takes() {
        assert_eq!(checkpoint_prefix("spoo-fix-login"), "refs/wsp/checkpoints/spoo-fix-login/");
        assert_eq!(checkpoint_copy_part("my project (copy)"), "my-project--copy-");
        assert_eq!(checkpoint_copy_part(".hidden"), "hidden");
        assert_eq!(checkpoint_copy_part("a..b"), "a-b");
        assert_eq!(checkpoint_copy_part("x.lock"), "x");
        assert_eq!(checkpoint_copy_part(""), "copy");
        assert_eq!(checkpoint_copy_part("naïve"), "na-ve");
    }

    #[test]
    fn two_copies_of_one_folder_never_share_a_prefix() {
        // Only copies of one repo share a git directory, and each is named `<its folder>-<the work's slug>`: the
        // folder part folds the same for every copy, and a slug is letters, digits and dashes, which fold to
        // themselves, so the prefixes differ wherever the slugs do.
        let prefixes = ["fix-login", "fix-login-2", "pricing-page"].map(|slug| checkpoint_prefix(&format!("my project (v2)-{slug}")));
        assert_eq!(prefixes.iter().collect::<std::collections::HashSet<_>>().len(), prefixes.len(), "{prefixes:?}");
    }

    #[test]
    fn an_id_is_one_plain_component_or_nothing() {
        assert!(checkpoint_id_ok("thr_01a0e365"));
        assert!(checkpoint_id_ok("turn-2"));
        for bad in ["", "a/b", "..", "a b", "x~1", "a^", &"x".repeat(101)] {
            assert!(!checkpoint_id_ok(bad), "{bad}");
        }
    }
}
