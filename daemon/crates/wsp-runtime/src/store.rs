// SPDX-License-Identifier: AGPL-3.0-only
//! The layer store under `<root>/layers`. Blobs land as fetched and are unpacked once; an image is a name over a
//! chain of layers and a config; a build is a recipe's hash over the chain it produced. A layer is referenced
//! while any image or build names it, and the sweep removes what nothing names. The shape on disk is `Layout`,
//! and nothing outside this file reads it.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::fetch::{self, Client, Descriptor, Digest, LayerEncoding, Manifest, Platform, Reference};

/// Every path the store writes, in one place.
struct Layout {
    root: PathBuf,
}

impl Layout {
    /// A blob still arriving sits beside its final name with this extension until the hash matches.
    const PARTIAL: &'static str = "partial";
    /// A record or a directory being written sits beside its final name with this extension until the rename.
    const IN_FLIGHT: &'static str = "tmp";

    fn blobs(&self) -> PathBuf {
        self.root.join("blobs").join("sha256")
    }
    fn blob(&self, digest: &Digest) -> PathBuf {
        self.blobs().join(digest.hex())
    }
    fn partial(&self, digest: &Digest) -> PathBuf {
        self.blob(digest).with_extension(Layout::PARTIAL)
    }
    fn is_partial(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == Layout::PARTIAL)
    }
    fn in_flight(&self, path: &Path) -> PathBuf {
        path.with_extension(Layout::IN_FLIGHT)
    }
    fn is_in_flight(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == Layout::IN_FLIGHT)
    }
    fn unpacked_all(&self) -> PathBuf {
        self.root.join("unpacked")
    }
    fn unpacked(&self, digest: &Digest) -> PathBuf {
        self.unpacked_all().join(digest.hex())
    }
    fn unpacking(&self, digest: &Digest) -> PathBuf {
        self.in_flight(&self.unpacked(digest))
    }
    fn images(&self) -> PathBuf {
        self.root.join("images")
    }
    fn image(&self, name: &str) -> PathBuf {
        self.images().join(format!("{}.json", file_word(name)))
    }
    fn builds(&self) -> PathBuf {
        self.root.join("builds")
    }
    fn build(&self, recipe: &str) -> PathBuf {
        self.builds().join(recipe)
    }
    fn dirs(&self) -> [PathBuf; 4] {
        [self.blobs(), self.unpacked_all(), self.images(), self.builds()]
    }
}

/// An image name as a file name: `/` and `%` percent-encoded, everything else as written.
fn file_word(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for byte in name.bytes() {
        match byte {
            b'/' | b'%' => out.push_str(&format!("%{byte:02X}")),
            _ => out.push(byte as char),
        }
    }
    out
}

/// A config over its layers in order: what a container is made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chain {
    pub config: Digest,
    pub layers: Vec<Digest>,
}

impl Chain {
    fn digests(&self) -> impl Iterator<Item = &Digest> {
        std::iter::once(&self.config).chain(self.layers.iter())
    }
}

/// `images/<name>.json`: the name, where it came from, the manifest it resolved to, and its chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Image {
    pub name: String,
    pub source: String,
    pub manifest: Digest,
    pub platform: Platform,
    #[serde(flatten)]
    pub chain: Chain,
    pub layer_bytes: Vec<u64>,
    pub pulled_at: u64,
}

/// `builds/<recipe sha256>`: the chain a recipe produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Build {
    pub recipe: String,
    #[serde(flatten)]
    pub chain: Chain,
    pub built_at: u64,
}

/// What a pull did: the image, and whether any byte moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pulled {
    pub image: Image,
    pub fetched: bool,
}

/// What a sweep removed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Swept {
    pub blobs: Vec<Digest>,
    pub partials: Vec<Digest>,
    pub unpacked: Vec<Digest>,
    pub bytes: u64,
}

