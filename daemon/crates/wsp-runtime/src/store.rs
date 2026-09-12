// SPDX-License-Identifier: AGPL-3.0-only
//! The layer store under `<root>/layers`. Blobs land as fetched or committed and are unpacked once; an image is a
//! name over a chain of layers and a config; a build is a recipe's hash over the chain it produced; a snapshot is
//! a workspace's saved layer over the chain it booted from; a template is a name over a snapshot's chain. A layer
//! is referenced while any of those names it, or a workspace the sweep is told about holds it, and the sweep
//! removes what nothing names. The shape on disk is `Layout`, and nothing outside this file reads it.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

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
    fn snapshots(&self) -> PathBuf {
        self.root.join("snapshots")
    }
    fn snapshot(&self, id: &Digest) -> PathBuf {
        self.snapshots().join(format!("{}.json", id.hex()))
    }
    fn templates(&self) -> PathBuf {
        self.root.join("templates")
    }
    fn template(&self, id: &str) -> PathBuf {
        self.templates().join(format!("{}.json", file_word(id)))
    }
    /// A layer being committed, before its digest is known.
    fn committing(&self, token: &str) -> PathBuf {
        self.blobs().join(format!("commit-{token}")).with_extension(Layout::PARTIAL)
    }
    fn dirs(&self) -> [PathBuf; 6] {
        [self.blobs(), self.unpacked_all(), self.images(), self.builds(), self.snapshots(), self.templates()]
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

/// `snapshots/<id>.json`: a workspace's upper directory saved as one layer over the chain it booted from. The id is
/// the snapshot's own, fresh at every commit, since two commits of an unchanged workspace make one layer and must
/// stay two snapshots; `layer` is that saved layer, the last of the chain, and `layer_bytes` its blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: Digest,
    pub name: String,
    /// The workspace it was taken from, and what that workspace booted from: an image, a template or a snapshot.
    pub workspace: String,
    pub from: String,
    #[serde(flatten)]
    pub chain: Chain,
    pub layer: Digest,
    pub layer_bytes: u64,
    pub created_at: String,
}

/// `templates/<id>.json`: a name over a snapshot's chain, which a fork boots from as it boots from an image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub snapshot: Digest,
    #[serde(flatten)]
    pub chain: Chain,
    pub created_at: String,
}

