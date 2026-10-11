// SPDX-License-Identifier: AGPL-3.0-only
//! This computer's own utilisation, the metrics module of the local kind: cpu, load, memory and the disk the folder
//! turns write in is on, from the road the platform answers honestly on, one module per system below. On Linux that
//! is the host's own /proc and one df; on a Mac the mach counters, getloadavg and statfs, with nothing spawned, since
//! the readings kept for the Machine tab sample every fifteen seconds whether or not anyone looks.

use std::path::{Path, PathBuf};
use std::process::Command;

use wsp_frames::Usage;

use crate::pty::work_argv;
use crate::sys::{CpuTimes, SysReadings, SysSource};

/// df's numbers are in 1024-byte blocks under -k.
#[cfg_attr(target_os = "macos", cfg(test))]
const BLOCK: u64 = 1024;

/// One of this computer's small readers, in the C locale: df, ps and lsof print numbers and column headers the parsers
/// here read, and a login's own locale moves them. Run behind the work-score line like every child of the daemon, so a
/// slow ps is what the kernel takes first, never the daemon.
pub(crate) fn host_command(file: &str, args: &[&str]) -> Command {
    let (sh, argv) = work_argv(file, args);
    let mut command = Command::new(sh);
    command.args(argv).env("LC_ALL", "C").stdin(std::process::Stdio::null());
    command
}

/// The three counts and the capacity df -kP prints for one filesystem: blocks, used, available, then a percentage.
/// Read from the percentage backwards, since a device name or a mount point may hold spaces and the numbers may not.
#[cfg_attr(target_os = "macos", cfg(test))]
pub(crate) fn parse_df(text: &str) -> Result<Usage, String> {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    for i in 3..tokens.len() {
        let percent = tokens[i].strip_suffix('%').is_some_and(digits);
        if percent && digits(tokens[i - 1]) && digits(tokens[i - 2]) && digits(tokens[i - 3]) {
            let total: u64 = tokens[i - 3].parse().map_err(|_| "df printed no filesystem line".to_owned())?;
            let used: u64 = tokens[i - 2].parse().map_err(|_| "df printed no filesystem line".to_owned())?;
            return Ok(Usage { used: used * BLOCK, total: total * BLOCK });
        }
    }
    Err("df printed no filesystem line".to_owned())
}

/// The four readings of this computer that the platform answers differently: cpu counters, the one-minute load,
/// memory, and the disk a folder is on. Adding a platform is a row in host_machine and its module.
pub(crate) trait HostMachine: Send + Sync {
    fn cpu(&self) -> Result<CpuTimes, String>;
    fn load1(&self) -> Result<f64, String>;
    fn memory(&self) -> Result<Usage, String>;
    fn disk(&self, folder: &Path) -> Result<Usage, String>;
}

/// The Linux host reads its own /proc, which is what the guest's road reads too; the two modules differ only in
/// the disk, which here is the volume the work folder is on.
#[cfg(not(target_os = "macos"))]
pub(crate) struct LinuxHost;

#[cfg(not(target_os = "macos"))]
impl HostMachine for LinuxHost {
    fn cpu(&self) -> Result<CpuTimes, String> {
        crate::sys::parse_proc_stat(&crate::sys::read_named(Path::new("/proc/stat"))?)
    }

    fn load1(&self) -> Result<f64, String> {
        crate::sys::parse_loadavg(&crate::sys::read_named(Path::new("/proc/loadavg"))?)
    }

    fn memory(&self) -> Result<Usage, String> {
        let (total, available) = crate::sys::parse_meminfo(&crate::sys::read_named(Path::new("/proc/meminfo"))?)?;
        Ok(Usage { used: total.saturating_sub(available), total })
    }

    fn disk(&self, folder: &Path) -> Result<Usage, String> {
        let df = host_command("df", &["-kP", &folder.to_string_lossy()]).output().map_err(|e| format!("df: {e}"))?;
        parse_df(&String::from_utf8_lossy(&df.stdout))
    }
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::*;

    pub(crate) struct DarwinHost;