#[derive(Debug)]
pub enum Error {
    Fetch(fetch::Error),
    /// A blob's bytes hashed to something other than its name.
    Corrupt {
        digest: Digest,
        actual: Digest,
    },
    Unpack {
        digest: Digest,
        detail: String,
    },
    Record {
        path: PathBuf,
        detail: String,
    },
    Io {
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Fetch(e) => write!(f, "fetch: {e}"),
            Error::Corrupt { digest, actual } => write!(f, "blob {digest} is corrupt: its bytes hash to {actual}"),
            Error::Unpack { digest, detail } => write!(f, "unpacking layer {digest}: {detail}"),
            Error::Record { path, detail } => write!(f, "{}: {detail}", path.display()),
            Error::Io { path, source } => write!(f, "{}: {source}", path.display()),
        }
    }
}

impl std::error::Error for Error {}

impl From<fetch::Error> for Error {
    fn from(e: fetch::Error) -> Error {
        match e {
            fetch::Error::Digest { expected, actual } => Error::Corrupt { digest: expected, actual },
            other => Error::Fetch(other),
        }
    }
}

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> Error + '_ {
    move |source| Error::Io { path: path.to_owned(), source }
}

pub struct Store {
    layout: Layout,
    platform: Platform,
}

impl Store {
    /// The store under `<root>/layers`, its directories made.
    pub fn open(root: &Path) -> Result<Store, Error> {
        let store = Store { layout: Layout { root: root.join("layers") }, platform: Platform::host() };
        for dir in store.layout.dirs() {
            fs::create_dir_all(&dir).map_err(io_at(&dir))?;
        }
        Ok(store)
    }

    /// The image under `name`, from the store if it holds one, else fetched from `source` into it. Every blob is
    /// checked against its digest before it lands; a wrong one is refused and nothing of it is kept.
    pub fn pull(&self, name: &str, source: &Reference, client: &mut Client) -> Result<Pulled, Error> {
        if let Some(image) = self.image(name)? {
            return Ok(Pulled { image, fetched: false });
        }
        let manifest = client.manifest(source, &self.platform)?;
        self.take_blob(client, source, &manifest.config)?;
        for layer in &manifest.layers {
            self.take_blob(client, source, layer)?;
            self.unpack(layer)?;
        }
        let image = Image::from_manifest(name, source, &manifest, &self.platform);
        self.write_record(&self.layout.image(name), &image)?;
        Ok(Pulled { image, fetched: true })
    }

    /// The image by its name, if the store holds it.
    pub fn image(&self, name: &str) -> Result<Option<Image>, Error> {
        self.read_record(&self.layout.image(name))
    }

    /// Every image the store holds.
    pub fn images(&self) -> Result<Vec<Image>, Error> {
        self.read_records(&self.layout.images())
    }

    /// Drops the name; its layers stay until the sweep finds nothing else names them.
    pub fn remove_image(&self, name: &str) -> Result<bool, Error> {
        remove_if_there(&self.layout.image(name))
    }

    /// The chain a recipe produced, under the recipe's sha256 hex.
    pub fn record_build(&self, recipe: &str, chain: Chain) -> Result<Build, Error> {
        let build = Build { recipe: recipe.to_owned(), chain, built_at: now() };
        self.write_record(&self.layout.build(recipe), &build)?;
        Ok(build)
    }

    pub fn build(&self, recipe: &str) -> Result<Option<Build>, Error> {
        self.read_record(&self.layout.build(recipe))
    }

    pub fn remove_build(&self, recipe: &str) -> Result<bool, Error> {
        remove_if_there(&self.layout.build(recipe))
    }

    /// How many images and builds name the layer or config.
    pub fn references(&self, digest: &Digest) -> Result<usize, Error> {
        let images = self.images()?.into_iter().filter(|i| i.chain.digests().any(|d| d == digest)).count();
        let builds =
            self.read_records::<Build>(&self.layout.builds())?.into_iter().filter(|b| b.chain.digests().any(|d| d == digest)).count();
        Ok(images + builds)
    }

    /// Where a layer's files lie, once unpacked: the directory an overlay takes as a lower.
    pub fn unpacked(&self, digest: &Digest) -> Option<PathBuf> {
        let path = self.layout.unpacked(digest);
        path.is_dir().then_some(path)
    }

    /// Whether the blob is in the store whole.
    pub fn has_blob(&self, digest: &Digest) -> bool {
        self.layout.blob(digest).is_file()
    }

