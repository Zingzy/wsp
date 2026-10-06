// SPDX-License-Identifier: AGPL-3.0-only

use std::io;

use nix::errno::Errno;
use nix::fcntl::{openat, OFlag};
use nix::sys::stat::Mode;

use super::{at, nix_at, open_inside, regular, write_file_inside, BoxLink, Error, Inside, Want};

/// Where the files of the ssh server an editor reaches a workspace through live inside it: its own disk, under no
/// home, since a fork's /root/.ssh is a cover and stays empty.
pub const SSH_DIR_INSIDE: &str = "/var/lib/wsp-ssh";

/// The ssh server's folder and its two files inside a workspace, by the rule `write_file_inside` holds: the folder
/// opened beneath the rootfs with no link of the workspace's followed and made the owner's alone through that
/// descriptor, and each file written through it. An absolute link the workspace planted at the folder or at a name
/// resolves against this computer's own root, where these writes would replace a key or change a folder's mode.
pub fn write_ssh_files_inside(place: &Inside, authorized_keys: &[u8], config: &[u8]) -> Result<(), Error> {
    let dir = open_inside(place, SSH_DIR_INSIDE, Want::Dir, BoxLink::Refused)?;
    let named = dir.named(place);
    let readable = openat(dir.fd(), ".", OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC, Mode::empty()).map_err(nix_at(&named))?;
    nix::sys::stat::fchmod(&readable, Mode::from_bits_truncate(0o700)).map_err(nix_at(&named))?;
    write_file_inside(place, &format!("{SSH_DIR_INSIDE}/authorized_keys"), authorized_keys, 0o600)?;
    write_file_inside(place, &format!("{SSH_DIR_INSIDE}/sshd_config"), config, 0o600)
}

/// The public half of the ssh server's host key inside a workspace, read through the folder's descriptor with no
/// link followed, so a link planted at the name reads as a refusal and never as a key of this computer's. Anything
/// but a regular file there is refused without a byte read, and a file longer than any key is refused after
/// `SSH_KEY_MAX` bytes, so the workspace can neither hold this read nor fill this process's memory. Nothing where
/// no key has been made yet.
pub fn ssh_host_key_inside(place: &Inside) -> Result<Option<String>, Error> {
    let dir = open_inside(place, SSH_DIR_INSIDE, Want::Dir, BoxLink::Refused)?;
    let name = "host_ed25519.pub";
    let landed = dir.named(place).join(name);
    let file = match openat(dir.fd(), name, OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC, Mode::empty()) {
        Err(Errno::ENOENT) => return Ok(None),
        other => other.map_err(nix_at(&landed))?,
    };
    let refused = |why: &str| Error { path: landed.clone(), source: io::Error::new(io::ErrorKind::InvalidData, why.to_owned()) };
    if !regular(&file).map_err(nix_at(&landed))? {
        return Err(refused("not a regular file"));
    }
    let max = wsp_frames::numbers::SSH_KEY_MAX;
    let mut text = String::new();
    io::Read::read_to_string(&mut io::Read::take(std::fs::File::from(file), max as u64 + 1), &mut text).map_err(at(&landed))?;
    if text.len() > max {
        return Err(refused("longer than any ssh key"));
    }
    Ok(Some(text.trim().to_owned()))
}