    impl HostMachine for DarwinHost {
        fn cpu(&self) -> Result<CpuTimes, String> {
            let mut info = libc::host_cpu_load_info { cpu_ticks: [0; libc::CPU_STATE_MAX as usize] };
            let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
            // The libc crate points mach_host_self at mach2, which carries no host statistics; this is the one road
            // to the aggregate cpu counters on a Mac.
            #[allow(deprecated)]
            // SAFETY: mach writes at most `count` words into `info`, which is the struct that flavour names.
            let rc = unsafe {
                libc::host_statistics64(
                    libc::mach_host_self(),
                    libc::HOST_CPU_LOAD_INFO,
                    (&mut info as *mut libc::host_cpu_load_info).cast(),
                    &mut count,
                )
            };
            if rc != libc::KERN_SUCCESS {
                return Err(format!("host_statistics64 failed with {rc}"));
            }
            let ticks = info.cpu_ticks;
            Ok(CpuTimes { idle: f64::from(ticks[libc::CPU_STATE_IDLE as usize]), total: ticks.iter().map(|t| f64::from(*t)).sum() })
        }

        fn load1(&self) -> Result<f64, String> {
            let mut loads = [0f64; 3];
            // SAFETY: getloadavg writes up to three doubles into the array it is handed; nix has no wrapper for it.
            let n = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
            if n < 1 {
                return Err("getloadavg answered nothing".to_owned());
            }
            Ok(loads[0])
        }

        fn memory(&self) -> Result<Usage, String> {
            let mut total: u64 = 0;
            let mut len = std::mem::size_of::<u64>();
            // SAFETY: hw.memsize is a 64-bit integer and the length handed in is its size; nix has no sysctl on apple.
            let rc =
                unsafe { libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut total as *mut u64).cast(), &mut len, std::ptr::null_mut(), 0) };
            if rc != 0 {
                return Err("sysctl hw.memsize failed".to_owned());
            }
            let mut info = std::mem::MaybeUninit::<libc::vm_statistics64>::zeroed();
            let mut count = libc::HOST_VM_INFO64_COUNT;
            #[allow(deprecated)]
            // SAFETY: mach writes at most `count` words into `info`, which is the struct that flavour names.
            let rc = unsafe { libc::host_statistics64(libc::mach_host_self(), libc::HOST_VM_INFO64, info.as_mut_ptr().cast(), &mut count) };
            if rc != libc::KERN_SUCCESS {
                return Err(format!("host_statistics64 failed with {rc}"));
            }
            // SAFETY: the call succeeded, and a flavour the kernel filled short leaves the rest zeroed.
            let info = unsafe { info.assume_init() };
            // SAFETY: the kernel's page size, set before main runs and never written again.
            let page = unsafe { vm_kernel_page_size } as u64;
            Ok(Usage { used: total.saturating_sub(available_pages(&info) * page), total })
        }

        /// The two numbers df -kP prints for the folder's volume: its size off statfs, and what the volume itself
        /// holds. An APFS volume shares its container's free space with the system's own volumes, so the size less
        /// the free space counts them too; df asks the volume for its own, and so does this, falling back to the
        /// size less the free space on a volume that cannot say.
        fn disk(&self, folder: &Path) -> Result<Usage, String> {
            let path =
                std::ffi::CString::new(folder.as_os_str().as_encoded_bytes()).map_err(|e| format!("statfs {}: {e}", folder.display()))?;
            let mut fs = std::mem::MaybeUninit::<libc::statfs>::zeroed();
            // SAFETY: statfs writes one struct of the type it is handed, and the path is a NUL-terminated string.
            if unsafe { libc::statfs(path.as_ptr(), fs.as_mut_ptr()) } != 0 {
                return Err(format!("statfs {}: {}", folder.display(), std::io::Error::last_os_error()));
            }
            // SAFETY: the call succeeded and filled it.
            let fs = unsafe { fs.assume_init() };
            let block = u64::from(fs.f_bsize);
            let used = volume_used(&fs.f_mntonname).unwrap_or(fs.f_blocks.saturating_sub(fs.f_bfree) * block);
            Ok(Usage { used, total: fs.f_blocks * block })
        }
    }

    extern "C" {
        /// The page the kernel's counts are in. vm_page_size is the process's own, which Rosetta makes 4 KB while the
        /// kernel counts 16 KB pages, and an Intel build on Apple silicon counted a quarter of the free memory.
        static vm_kernel_page_size: libc::vm_size_t;
    }

    /// The space a mounted volume itself holds, as getattrlist's ATTR_VOL_SPACEUSED answers it for its mount point.
    fn volume_used(mount: &[libc::c_char]) -> Option<u64> {
        /// The reply: its own length, then the one attribute asked for, packed on four bytes.
        #[repr(C, packed(4))]
        struct Reply {
            length: u32,
            used: libc::off_t,
        }
        let mut asked = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: 0,
            volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_SPACEUSED,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        let mut reply = Reply { length: 0, used: 0 };
        // SAFETY: the mount point is statfs's NUL-terminated name, and the reply buffer is as long as the size given.
        let rc = unsafe {
            libc::getattrlist(
                mount.as_ptr(),
                (&mut asked as *mut libc::attrlist).cast(),
                (&mut reply as *mut Reply).cast(),
                size_of::<Reply>(),
                0,
            )
        };
        let (length, used) = (reply.length, reply.used);
        (rc == 0 && length as usize >= size_of::<Reply>() && used >= 0).then_some(used as u64)
    }

    /// What a Mac can hand out without taking it from something running: pages that are free, pages read ahead on
    /// speculation, and the inactive list, which the kernel reclaims without asking. The free count already holds the
    /// speculative pages (vm_stat prints its free line as the free count less them), so they are not added again, and
    /// neither are purgeable pages, which sit inside those lists. This is the reading MemAvailable is on Linux; the
    /// kernel's free count alone reads a Mac at rest as nearly full, because it holds everything else for reuse.
    pub(crate) fn available_pages(info: &libc::vm_statistics64) -> u64 {
        u64::from(info.free_count) + u64::from(info.inactive_count)
    }
}

