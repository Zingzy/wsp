// SPDX-License-Identifier: AGPL-3.0-only
//! The layer store under `<root>/layers`. A layer's blob lands as fetched or committed, is unpacked once and goes:
//! the unpacked tree is the one form a layer keeps on the box, since forks mount it and nothing serves the blob,
//! and a layer's bytes are what that tree's files hold. A config blob is JSON nothing unpacks and stays a blob. An
//! image is a name over a chain of layers and a config; a build is a recipe's hash over the chain it produced; a
//! snapshot is a workspace's saved layer over the chain it booted from; a template is a name over a snapshot's
//! chain. A layer is referenced while any of those names it, or a workspace the sweep is told about holds it, and
//! the sweep removes what nothing names. The shape on disk is `Layout`, and nothing outside this file reads it.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::MetadataExt;
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
    fn dirs(&self) -> [PathBuf; 5] {
        [self.blobs(), self.unpacked_all(), self.images(), self.snapshots(), self.templates()]
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
    /// Each layer's bytes as its unpacked files hold them, in the chain's order.
    pub layer_bytes: Vec<u64>,
    pub pulled_at: u64,
}

/// `snapshots/<id>.json`: a workspace's upper directory saved as one layer over the chain it booted from. The id is
/// the snapshot's own, fresh at every commit, since two commits of an unchanged workspace make one layer and must
/// stay two snapshots; `layer` is that saved layer, the last of the chain, and `layer_bytes` what its unpacked
/// files hold.
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
        let mut layer_bytes = Vec::with_capacity(manifest.layers.len());
        for layer in &manifest.layers {
            if self.unpacked(&layer.digest).is_none() {
                self.take_blob(client, source, layer)?;
            }
            layer_bytes.push(self.unpack(&layer.digest, layer.layer_encoding()?)?);
        }
        let image = Image::from_manifest(name, source, &manifest, &self.platform, layer_bytes);
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

    /// How many images, builds, snapshots and templates name the layer or config.
    pub fn references(&self, digest: &Digest) -> Result<usize, Error> {
        Ok(self.chains()?.iter().filter(|chain| chain.digests().any(|d| d == digest)).count())
    }

    /// Every chain a record names.
    fn chains(&self) -> Result<Vec<Chain>, Error> {
        let mut chains: Vec<Chain> = self.images()?.into_iter().map(|i| i.chain).collect();
        chains.extend(self.snapshots()?.into_iter().map(|s| s.chain));
        chains.extend(self.templates()?.into_iter().map(|t| t.chain));
        Ok(chains)
    }

    /// A snapshot of a workspace: the layer `commit_blob` took from it, unpacked here with the blob gone, and the
    /// record naming it over the chain the workspace booted from. `from` is what that workspace was made from. Two
    /// calls, since the workspace is held still only while its layer is read and runs again while the layer unpacks.
    pub fn record_snapshot(&self, name: &str, workspace: &str, from: &str, base: &Chain, committed: &Committed) -> Result<Snapshot, Error> {
        let layer_bytes = self.unpack(&committed.digest, LayerEncoding::Plain)?;
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
            layer: committed.digest.clone(),
            layer_bytes,
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

    /// The tar `write` produces, hashed into a blob as it is: a layer's bytes, not yet unpacked; `record_snapshot`
    /// unpacks it and drops the blob. Not compressed: gzip took five times the tar itself on a two core box, and
    /// the blob lives only until its unpack. A blob already in the store under that digest is left as it is.
    pub fn commit_blob(&self, write: impl FnOnce(&mut dyn Write) -> io::Result<()>) -> Result<Committed, Error> {
        let partial = self.layout.committing(&random_word());
        let file = File::create(&partial).map_err(io_at(&partial))?;
        let mut hashing = Hashing { inner: file, hasher: Sha256::new(), bytes: 0 };
        let committed = (|| -> io::Result<Committed> {
            write(&mut hashing)?;
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
    /// every unpack that never finished, and every blob whose layer is unpacked beside it whatever names it, since
    /// the tree is the layer's one form. `held` is what the workspaces on the box booted from, whose layers stay
    /// mounted under them whatever the records say. Not for while a pull or a commit is in flight: their partial
    /// and their unpack in progress are what it would take.
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
            let twin = digest.as_ref().is_some_and(|d| self.unpacked(d).is_some());
            if !partial && !twin && digest.as_ref().is_none_or(|d| live.contains(d)) {
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
            swept.bytes += tree_bytes(&path).map_err(io_at(&path))?;
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

    /// The layer in its one form: its files under `unpacked/<digest>` and no blob beside them. A finished directory
    /// is left alone, an unfinished one from an earlier try is started over, and the blob goes once the directory
    /// is whole. Answers the bytes the directory's files hold.
    fn unpack(&self, digest: &Digest, encoding: LayerEncoding) -> Result<u64, Error> {
        let done = self.layout.unpacked(digest);
        if !done.is_dir() {
            let work = self.layout.unpacking(digest);
            if work.exists() {
                fs::remove_dir_all(&work).map_err(io_at(&work))?;
            }
            fs::create_dir_all(&work).map_err(io_at(&work))?;
            let mut result = self.unpack_blob(digest, encoding, &work, true);
            if matches!(&result, Err(e) if e.kind() == io::ErrorKind::PermissionDenied) {
                fs::remove_dir_all(&work).map_err(io_at(&work))?;
                fs::create_dir_all(&work).map_err(io_at(&work))?;
                result = self.unpack_blob(digest, encoding, &work, false);
            }
            if let Err(e) = result {
                let _ = fs::remove_dir_all(&work);
                return Err(Error::Unpack { digest: digest.clone(), detail: e.to_string() });
            }
            fs::rename(&work, &done).map_err(io_at(&done))?;
        }
        // The layer is on disk in its one form whatever became of the blob; one that will not remove is the next
        // sweep's, so it fails no pull and no snapshot record.
        if let Err(e) = remove_if_there(&self.layout.blob(digest)) {
            eprintln!("layer {digest}: its blob stayed beside the tree, the next sweep takes it: {e}");
        }
        tree_bytes(&done).map_err(io_at(&done))
    }

    fn unpack_blob(&self, digest: &Digest, encoding: LayerEncoding, work: &Path, owners: bool) -> io::Result<()> {
        let file = File::open(self.layout.blob(digest))?;
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
    fn from_manifest(name: &str, source: &Reference, manifest: &Manifest, platform: &Platform, layer_bytes: Vec<u64>) -> Image {
        Image {
            name: name.to_owned(),
            source: source.to_string(),
            manifest: manifest.digest.clone(),
            platform: platform.clone(),
            chain: Chain { config: manifest.config.digest.clone(), layers: manifest.layers.iter().map(|l| l.digest.clone()).collect() },
            layer_bytes,
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

/// How many bytes the files under a directory hold, each inode once: an upper directory's, which is what its
/// layer's tar comes to give or take the headers, or an unpacked layer's, which is what the layer costs the box.
/// Read off the box, never off a df inside the workspace, which reads the box's whole disk. A workspace may be
/// running while its upper is read, so an entry gone between the listing and its stat is skipped, never a failure
/// of the whole count; only a directory that is not there fails.
pub fn tree_bytes(dir: &Path) -> io::Result<u64> {
    let mut seen = HashSet::new();
    let mut total = 0;
    for entry in fs::read_dir(dir)? {
        count_entry(entry?, &mut seen, &mut total)?;
    }
    Ok(total)
}

/// One entry's bytes into the total, its directory walked under it; a vanished entry or directory counts nothing.
fn count_entry(entry: fs::DirEntry, seen: &mut HashSet<(u64, u64)>, total: &mut u64) -> io::Result<()> {
    let meta = match entry.metadata() {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.is_dir() {
        let entries = match fs::read_dir(entry.path()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        for child in entries {
            count_entry(child?, seen, total)?;
        }
    } else if meta.is_file() && shared_inode(&meta).is_none_or(|key| seen.insert(key)) {
        *total += meta.len();
    }
    Ok(())
}

/// The key of a file the workspace hard linked more than once, by device and inode: the layer carries its bytes
/// once under the first name and a link under every other, and the count reads it once the same way.
pub(crate) fn shared_inode(meta: &fs::Metadata) -> Option<(u64, u64)> {
    (meta.is_file() && meta.nlink() > 1).then(|| (meta.dev(), meta.ino()))
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
    fn a_committed_blob_is_unpacked_and_recorded_by_the_snapshot_and_not_before() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let word = dir.path().join("word");
        fs::write(&word, b"hello").unwrap();
        let committed = store
            .commit_blob(|out| {
                let mut tar = tar::Builder::new(out);
                tar.append_path_with_name(&word, "etc/word")?;
                tar.finish()
            })
            .unwrap();
        assert!(store.has_blob(&committed.digest));
        assert_eq!(committed.bytes, fs::metadata(store.layout.blob(&committed.digest)).unwrap().len());
        // The blob is on disk and nothing is unpacked yet: the workspace it came from is free to run meanwhile.
        assert_eq!(store.unpacked(&committed.digest), None);
        let base = Chain { config: Digest::of(b"config"), layers: vec![Digest::of(b"base")] };
        let snapshot = store.record_snapshot("v1", "wsp-x", "ubuntu:24.04", &base, &committed).unwrap();
        assert_eq!(fs::read(store.unpacked(&committed.digest).unwrap().join("etc/word")).unwrap(), b"hello");
        assert!(!store.has_blob(&committed.digest), "the blob went with the unpack");
        assert_eq!((&snapshot.layer, snapshot.layer_bytes), (&committed.digest, 5), "the size is the tree's, not the tar's");
        assert_eq!(snapshot.chain.layers, vec![Digest::of(b"base"), committed.digest.clone()]);
        assert_eq!(store.snapshot(&snapshot.id).unwrap(), Some(snapshot));
    }

    #[test]
    fn a_blob_that_will_not_remove_fails_no_record_and_goes_at_the_next_sweep() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        if fs::metadata(dir.path()).unwrap().uid() == 0 {
            eprintln!("skipped: root removes a file whatever its directory's mode");
            return;
        }
        let store = Store::open(dir.path()).unwrap();
        let word = dir.path().join("word");
        fs::write(&word, b"hello").unwrap();
        let committed = store
            .commit_blob(|out| {
                let mut tar = tar::Builder::new(out);
                tar.append_path_with_name(&word, "etc/word")?;
                tar.finish()
            })
            .unwrap();
        // The blobs directory read only: the blob can be opened and unpacked, and cannot be removed.
        let blobs = store.layout.blobs();
        fs::set_permissions(&blobs, fs::Permissions::from_mode(0o555)).unwrap();
        let base = Chain { config: Digest::of(b"config"), layers: vec![Digest::of(b"base")] };
        let recorded = store.record_snapshot("v1", "wsp-x", "ubuntu:24.04", &base, &committed);
        fs::set_permissions(&blobs, fs::Permissions::from_mode(0o755)).unwrap();
        let snapshot = recorded.expect("the record stands though the blob stayed");
        assert_eq!(snapshot.layer_bytes, 5);
        assert!(store.unpacked(&committed.digest).is_some(), "the tree is there");
        assert!(store.has_blob(&committed.digest), "the blob stayed, since it would not remove");
        let swept = store.sweep(&[]).unwrap();
        assert_eq!((swept.blobs, swept.bytes), (vec![committed.digest.clone()], committed.bytes), "the next sweep takes the blob");
        assert!(!store.has_blob(&committed.digest) && store.unpacked(&committed.digest).is_some());
    }

    #[test]
    fn an_entry_gone_between_the_listing_and_its_read_counts_nothing_and_fails_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let upper = dir.path().join("upper");
        fs::create_dir_all(upper.join("kept")).unwrap();
        fs::write(upper.join("kept/file"), vec![1u8; 100]).unwrap();
        fs::create_dir_all(upper.join("going")).unwrap();
        fs::write(upper.join("going/file"), vec![1u8; 100]).unwrap();
        // The listing is taken with both directories there; one is removed before its entry is walked.
        let mut entries: Vec<fs::DirEntry> = fs::read_dir(&upper).unwrap().collect::<io::Result<_>>().unwrap();
        entries.sort_by_key(fs::DirEntry::file_name);
        fs::remove_dir_all(upper.join("going")).unwrap();
        let mut seen = HashSet::new();
        let mut total = 0;
        for entry in entries {
            count_entry(entry, &mut seen, &mut total).unwrap();
        }
        assert_eq!(total, 100);
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
