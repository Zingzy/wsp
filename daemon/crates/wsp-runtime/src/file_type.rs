// SPDX-License-Identifier: AGPL-3.0-only
//! What kind of entry a mode names, read off its type field whole. The field is a number and not a set of bits: a
//! socket's (0o140000) and a block device's (0o060000) each hold a folder's bit (0o040000), so asking whether the
//! mode contains the folder's bits reads either as a folder.

const TYPE_FIELD: u32 = 0o170000;
const FOLDER: u32 = 0o040000;
const REGULAR: u32 = 0o100000;
const LINK: u32 = 0o120000;

/// Whether the mode is a folder's.
pub fn is_folder(mode: impl Into<u32>) -> bool {
    mode.into() & TYPE_FIELD == FOLDER
}

/// Whether the mode is a regular file's, and not a fifo, a socket or a device's.
pub fn is_regular(mode: impl Into<u32>) -> bool {
    mode.into() & TYPE_FIELD == REGULAR
}

/// Whether the mode is a symbolic link's, read off a stat that did not follow it.
pub fn is_link(mode: impl Into<u32>) -> bool {
    mode.into() & TYPE_FIELD == LINK
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn a_socket_and_a_block_device_are_neither_a_folder_nor_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("door.sock");
        let _held = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let socket = std::fs::symlink_metadata(&socket).unwrap().mode();
        assert!(!is_folder(socket));
        assert!(!is_regular(socket));
        assert!(!is_link(socket));
        assert!(!is_folder(0o060660u32), "a block device");
        assert!(is_folder(std::fs::metadata(dir.path()).unwrap().mode()));
        std::fs::write(dir.path().join("f"), "").unwrap();
        assert!(is_regular(std::fs::metadata(dir.path().join("f")).unwrap().mode()));
        std::os::unix::fs::symlink(dir.path().join("f"), dir.path().join("l")).unwrap();
        let link = std::fs::symlink_metadata(dir.path().join("l")).unwrap().mode();
        assert!(is_link(link) && !is_regular(link) && !is_folder(link));
    }

    /// A socket a project holds is no folder, though its type bits hold a folder's: it is staged as a file, since a
    /// bind wants the same kind at both ends and a folder staged for it fails the create.
    #[test]
    fn a_socket_in_a_project_folder_is_staged_as_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let rootfs = dir.path().join("rootfs");
        let on_box = dir.path().join("copies/wsp-a");
        let binds = dir.path().join("binds");
        for made in [rootfs.join("wsp/projects/demo"), on_box.clone(), binds.clone()] {
            std::fs::create_dir_all(made).unwrap();
        }
        let _inside = std::os::unix::net::UnixListener::bind(rootfs.join("wsp/projects/demo/app.sock")).unwrap();
        let _on_box = std::os::unix::net::UnixListener::bind(on_box.join("app.sock")).unwrap();
        let roots = vec![("/wsp/projects/demo".to_owned(), on_box.clone())];
        let staged = crate::engine::map_bind(&rootfs, &roots, &binds, "life-0", "/wsp/projects/demo/app.sock").unwrap();
        assert!(staged.at.is_file(), "{} was staged as a folder", staged.at.display());
    }
}
