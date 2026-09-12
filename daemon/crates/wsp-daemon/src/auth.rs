// SPDX-License-Identifier: AGPL-3.0-only
//! The token file is the only source, read at every auth frame so the host can rotate it while the daemon runs;
//! an exported token or a query string never counts.

use std::path::Path;

use subtle::ConstantTimeEq;

/// The token as the file holds it now, trimmed; nothing when the file is missing, unreadable or blank.
pub(crate) fn current_token(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let token = text.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

/// Whether the token a peer sent is the one the file holds now, compared in constant time.
pub(crate) fn token_matches(given: &str, path: &Path) -> bool {
    match current_token(path) {
        Some(expected) => expected.as_bytes().ct_eq(given.as_bytes()).into(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn token_file(text: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(text.as_bytes()).unwrap();
        f
    }

    #[test]
    fn the_file_is_read_trimmed_and_blank_counts_as_none() {
        assert_eq!(current_token(token_file("abc\n").path()).as_deref(), Some("abc"));
        assert_eq!(current_token(token_file("  \n").path()), None);
        assert_eq!(current_token(Path::new("/nonexistent/token")), None);
    }

    #[test]
    fn a_rotated_file_refuses_the_old_token_on_the_next_read() {
        let f = token_file("first\n");
        assert!(token_matches("first", f.path()));
        assert!(!token_matches("firs", f.path()));
        assert!(!token_matches("first2", f.path()));
        std::fs::write(f.path(), "second\n").unwrap();
        assert!(!token_matches("first", f.path()));
        assert!(token_matches("second", f.path()));
    }

    #[test]
    fn a_missing_or_blank_file_matches_nothing() {
        assert!(!token_matches("", token_file("").path()));
        assert!(!token_matches("x", Path::new("/nonexistent/token")));
    }
}