    /// Removes every blob and unpacked layer no image or build names, every partial blob, and every unpack
    /// that never finished. Not for while a pull is in flight: a pull's partial and its unpack in progress
    /// are what it would take.
    pub fn sweep(&self) -> Result<Swept, Error> {
        let mut live: HashSet<Digest> = HashSet::new();
        for image in self.images()? {
            live.extend(image.chain.digests().cloned());
        }
        for build in self.read_records::<Build>(&self.layout.builds())? {
            live.extend(build.chain.digests().cloned());
        }
        let mut swept = Swept::default();
        let blobs = self.layout.blobs();
        for entry in fs::read_dir(&blobs).map_err(io_at(&blobs))? {
            let entry = entry.map_err(io_at(&blobs))?;
            let path = entry.path();
            let Some(digest) = digest_of(&path) else { continue };
            let partial = self.layout.is_partial(&path);
            if !partial && live.contains(&digest) {
                continue;
            }
            swept.bytes += entry.metadata().map_err(io_at(&path))?.len();
            fs::remove_file(&path).map_err(io_at(&path))?;
            if partial {
                swept.partials.push(digest);
            } else {
                swept.blobs.push(digest);
            }
        }
        let unpacked = self.layout.unpacked_all();
        for entry in fs::read_dir(&unpacked).map_err(io_at(&unpacked))? {
            let entry = entry.map_err(io_at(&unpacked))?;
            let path = entry.path();
            let Some(digest) = digest_of(&path) else { continue };
            let finished = !self.layout.is_in_flight(&path);
            if finished && live.contains(&digest) {
                continue;
            }
            swept.bytes += dir_bytes(&path)?;
            fs::remove_dir_all(&path).map_err(io_at(&path))?;
            if finished {
                swept.unpacked.push(digest);
            }
        }
        swept.blobs.sort();
        swept.unpacked.sort();
        Ok(swept)
    }

    /// The blob whole in the store, fetched if it is not: a partial from an earlier try is picked up where it
    /// stopped, and one whose bytes turn out wrong is deleted.
    fn take_blob(&self, client: &mut Client, source: &Reference, blob: &Descriptor) -> Result<(), Error> {
        let done = self.layout.blob(&blob.digest);
        if done.is_file() {
            return Ok(());
        }
        let partial = self.layout.partial(&blob.digest);
        let mut file = File::options().read(true).append(true).create(true).open(&partial).map_err(io_at(&partial))?;
        match client.blob(source, &blob.digest, &mut file) {
            Ok(_) => {}
            Err(fetch::Error::Digest { expected, actual }) => {
                drop(file);
                fs::remove_file(&partial).map_err(io_at(&partial))?;
                return Err(Error::Corrupt { digest: expected, actual });
            }
            Err(other) => return Err(other.into()),
        }
        file.sync_all().map_err(io_at(&partial))?;
        drop(file);
        fs::rename(&partial, &done).map_err(io_at(&done))
    }

    /// The layer's files under `unpacked/<digest>`, once: a finished directory is left alone, an unfinished one
    /// from an earlier try is started over.
    fn unpack(&self, layer: &Descriptor) -> Result<(), Error> {
        let done = self.layout.unpacked(&layer.digest);
        if done.is_dir() {
            return Ok(());
        }
        let encoding = layer.layer_encoding()?;
        let work = self.layout.unpacking(&layer.digest);
        if work.exists() {
            fs::remove_dir_all(&work).map_err(io_at(&work))?;
        }
        fs::create_dir_all(&work).map_err(io_at(&work))?;
        let mut result = self.unpack_blob(layer, encoding, &work, true);
        if matches!(&result, Err(e) if e.kind() == io::ErrorKind::PermissionDenied) {
            fs::remove_dir_all(&work).map_err(io_at(&work))?;
            fs::create_dir_all(&work).map_err(io_at(&work))?;
            result = self.unpack_blob(layer, encoding, &work, false);
        }
        if let Err(e) = result {
            let _ = fs::remove_dir_all(&work);
            return Err(Error::Unpack { digest: layer.digest.clone(), detail: e.to_string() });
        }
        fs::rename(&work, &done).map_err(io_at(&done))
    }

