// SPDX-License-Identifier: AGPL-3.0-only
//! The computer's readings kept a minute apart for as long as the daemon runs: the sampler's two-second samples folded
//! into one point a minute (the mean cpu and load, the last memory and disk), appended one line each to a file a day
//! under the daemon's own folder, the oldest day dropped past READINGS_KEPT_DAYS or past READINGS_CAP_BYTES between
//! them. sys.history reads those files back, folded into the steps a chart draws. A stopped machine runs no daemon
//! and keeps nothing, so its chart has a gap where it was off.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use wsp_frames::{SysHistoryReply, SysPoint, Usage};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;

/// The samples of the minute in progress, folded into its point once a sample of a later minute arrives.
#[derive(Default)]
pub(crate) struct MinuteFold {
    minute: Option<i64>,
    cpu: f64,
    load1: f64,
    count: u32,
    last: Option<(Usage, Usage)>,
}

impl MinuteFold {
    /// Takes one sample; answers the minute before it as a point when this sample opens a new one.
    pub(crate) fn add(&mut self, at: i64, cpu: f64, load1: f64, mem: Usage, disk: Usage) -> Option<SysPoint> {
        let minute = at.div_euclid(MINUTE_MS) * MINUTE_MS;
        let done = match self.minute {
            Some(open) if open != minute && self.count > 0 => self.last.take().map(|(mem, disk)| SysPoint {
                at: open,
                cpu: self.cpu / f64::from(self.count),
                load1: self.load1 / f64::from(self.count),
                mem,
                disk,
            }),
            _ => None,
        };
        if self.minute != Some(minute) {
            self.minute = Some(minute);
            self.cpu = 0.0;
            self.load1 = 0.0;
            self.count = 0;
        }
        self.cpu += crate::sys::finite(cpu);
        self.load1 += crate::sys::finite(load1);
        self.count += 1;
        self.last = Some((mem, disk));
        done
    }
}

/// The day a file holds, as its name: the UTC calendar date of the instant, YYYY-MM-DD.
pub(crate) fn day_name(at: i64) -> String {
    // Days since 1970-01-01 as a civil date, Howard Hinnant's days-to-civil.
    let z = at.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The folder of day files, with how many days it keeps and the bytes they may come to.
pub(crate) struct History {
    dir: PathBuf,
    keep_days: u32,
    cap_bytes: u64,
    fold: Mutex<MinuteFold>,
}

impl History {
    pub(crate) fn new(dir: PathBuf, keep_days: u32, cap_bytes: u64) -> History {
        History { dir, keep_days, cap_bytes, fold: Mutex::new(MinuteFold::default()) }
    }

    /// One sample from the sampler: a finished minute is written, and the files are held to their days and cap.
    pub(crate) fn sample(&self, at: i64, cpu: f64, load1: f64, mem: Usage, disk: Usage) -> std::io::Result<()> {
        let done = self.fold.lock().unwrap_or_else(|e| e.into_inner()).add(at, cpu, load1, mem, disk);
        match done {
            Some(point) => self.append(&point, at),
            None => Ok(()),
        }
    }

    /// One point as a line of its day's file, then the oldest days dropped past the kept days or the cap.
    pub(crate) fn append(&self, point: &SysPoint, now: i64) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let line = serde_json::to_string(point).map_err(std::io::Error::other)?;
        let mut file =
            std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join(format!("{}.jsonl", day_name(point.at))))?;
        // One write per line, so a reader never meets half a point unless the daemon died mid-write.
        file.write_all(format!("{line}\n").as_bytes())?;
        let oldest = day_name(now - i64::from(self.keep_days.saturating_sub(1)) * DAY_MS);
        let mut files = day_files(&self.dir);
        for (name, path) in &files {
            if name.as_str() < oldest.as_str() {
                let _ = std::fs::remove_file(path);
            }
        }
        files.retain(|(name, _)| name.as_str() >= oldest.as_str());
        let mut bytes: u64 = files.iter().map(|(_, p)| std::fs::metadata(p).map_or(0, |m| m.len())).sum();
        // The newest day always stays: it is the one being written.
        while bytes > self.cap_bytes && files.len() > 1 {
            let (_, path) = files.remove(0);
            bytes -= std::fs::metadata(&path).map_or(0, |m| m.len());
            let _ = std::fs::remove_file(&path);
        }
        Ok(())
    }

    /// The points between two instants, folded into steps of step_ms, oldest first: the mean cpu and load of each
    /// step and its last memory and disk. At most `cap` steps; a range that holds more answers the first and says so.
    pub(crate) fn read(&self, from: i64, to: i64, step_ms: u64, cap: usize) -> SysHistoryReply {
        let step = i64::try_from(step_ms.max(1)).unwrap_or(i64::MAX);
        let (first, last) = (day_name(from), day_name(to));
        let mut steps: std::collections::BTreeMap<i64, (f64, f64, u32, Usage, Usage)> = std::collections::BTreeMap::new();
        for (name, path) in day_files(&self.dir) {
            if name < first || name > last {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            // A line cut short by a crash mid-write is skipped, not the whole day.
            for point in text.lines().filter_map(|l| serde_json::from_str::<SysPoint>(l).ok()) {
                if point.at < from || point.at >= to {
                    continue;
                }
                let at = from + (point.at - from) / step * step;
                let held = steps.entry(at).or_insert((0.0, 0.0, 0, point.mem.clone(), point.disk.clone()));
                held.0 += point.cpu;
                held.1 += point.load1;
                held.2 += 1;
                held.3 = point.mem;
                held.4 = point.disk;
            }
        }
        let truncated = steps.len() > cap;
        let points = steps
            .into_iter()
            .take(cap)
            .map(|(at, (cpu, load1, n, mem, disk))| SysPoint { at, cpu: cpu / f64::from(n), load1: load1 / f64::from(n), mem, disk })
            .collect();
        SysHistoryReply { points, step_ms, truncated }
    }
}