/// A layer the store took from a commit: its digest and its blob's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    pub digest: Digest,
    pub bytes: u64,
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

    /// How many images, builds, snapshots and templates name the layer or config.
    pub fn references(&self, digest: &Digest) -> Result<usize, Error> {
        Ok(self.chains()?.iter().filter(|chain| chain.digests().any(|d| d == digest)).count())
    }

    /// Every chain a record names.
    fn chains(&self) -> Result<Vec<Chain>, Error> {
        let mut chains: Vec<Chain> = self.images()?.into_iter().map(|i| i.chain).collect();
        chains.extend(self.read_records::<Build>(&self.layout.builds())?.into_iter().map(|b| b.chain));
        chains.extend(self.snapshots()?.into_iter().map(|s| s.chain));
        chains.extend(self.templates()?.into_iter().map(|t| t.chain));
        Ok(chains)
    }

    /// A snapshot of a workspace: the layer `write` produces as a tar, committed, and the record naming it over the
    /// chain the workspace booted from. `from` is what that workspace was made from.
    pub fn record_snapshot(
        &self,
        name: &str,
        workspace: &str,
        from: &str,
        base: &Chain,
        write: impl FnOnce(&mut dyn Write) -> io::Result<()>,
    ) -> Result<Snapshot, Error> {
        let committed = self.commit_layer(write)?;
        let created_at = now_iso();
        let mut layers = base.layers.clone();
        layers.push(committed.digest.clone());
        let id = Digest::of(format!("{}\n{name}\n{workspace}\n{created_at}\n{}", committed.digest, random_word()).as_bytes());
        let snapshot = Snapshot {
            id,
            name: name.to_owned(),
            workspace: workspace.to_owned(),
            from: from.to_owned(),
            chain: Chain { config: base.config.clone(), layers },
            layer: committed.digest,
            layer_bytes: committed.bytes,
            created_at,
        };
        self.write_record(&self.layout.snapshot(&snapshot.id), &snapshot)?;
        Ok(snapshot)
    }

    pub fn snapshot(&self, id: &Digest) -> Result<Option<Snapshot>, Error> {
        self.read_record(&self.layout.snapshot(id))
    }

    /// Every snapshot, oldest first.
    pub fn snapshots(&self) -> Result<Vec<Snapshot>, Error> {
        let mut rows: Vec<Snapshot> = self.read_records(&self.layout.snapshots())?;
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        Ok(rows)
    }

    /// Drops the snapshot; its layer stays until the sweep finds nothing else names it.
    pub fn remove_snapshot(&self, id: &Digest) -> Result<bool, Error> {
        remove_if_there(&self.layout.snapshot(id))
    }

    /// A template: the snapshot's chain under a name of its own.
    pub fn record_template(&self, id: &str, name: &str, snapshot: &Snapshot) -> Result<Template, Error> {
        let template = Template {
            id: id.to_owned(),
            name: name.to_owned(),
            snapshot: snapshot.id.clone(),
            chain: snapshot.chain.clone(),
            created_at: now_iso(),
        };
        self.write_record(&self.layout.template(id), &template)?;
        Ok(template)
    }

    pub fn template(&self, id: &str) -> Result<Option<Template>, Error> {
        self.read_record(&self.layout.template(id))
    }

    pub fn templates(&self) -> Result<Vec<Template>, Error> {
        let mut rows: Vec<Template> = self.read_records(&self.layout.templates())?;
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        Ok(rows)
    }

    pub fn remove_template(&self, id: &str) -> Result<bool, Error> {
        remove_if_there(&self.layout.template(id))
    }

    /// The chain a name resolves to here: an image by its name, a template by its id, or a snapshot by its id.
    pub fn chain_of(&self, name: &str) -> Result<Option<Chain>, Error> {
        if let Some(image) = self.image(name)? {
            return Ok(Some(image.chain));
        }
        if let Some(template) = self.template(name)? {
            return Ok(Some(template.chain));
        }
        if let Ok(id) = Digest::parse(name) {
            if let Some(snapshot) = self.snapshot(&id)? {
                return Ok(Some(snapshot.chain));
            }
        }
        Ok(None)
    }

    /// The tar `write` produces, gzipped and hashed into a blob and unpacked beside it: one layer, as a fetched one
    /// lands. A layer already in the store under that digest is left as it is.
    pub fn commit_layer(&self, write: impl FnOnce(&mut dyn Write) -> io::Result<()>) -> Result<Committed, Error> {
        let partial = self.layout.committing(&random_word());
        let file = File::create(&partial).map_err(io_at(&partial))?;
        let mut hashing = Hashing { inner: file, hasher: Sha256::new(), bytes: 0 };
        let committed = (|| -> io::Result<Committed> {
            let mut gz = flate2::write::GzEncoder::new(&mut hashing, flate2::Compression::default());
            write(&mut gz)?;
            gz.finish()?;
            hashing.inner.sync_all()?;
            Ok(Committed { digest: Digest::from_hash(hashing.hasher.finalize_reset().as_slice()), bytes: hashing.bytes })
        })();
        let committed = match committed {
            Ok(committed) => committed,
            Err(e) => {
                let _ = fs::remove_file(&partial);
                return Err(Error::Io { path: partial, source: e });
            }
        };
        let done = self.layout.blob(&committed.digest);
        if done.is_file() {
            fs::remove_file(&partial).map_err(io_at(&partial))?;
        } else {
            fs::rename(&partial, &done).map_err(io_at(&done))?;
        }
        self.unpack(&Descriptor { digest: committed.digest.clone(), size: committed.bytes, media_type: fetch::LAYER_GZIP.to_owned() })?;
        Ok(committed)
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

    /// Removes every blob and unpacked layer no record names and no chain in `held` carries, every partial blob,
    /// and every unpack that never finished. `held` is what the workspaces on the box booted from, whose layers
    /// stay mounted under them whatever the records say. Not for while a pull or a commit is in flight: their
    /// partial and their unpack in progress are what it would take.
    pub fn sweep(&self, held: &[Chain]) -> Result<Swept, Error> {
        let mut live: HashSet<Digest> = HashSet::new();
        for chain in self.chains()?.iter().chain(held) {
            live.extend(chain.digests().cloned());
        }
        let mut swept = Swept::default();
        let blobs = self.layout.blobs();
        for entry in fs::read_dir(&blobs).map_err(io_at(&blobs))? {
            let entry = entry.map_err(io_at(&blobs))?;
            let path = entry.path();
            let partial = self.layout.is_partial(&path);
            let digest = digest_of(&path);
            if !partial && digest.as_ref().is_none_or(|d| live.contains(d)) {
                continue;
            }
            swept.bytes += entry.metadata().map_err(io_at(&path))?.len();
            fs::remove_file(&path).map_err(io_at(&path))?;
            match (partial, digest) {
                (true, Some(digest)) => swept.partials.push(digest),
                (false, Some(digest)) => swept.blobs.push(digest),
                (_, None) => {}
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
    archive.unpack(dst)?;
    #[cfg(target_os = "linux")]
    if nix::unistd::geteuid().is_root() {
        convert_whiteouts(dst)?;
    }
    Ok(())
}

/// OCI whiteouts as overlayfs reads them: `.wh.<name>` becomes a character device 0:0 named `<name>`, and
/// `.wh..wh..opq` marks its directory opaque. Both take root, so a process without it keeps the files as the tar
/// carried them, which shows deleted files until a root unpack.
#[cfg(target_os = "linux")]
fn convert_whiteouts(dir: &Path) -> io::Result<()> {
    use nix::sys::stat::{makedev, mknod, Mode, SFlag};

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else { continue };
        if entry.file_type()?.is_dir() {
            convert_whiteouts(&path)?;
        } else if name == ".wh..wh..opq" {
            fs::remove_file(&path)?;
            xattr::set(dir, "trusted.overlay.opaque", b"y")?;
        } else if let Some(hidden) = name.strip_prefix(".wh.") {
            fs::remove_file(&path)?;
            mknod(&dir.join(hidden), SFlag::S_IFCHR, Mode::empty(), makedev(0, 0))?;
        }
    }
    Ok(())
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

/// The moment as the wire carries it, ISO 8601 in UTC to the millisecond.
pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Sixteen hex digits nothing else on the box is writing under: a workspace id, a commit's in-flight name, a
/// snapshot's salt.
pub(crate) fn random_word() -> String {
    let mut bytes = [0u8; 8];
    let read = File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
    if read.is_err() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        bytes.copy_from_slice(&(nanos as u64 ^ u64::from(std::process::id())).to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A writer that hashes and counts what passes through it on the way to the file.
struct Hashing {
    inner: File,
    hasher: Sha256,
    bytes: u64,
}

impl Write for Hashing {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
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