    fn unpack_blob(&self, layer: &Descriptor, encoding: LayerEncoding, work: &Path, owners: bool) -> io::Result<()> {
        let file = File::open(self.layout.blob(&layer.digest))?;
        match encoding {
            LayerEncoding::Gzip => unpack_tar(flate2::read::GzDecoder::new(file), work, owners),
            LayerEncoding::Plain => unpack_tar(file, work, owners),
        }
    }

    fn write_record<T: Serialize>(&self, path: &Path, record: &T) -> Result<(), Error> {
        let text = serde_json::to_vec_pretty(record).map_err(|e| Error::Record { path: path.to_owned(), detail: e.to_string() })?;
        let tmp = self.layout.in_flight(path);
        fs::write(&tmp, text).map_err(io_at(&tmp))?;
        fs::rename(&tmp, path).map_err(io_at(path))
    }

    fn read_record<T: for<'a> Deserialize<'a>>(&self, path: &Path) -> Result<Option<T>, Error> {
        let text = match fs::read(path) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::Io { path: path.to_owned(), source: e }),
        };
        serde_json::from_slice(&text).map(Some).map_err(|e| Error::Record { path: path.to_owned(), detail: e.to_string() })
    }

    fn read_records<T: for<'a> Deserialize<'a>>(&self, dir: &Path) -> Result<Vec<T>, Error> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).map_err(io_at(dir))? {
            let path = entry.map_err(io_at(dir))?.path();
            if self.layout.is_in_flight(&path) {
                continue;
            }
            if let Some(record) = self.read_record(&path)? {
                out.push(record);
            }
        }
        Ok(out)
    }
}

impl Image {
    fn from_manifest(name: &str, source: &Reference, manifest: &Manifest, platform: &Platform) -> Image {
        Image {
            name: name.to_owned(),
            source: source.to_string(),
            manifest: manifest.digest.clone(),
            platform: platform.clone(),
            chain: Chain { config: manifest.config.digest.clone(), layers: manifest.layers.iter().map(|l| l.digest.clone()).collect() },
            layer_bytes: manifest.layers.iter().map(|l| l.size).collect(),
            pulled_at: now(),
        }
    }
}

/// A layer tar onto `dst` with its modes, mtimes and xattrs, and its owners where this process may set them.
/// Owners go on before modes, since a chown clears setuid bits; the tar crate orders that. A process that may
/// not chown gets the files as its own.
fn unpack_tar(read: impl Read, dst: &Path, owners: bool) -> io::Result<()> {
    let mut archive = tar::Archive::new(read);
    archive.set_preserve_permissions(true);
    archive.set_preserve_ownerships(owners);
    archive.set_preserve_mtime(true);
    archive.set_unpack_xattrs(true);
    archive.unpack(dst)
}

/// The digest a store file or directory is named after, with or without an in-flight extension.
fn digest_of(path: &Path) -> Option<Digest> {
    let stem = path.file_stem()?.to_str()?;
    Digest::parse(&format!("sha256:{stem}")).ok()
}

fn dir_bytes(dir: &Path) -> Result<u64, Error> {
    let mut total = 0;
    for entry in fs::read_dir(dir).map_err(io_at(dir))? {
        let entry = entry.map_err(io_at(dir))?;
        let meta = entry.metadata().map_err(io_at(&entry.path()))?;
        total += if meta.is_dir() { dir_bytes(&entry.path())? } else { meta.len() };
    }
    Ok(total)
}

fn remove_if_there(path: &Path) -> Result<bool, Error> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Error::Io { path: path.to_owned(), source: e }),
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_name_becomes_one_file_name_and_slashes_do_not_nest() {
        assert_eq!(file_word("ubuntu:24.04"), "ubuntu:24.04");
        assert_eq!(file_word("ghcr.io/org/app:v2"), "ghcr.io%2Forg%2Fapp:v2");
        assert_eq!(file_word("a%2Fb"), "a%252Fb");
    }

    #[test]
    fn a_missing_record_reads_as_none_and_a_broken_one_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.image("nothing").unwrap(), None);
        assert_eq!(store.images().unwrap(), Vec::<Image>::new());
        fs::write(store.layout.image("broken"), b"{").unwrap();
        assert!(matches!(store.image("broken"), Err(Error::Record { .. })));
    }
}