/// The machine this daemon was built for.
#[cfg(target_os = "macos")]
pub(crate) fn host_machine() -> Box<dyn HostMachine> {
    Box::new(darwin::DarwinHost)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn host_machine() -> Box<dyn HostMachine> {
    Box::new(LinuxHost)
}

/// This computer as its own workspace reads it. The disk is the volume the work folder is on, which is where turns
/// write; the person's home may be another.
pub(crate) struct HostSysSource {
    work_folder: PathBuf,
    machine: Box<dyn HostMachine>,
}

impl HostSysSource {
    pub(crate) fn new(work_folder: PathBuf) -> HostSysSource {
        HostSysSource { work_folder, machine: host_machine() }
    }
}

impl SysSource for HostSysSource {
    fn read(&self) -> Result<SysReadings, String> {
        Ok(SysReadings {
            cpu: self.machine.cpu()?,
            load1: self.machine.load1()?,
            mem: self.machine.memory()?,
            disk: self.machine.disk(&self.work_folder)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX_DF: &str =
        "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/root         20554452 13269800   6387484      68% /\n";
    const MAC_DF: &str =
        "Filesystem  1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1s1    971350180  22461104 105442184    18%    /\n";
    /// A volume mounted under a name with a space in it, which is a Mac's normal state (Macintosh HD).
    const SPACED_DF: &str =
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk4s2   1000000  400000    600000      40% /Volumes/Big Disk\n";
    #[test]
    fn reads_dfs_counts_off_the_capacity_column_whatever_the_device_or_the_mount_point_is_called() {
        assert_eq!(parse_df(LINUX_DF).unwrap(), Usage { used: 13_269_800 * 1024, total: 20_554_452 * 1024 });
        assert_eq!(parse_df(MAC_DF).unwrap(), Usage { used: 22_461_104 * 1024, total: 971_350_180 * 1024 });
        assert_eq!(parse_df(SPACED_DF).unwrap(), Usage { used: 400_000 * 1024, total: 1_000_000 * 1024 });
        assert_eq!(parse_df("df: /nope: No such file or directory\n").unwrap_err(), "df printed no filesystem line");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn counts_a_macs_reclaimable_pages_as_free_so_its_memory_row_reads_what_is_in_use_and_not_what_is_untouched() {
        // SAFETY: the struct is plain integers, all of them valid at zero.
        let mut info: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
        (info.free_count, info.speculative_count, info.inactive_count) = (98_304, 32_768, 262_144);
        (info.active_count, info.wire_count, info.purgeable_count) = (393_216, 196_608, 16_384);
        // The free count already holds the speculative pages, which vm_stat prints apart by taking them off it, so the
        // free count plus the inactive list is vm_stat's free, speculative and inactive lines added up. Purgeable pages
        // are inside those lists too and are not added again.
        assert_eq!(darwin::available_pages(&info), 98_304 + 262_144);
    }

    /// The pages vm_stat counts under one label.
    #[cfg(target_os = "macos")]
    fn vm_stat_pages(text: &str, label: &str) -> u64 {
        let prefix = format!("Pages {label}:");
        text.lines().find_map(|l| l.strip_prefix(prefix.as_str())).unwrap().trim().trim_end_matches('.').parse().unwrap()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_macs_memory_and_disk_are_what_vm_stat_and_df_print_without_running_either() {
        let page_line =
            |text: &str| -> u64 { text.split_once("page size of ").unwrap().1.split_whitespace().next().unwrap().parse().unwrap() };
        // Read on either side of vm_stat, so its figure falls between the two give or take what moves in a moment; a
        // speculative page counted twice reads more than a hundred megabytes off, past the window. The kernel rate-limits
        // host_statistics64 for programs Apple did not ship and answers a busy machine's with its last figure, while
        // vm_stat is exempt and reads fresh, so a try can compare a stale read with a new one: up to three tries a
        // second apart, and a double count misses every one.
        const WINDOW: i64 = 32 * 1024 * 1024;
        let mut tries = Vec::new();
        for _ in 0..3 {
            let before = darwin::DarwinHost.memory().unwrap();
            let vm_stat = String::from_utf8(Command::new("vm_stat").output().unwrap().stdout).unwrap();
            let after = darwin::DarwinHost.memory().unwrap();
            let available =
                (vm_stat_pages(&vm_stat, "free") + vm_stat_pages(&vm_stat, "speculative") + vm_stat_pages(&vm_stat, "inactive"))
                    * page_line(&vm_stat);
            let printed = before.total.saturating_sub(available) as i64;
            let (low, high) = (before.used.min(after.used) as i64, before.used.max(after.used) as i64);
            if printed >= low - WINDOW && printed <= high + WINDOW {
                break;
            }
            tries.push(format!("vm_stat says {printed} used, this read {low} to {high}"));
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        assert!(tries.len() < 3, "{tries:?}");
        let folder = std::env::current_dir().unwrap();
        let df = String::from_utf8(Command::new("df").args(["-kP"]).arg(&folder).output().unwrap().stdout).unwrap();
        let (printed, disk) = (parse_df(&df).unwrap(), darwin::DarwinHost.disk(&folder).unwrap());
        assert_eq!(disk.total, printed.total);
        // Files come and go between the two reads; the system's own volumes the container also holds are tens of GB.
        assert!((disk.used as i64 - printed.used as i64).abs() < 256 * 1024 * 1024, "{disk:?} {printed:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn asks_this_platform_for_memory_the_way_it_answers_honestly_the_hosts_own_meminfo_on_linux() {
        // Memory moves between two reads, so the two agree to within a window rather than exactly.
        let read = LinuxHost.memory().unwrap();
        let (total, available) = crate::sys::parse_meminfo(&std::fs::read_to_string("/proc/meminfo").unwrap()).unwrap();
        assert_eq!(read.total, total);
        assert!((read.used as i64 - (total - available) as i64).abs() < 64 * 1024 * 1024);
    }

    #[test]
    fn reads_this_computer_itself_the_memory_of_its_own_platform_the_disk_of_the_folder_it_is_given_a_load() {
        let reading = HostSysSource::new(std::env::current_dir().unwrap()).read().unwrap();
        assert!(reading.mem.total > 0);
        assert!(reading.mem.used > 0);
        assert!(reading.mem.used < reading.mem.total);
        assert!(reading.disk.total > 0);
        assert!(reading.disk.used <= reading.disk.total);
        assert!(reading.load1 >= 0.0);
        assert!(reading.cpu.total > reading.cpu.idle);
        let again = HostSysSource::new(std::env::current_dir().unwrap()).read().unwrap();
        assert!(again.cpu.total >= reading.cpu.total);
    }

    #[test]
    fn a_folder_that_is_not_there_is_refused_in_the_words_of_what_read_it() {
        let err = HostSysSource::new(PathBuf::from("/no/such/folder/anywhere")).read().unwrap_err();
        if cfg!(target_os = "macos") {
            assert!(err.starts_with("statfs /no/such/folder/anywhere: "), "{err}");
        } else {
            assert_eq!(err, "df printed no filesystem line");
        }
    }
}
