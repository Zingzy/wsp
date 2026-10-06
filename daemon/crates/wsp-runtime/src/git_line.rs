// SPDX-License-Identifier: AGPL-3.0-only
//! A git command line as this daemon builds one. git reads a word that starts with a dash as a flag wherever it
//! stands, and a fetch or a push takes `--upload-pack=<command>` or `--receive-pack=<command>` and runs it, while
//! update-ref takes a branch of that name. So the words this daemon writes itself are `&'static str` here and
//! nothing read off a checkout, a frame or an agent can stand among them; every such word goes on behind
//! `--end-of-options` as a revision, behind `--` as a path or a fetch's or a push's remote and refspec, as the value
//! of a flag that takes one, after a fixed start of its own, or as a commit id git printed. Every git this daemon
//! runs is built here, and the threat model test refuses a line built anywhere else.

use std::borrow::Cow;

/// Where the chosen words a line carries stand.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum After {
    Flags,
    EndOfOptions,
    Dashes,
}

#[derive(Debug, Clone)]
pub struct GitLine<'a> {
    env: Vec<String>,
    words: Vec<Cow<'a, str>>,
    after: After,
}

impl<'a> GitLine<'a> {
    pub fn new(fixed: &[&'static str]) -> GitLine<'a> {
        GitLine { env: Vec::new(), words: fixed.iter().map(|w| Cow::Borrowed(*w)).collect(), after: After::Flags }
    }

    /// More words of this daemon's own. Before any chosen word, since past a separator git reads none as a flag.
    pub fn words(mut self, fixed: &[&'static str]) -> GitLine<'a> {
        assert_eq!(self.after, After::Flags, "a flag after a separator is read as an operand: {:?}", self.words);
        self.words.extend(fixed.iter().map(|w| Cow::Borrowed(*w)));
        self
    }

    /// A flag that takes a value and its value as the next word, which git takes whole whatever it begins with.
    pub fn value(mut self, flag: &'static str, value: &'a str) -> GitLine<'a> {
        assert!(flag.starts_with('-'), "a value follows a flag, and {flag:?} is none");
        self = self.words(&[flag]);
        self.words.push(Cow::Borrowed(value));
        self
    }

    /// A chosen word after a fixed start of this daemon's own, as one word: `refs/heads/` and a branch, or
    /// `--count=` and a number. The start is no lone dash, so the word cannot begin as a flag git does not expect.
    pub fn glued(mut self, start: &'static str, rest: &str) -> GitLine<'a> {
        assert!(!start.trim_start_matches('-').is_empty(), "a start of dashes alone makes the chosen word a flag: {start:?}");
        assert_eq!(self.after, After::Flags, "a glued word after a separator: {:?}", self.words);
        self.words.push(Cow::Owned(format!("{start}{rest}")));
        self
    }

    /// A commit id as git printed it, which git cannot read as a flag: for checkout and reset, which before git 2.44
    /// read a word after `--end-of-options` as a path.
    pub fn oid(mut self, oid: &Oid) -> GitLine<'a> {
        assert_eq!(self.after, After::Flags, "a commit id after a separator: {:?}", self.words);
        self.words.push(Cow::Owned(oid.0.clone()));
        self
    }

    /// Revisions and ref names, after `--end-of-options`, the separator a revision is still read as one behind; past
    /// `--` a revision command reads a path.
    pub fn revs(mut self, revs: &[&'a str]) -> GitLine<'a> {
        assert!(self.after <= After::EndOfOptions, "a revision after `--` is read as a path: {:?}", self.words);
        let rev_parse = self.words.iter().any(|w| w == "rev-parse");
        assert!(!rev_parse || self.words.iter().any(|w| w == "--verify"), "rev-parse prints `--end-of-options` back without --verify");
        if self.after == After::Flags {
            self.words.push(Cow::Borrowed("--end-of-options"));
            self.after = After::EndOfOptions;
        }
        self.words.extend(revs.iter().map(|w| Cow::Borrowed(*w)));
        self
    }

    /// Paths, and the remote and refspecs of a fetch or a push, which read `--` as the end of their flags.
    pub fn operands(mut self, operands: &[&'a str]) -> GitLine<'a> {
        if self.after != After::Dashes {
            self.words.push(Cow::Borrowed("--"));
            self.after = After::Dashes;
        }
        self.words.extend(operands.iter().map(|w| Cow::Borrowed(*w)));
        self
    }

    /// A variable git runs with, as `env NAME=value git ...`: the only way git takes some, its index among them.
    pub fn env(mut self, name: &'static str, value: &str) -> GitLine<'a> {
        self.env.push(format!("{name}={value}"));
        self
    }

    /// The variables, each `NAME=value`, that run git under env; none runs git itself.
    pub fn env_words(&self) -> Vec<&str> {
        self.env.iter().map(String::as_str).collect()
    }

    /// The words after `git`.
    pub fn argv(&self) -> Vec<&str> {
        self.words.iter().map(|w| w.as_ref()).collect()
    }
}

/// A commit id as git printed it: hex digits alone, the forty of sha1 or the sixty-four of sha256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Oid(String);

impl Oid {
    pub fn parse(text: &str) -> Option<Oid> {
        let text = text.trim();
        (matches!(text.len(), 40 | 64) && text.bytes().all(|b| b.is_ascii_hexdigit())).then(|| Oid(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chosen_word_stands_behind_the_separator_its_kind_needs() {
        let branch = "--upload-pack=touch${IFS}/tmp/x";
        let fetch = GitLine::new(&["fetch", "--no-tags"]).operands(&["origin", branch]);
        assert_eq!(fetch.argv(), ["fetch", "--no-tags", "--", "origin", branch]);
        let diff = GitLine::new(&["diff", "-z"]).revs(&[branch, "HEAD"]).operands(&[":(top,literal)a"]);
        assert_eq!(diff.argv(), ["diff", "-z", "--end-of-options", branch, "HEAD", "--", ":(top,literal)a"]);
        let switch = GitLine::new(&["switch", "-q"]).value("-c", branch);
        assert_eq!(switch.argv(), ["switch", "-q", "-c", branch]);
        let checked = GitLine::new(&["check-ref-format"]).glued("refs/heads/", branch);
        assert_eq!(checked.argv(), ["check-ref-format", &format!("refs/heads/{branch}")]);
        let indexed = GitLine::new(&["write-tree"]).env("GIT_INDEX_FILE", "/x/i");
        assert_eq!((indexed.env_words(), indexed.argv()), (vec!["GIT_INDEX_FILE=/x/i"], vec!["write-tree"]));
    }

    #[test]
    fn a_second_call_of_one_kind_adds_no_second_separator() {
        let line = GitLine::new(&["rev-list"]).revs(&["a"]).revs(&["b"]).operands(&["p"]).operands(&["q"]);
        assert_eq!(line.argv(), ["rev-list", "--end-of-options", "a", "b", "--", "p", "q"]);
    }

    #[test]
    #[should_panic(expected = "read as a path")]
    fn a_revision_after_the_dashes_is_refused() {
        let _ = GitLine::new(&["diff"]).operands(&["p"]).revs(&["HEAD"]);
    }

    #[test]
    #[should_panic(expected = "read as an operand")]
    fn a_flag_after_a_separator_is_refused() {
        let _ = GitLine::new(&["diff"]).revs(&["HEAD"]).words(&["--stat"]);
    }

    #[test]
    #[should_panic(expected = "without --verify")]
    fn a_revision_on_rev_parse_wants_verify() {
        let _ = GitLine::new(&["rev-parse"]).revs(&["HEAD^{tree}"]);
    }

    #[test]
    #[should_panic(expected = "is none")]
    fn a_value_wants_a_flag_before_it() {
        let _ = GitLine::new(&["fetch"]).value("origin", "--upload-pack=x");
    }

    #[test]
    #[should_panic(expected = "dashes alone")]
    fn a_glued_start_of_dashes_alone_is_refused() {
        let _ = GitLine::new(&["push"]).glued("-", "-receive-pack=x");
    }

    #[test]
    fn a_commit_id_is_hex_of_git_s_two_lengths_and_nothing_else() {
        assert!(Oid::parse(&"a".repeat(40)).is_some());
        assert!(Oid::parse(&format!("{}\n", "0".repeat(64))).is_some());
        for not in ["HEAD", "-a", "", &"a".repeat(39), &format!("-{}", "a".repeat(39))] {
            assert!(Oid::parse(not).is_none(), "{not:?}");
        }
    }
}