/// Reads the computer every `every` for as long as the daemon runs and folds what it reads into the kept minutes. A
/// read that fails is skipped, the cpu baseline kept; the first read is the baseline and keeps nothing.
pub(crate) async fn record(
    source: std::sync::Arc<dyn crate::sys::SysSource>,
    history: std::sync::Arc<History>,
    every: std::time::Duration,
) {
    let mut ticker = tokio::time::interval(crate::sys::tick_of(every));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut prev: Option<crate::sys::CpuTimes> = None;
    loop {
        ticker.tick().await;
        let from = std::sync::Arc::clone(&source);
        let Ok(Ok(read)) = tokio::task::spawn_blocking(move || from.read()).await else { continue };
        let Some(before) = prev.replace(read.cpu) else { continue };
        let cpu = crate::sys::cpu_percent(before, read.cpu);
        let kept = std::sync::Arc::clone(&history);
        let at = crate::sys::now_ms();
        let _ = tokio::task::spawn_blocking(move || kept.sample(at, cpu, read.load1, read.mem, read.disk)).await;
    }
}

/// The day files in a folder, by name, oldest first.
fn day_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let day = name.strip_suffix(".jsonl")?;
            (day.len() == 10 && day.as_bytes()[4] == b'-' && day.as_bytes()[7] == b'-').then(|| (day.to_owned(), e.path()))
        })
        .collect();
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_790_640_000_000; // 2026-09-29T00:00:00Z

    fn usage(used: u64) -> Usage {
        Usage { used, total: 100 }
    }

    fn lines(path: &Path) -> Vec<SysPoint> {
        std::fs::read_to_string(path).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn a_minute_folds_into_one_point_the_mean_of_its_cpu_and_load_and_the_last_of_its_memory_and_disk() {
        let mut fold = MinuteFold::default();
        assert_eq!(fold.add(T0 + 1_000, 10.0, 1.0, usage(5), usage(50)), None);
        assert_eq!(fold.add(T0 + 30_000, 30.0, 3.0, usage(7), usage(51)), None);
        let point = fold.add(T0 + 61_000, 90.0, 9.0, usage(9), usage(52)).unwrap();
        assert_eq!(point, SysPoint { at: T0, cpu: 20.0, load1: 2.0, mem: usage(7), disk: usage(51) });
        // A sample two minutes on closes the one it was in and says nothing of the minute with no sample.
        let next = fold.add(T0 + 181_000, 0.0, 0.0, usage(1), usage(1)).unwrap();
        assert_eq!(next.at, T0 + 60_000);
    }

    #[test]
    fn a_day_file_is_named_by_its_utc_date() {
        assert_eq!(day_name(T0), "2026-09-29");
        assert_eq!(day_name(T0 - 1), "2026-09-28");
        assert_eq!(day_name(0), "1970-01-01");
        assert_eq!(day_name(951_782_400_000), "2000-02-29");
    }

    #[test]
    fn each_point_is_one_line_of_its_days_file() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::new(dir.path().join("readings"), 14, 1 << 20);
        for minute in 0..3 {
            history.sample(T0 + minute * MINUTE_MS + 5_000, 50.0, 0.5, usage(3), usage(4)).unwrap();
        }
        history.sample(T0 + DAY_MS + 5_000, 50.0, 0.5, usage(3), usage(4)).unwrap();
        let today = lines(&dir.path().join("readings/2026-09-29.jsonl"));
        assert_eq!(today.iter().map(|p| p.at).collect::<Vec<_>>(), [T0, T0 + MINUTE_MS, T0 + 2 * MINUTE_MS]);
    }

    #[test]
    fn keeps_fourteen_days_and_drops_the_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::new(dir.path().to_path_buf(), 14, 1 << 30);
        for day in 0..16 {
            let at = T0 + day * DAY_MS;
            history.append(&SysPoint { at, cpu: 1.0, load1: 0.1, mem: usage(1), disk: usage(1) }, at).unwrap();
        }
        let names: Vec<String> = day_files(dir.path()).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names.len(), 14);
        assert_eq!(names.first().unwrap(), "2026-10-01");
        assert_eq!(names.last().unwrap(), "2026-10-14");
    }

    #[test]
    fn holds_the_files_under_their_cap_on_disk_the_oldest_day_first() {
        let dir = tempfile::tempdir().unwrap();
        // One point line is about 90 bytes, so a cap of 400 holds four days of one point each.
        let history = History::new(dir.path().to_path_buf(), 14, 400);
        for day in 0..6 {
            let at = T0 + day * DAY_MS;
            history.append(&SysPoint { at, cpu: 1.0, load1: 0.1, mem: usage(1), disk: usage(1) }, at).unwrap();
        }
        let files = day_files(dir.path());
        let bytes: u64 = files.iter().map(|(_, p)| std::fs::metadata(p).unwrap().len()).sum();
        assert!(bytes <= 400, "{bytes}");
        assert_eq!(files.last().unwrap().0, "2026-10-04", "the newest day is kept");
        assert!(files.len() < 6);
    }

    #[test]
    fn reads_a_range_back_folded_into_its_steps_and_an_empty_range_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::new(dir.path().to_path_buf(), 14, 1 << 20);
        for minute in 0..10 {
            let at = T0 + minute * MINUTE_MS;
            history.append(&SysPoint { at, cpu: minute as f64 * 10.0, load1: 1.0, mem: usage(minute as u64), disk: usage(9) }, at).unwrap();
        }
        let five = history.read(T0, T0 + 10 * MINUTE_MS, 5 * MINUTE_MS as u64, 100);
        assert_eq!(five.step_ms, 300_000);
        assert!(!five.truncated);
        assert_eq!(
            five.points,
            [
                SysPoint { at: T0, cpu: 20.0, load1: 1.0, mem: usage(4), disk: usage(9) },
                SysPoint { at: T0 + 5 * MINUTE_MS, cpu: 70.0, load1: 1.0, mem: usage(9), disk: usage(9) }
            ]
        );
        // A step wider than the whole range is one point; a step past the cap answers the first and says so.
        assert_eq!(history.read(T0, T0 + 10 * MINUTE_MS, 3_600_000, 100).points.len(), 1);
        let cut = history.read(T0, T0 + 10 * MINUTE_MS, MINUTE_MS as u64, 3);
        assert_eq!((cut.points.len(), cut.truncated), (3, true));
        assert!(history.read(T0 + DAY_MS, T0 + 2 * DAY_MS, 300_000, 100).points.is_empty());
        // The range reads across the day files it spans, and nothing outside it.
        history.append(&SysPoint { at: T0 + DAY_MS, cpu: 5.0, load1: 1.0, mem: usage(1), disk: usage(1) }, T0 + DAY_MS).unwrap();
        assert_eq!(history.read(T0 + 5 * MINUTE_MS, T0 + DAY_MS + 1, 3_600_000, 100).points.len(), 2);
    }
}
