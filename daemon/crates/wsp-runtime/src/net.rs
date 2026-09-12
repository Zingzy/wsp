// SPDX-License-Identifier: AGPL-3.0-only
//! A workspace's network, as root: a veth pair whose box end is `wsp-<k>` and whose other end is `eth0` inside
//! the namespace youki made, one /30 out of one private range per box, NAT for what leaves the box, the box's own
//! resolvers handed in, and `host.wsp.internal` naming the veth gateway. Published ports are this daemon's own
//! listeners on the box's loopback, each dialing the workspace's address. Everything is the kernel's rtnetlink and
//! nf_tables spoken from here; no ip, iptables or nft binary runs.
//!
//! What a workspace reaches: its box at `host.wsp.internal`, and the world through the interface of the box's
//! default route and the NAT. Not the box's cloud metadata, not the box's other interfaces or what lies behind
//! them, not another workspace. The rules, as `nft list ruleset` shows them on a box whose default route is eth0:
//!
//! ```text
//! table ip wsp {
//!     chain forward { type filter hook forward priority -10; policy accept;
//!         iifname "wsp-*" ip daddr 169.254.0.0/16 drop            the box's cloud metadata is the box's
//!         iifname "wsp-*" oifname != "eth0" drop                   the world through the default route alone
//!         oifname "wsp-*" ct state established,related accept   answers come back in
//!         oifname "wsp-*" drop                                  nothing else reaches a workspace, its neighbours included
//!         iifname "eth0" oifname != "wsp-*" drop                 only where this daemon turned eth0's forwarding on
//!     }
//!     chain input { type filter hook input priority -10; policy accept;
//!         iifname "wsp-*" ip daddr != 10.65.0.0/16 drop         a workspace reaches its box at host.wsp.internal alone
//!     }
//!     chain postrouting { type nat hook postrouting priority srcnat; policy accept;
//!         ip saddr 10.65.0.0/16 oifname != "wsp-*" masquerade
//!     }
//! }
//! ```
//!
//! Forwarding is turned on per interface, never for the box as a whole: on each `wsp-<k>` for what a workspace
//! sends, and on the default route's interface for the answers that come back, which is where the last rule above
//! comes from, so a box that forwarded nothing before forwards nothing between its other interfaces after.
//!
//! A box whose own firewall ends its input or forward chain in a refusal (ufw's policy drop, firewalld's final
//! reject) refuses the workspaces' packets there too, since an accept in one chain does not carry to the next; so
//! each such chain gets accepts for the workspace interfaces at its head, marked with a comment, as Docker puts its
//! jump at the head of FORWARD: on input `iifname "wsp-*" ip daddr 10.65.0.0/16 accept`, on forward `iifname
//! "wsp-*" accept` and `oifname "wsp-*" accept`. They go with the last workspace.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::os::fd::AsRawFd;
use std::path::Path;

use netlink_packet_core::{NetlinkMessage, NetlinkPayload, NLM_F_ACK, NLM_F_CREATE, NLM_F_DUMP, NLM_F_EXCL, NLM_F_REQUEST};
use netlink_packet_route::address::{AddressAttribute, AddressMessage};
use netlink_packet_route::link::{InfoData, InfoKind, InfoVeth, LinkAttribute, LinkFlags, LinkInfo, LinkMessage};
use netlink_packet_route::route::{RouteAddress, RouteAttribute, RouteHeader, RouteMessage, RouteProtocol, RouteScope, RouteType};
use netlink_packet_route::{AddressFamily, RouteNetlinkMessage};
use netlink_sys::protocols::NETLINK_ROUTE;
use netlink_sys::{Socket, SocketAddr};
use nix::sched::{setns, CloneFlags};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::bundle::{self, Layout};
use crate::nft::{self, BaseChain, Conn, Expr};

/// The one private range every workspace on a box draws from.
pub const RANGE: Ipv4Addr = Ipv4Addr::new(10, 65, 0, 0);
pub const RANGE_PREFIX: u8 = 16;
/// Each workspace gets a /30: the network, the gateway on the box, the workspace, broadcast.
const BLOCK_PREFIX: u8 = 30;
const FIRST_INDEX: u16 = 1;
const LAST_INDEX: u16 = 16382;
/// The box end of every pair, which is also what the rules match on.
pub const LINK_PREFIX: &str = "wsp-";
/// What a workspace calls its own end.
pub const INSIDE_LINK: &str = "eth0";
/// The name a turn inside dials the box at.
pub const HOST_NAME: &str = "host.wsp.internal";
pub const TABLE: &str = "wsp";
/// The comment on every rule this daemon writes into a chain that is not its own, which is how it finds them again.
pub const RULE_COMMENT: &str = "wsp workspaces";
/// The pair the self check makes and removes, named outside the prefix so no sweep takes it for a workspace's.
const CHECK_LINK: &str = "wspcheck0";
const CHECK_PEER: &str = "wspcheck1";
/// The cloud metadata services live here (169.254.169.254 on every provider), and the range is link local: nothing
/// a workspace has business with.
pub const METADATA_RANGE: Ipv4Addr = Ipv4Addr::new(169, 254, 0, 0);
pub const METADATA_PREFIX: u8 = 16;
/// The comment on the guard rule, naming the interface whose forwarding this daemon turned on, so the teardown
/// turns it back off.
const FORWARDING_COMMENT: &str = "wsp workspaces: forwarding turned on for ";
/// IFALIASZ less the NUL: the most an alias holds.
const ALIAS_MAX: usize = 255;
const NF_IP_PRI_NAT_SRC: i32 = 100;
const OUR_PRIORITY: i32 = -10;
const ENODEV: i32 = 19;

/// What a workspace's network is, kept beside its record so a daemon restart finds it and its forwards again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub link: String,
    pub address: Ipv4Addr,
    pub gateway: Ipv4Addr,
    pub prefix: u8,
    /// Workspace port to the port on the box's loopback that dials it.
    #[serde(default)]
    pub forwards: BTreeMap<u16, u16>,
}

#[derive(Debug)]
pub struct Error {
    pub what: String,
    pub source: io::Error,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.what, self.source)
    }
}

impl std::error::Error for Error {}

impl From<nft::Error> for Error {
    fn from(e: nft::Error) -> Error {
        Error { what: e.what, source: e.source }
    }
}

impl From<bundle::Error> for Error {
    fn from(e: bundle::Error) -> Error {
        Error { what: e.path.display().to_string(), source: e.source }
    }
}

fn at(what: impl Into<String>) -> impl FnOnce(io::Error) -> Error {
    move |source| Error { what: what.into(), source }
}

fn nix_at(what: impl Into<String>) -> impl FnOnce(nix::Error) -> Error {
    move |e| Error { what: what.into(), source: io::Error::from(e) }
}

/// The gateway and the workspace address of block k.
pub fn block(index: u16) -> (Ipv4Addr, Ipv4Addr) {
    let base = u32::from(RANGE) + 4 * u32::from(index);
    (Ipv4Addr::from(base + 1), Ipv4Addr::from(base + 2))
}

pub fn link_name(index: u16) -> String {
    format!("{LINK_PREFIX}{index}")
}

fn index_of_link(name: &str) -> Option<u16> {
    name.strip_prefix(LINK_PREFIX)?.parse().ok()
}

/// The lowest block no link on the box holds.
fn free_index(taken: impl Iterator<Item = u16>) -> Option<u16> {
    let held: std::collections::BTreeSet<u16> = taken.collect();
    (FIRST_INDEX..=LAST_INDEX).find(|k| !held.contains(k))
}

/// What the sweep at open took away.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Swept {
    pub links: Vec<String>,
    pub rules: bool,
}

/// One link on the box as rtnetlink lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub index: u32,
    pub name: String,
    pub alias: Option<String>,
}

/// One rtnetlink socket, in whatever network namespace the thread that opened it was in.
pub struct Route {
    socket: Socket,
    seq: u32,
}

impl Route {
    pub fn open() -> Result<Route, Error> {
        let mut socket = Socket::new(NETLINK_ROUTE).map_err(at("opening the route socket"))?;
        socket.bind_auto().map_err(at("binding the route socket"))?;
        Ok(Route { socket, seq: 1 })
    }

    /// One request and everything it answers; an ack or a done ends it, an error names its errno.
    fn request(&mut self, message: RouteNetlinkMessage, flags: u16, what: &str) -> Result<Vec<RouteNetlinkMessage>, Error> {
        self.seq = self.seq.wrapping_add(1);
        let mut packet = NetlinkMessage::from(message);
        packet.header.flags = flags;
        packet.header.sequence_number = self.seq;
        packet.finalize();
        let mut bytes = vec![0u8; packet.header.length as usize];
        packet.serialize(&mut bytes);
        self.socket.send_to(&bytes, &SocketAddr::new(0, 0), 0).map_err(at(what.to_owned()))?;
        let mut out = Vec::new();
        loop {
            let (datagram, _) = self.socket.recv_from_full().map_err(at(what.to_owned()))?;
            let mut offset = 0;
            while offset < datagram.len() {
                let packet = NetlinkMessage::<RouteNetlinkMessage>::deserialize(&datagram[offset..])
                    .map_err(|e| Error { what: what.to_owned(), source: io::Error::other(e.to_string()) })?;
                let length = packet.header.length as usize;
                if length == 0 {
                    break;
                }
                offset += length;
                if packet.header.sequence_number != self.seq {
                    continue;
                }
                match packet.payload {
                    NetlinkPayload::Error(e) => {
                        return match e.code {
                            Some(code) => Err(Error { what: what.to_owned(), source: io::Error::from_raw_os_error(-code.get()) }),
                            None => Ok(out),
                        };
                    }
                    NetlinkPayload::Done(_) => return Ok(out),
                    NetlinkPayload::InnerMessage(m) => out.push(m),
                    _ => {}
                }
            }
        }
    }

    pub fn links(&mut self) -> Result<Vec<Link>, Error> {
        let rows = self.request(RouteNetlinkMessage::GetLink(LinkMessage::default()), NLM_F_REQUEST | NLM_F_DUMP, "listing the links")?;
        Ok(rows
            .into_iter()
            .filter_map(|row| match row {
                RouteNetlinkMessage::NewLink(m) => {
                    let mut link = Link { index: m.header.index, name: String::new(), alias: None };
                    for a in m.attributes {
                        match a {
                            LinkAttribute::IfName(name) => link.name = name,
                            LinkAttribute::IfAlias(alias) => link.alias = Some(alias),
                            _ => {}
                        }
                    }
                    Some(link)
                }
                _ => None,
            })
            .collect())
    }

    pub fn index_of(&mut self, name: &str) -> Result<u32, Error> {
        self.links()?
            .into_iter()
            .find(|l| l.name == name)
            .map(|l| l.index)
            .ok_or_else(|| Error { what: format!("link {name}"), source: io::Error::from(io::ErrorKind::NotFound) })
    }

    /// A veth pair: `name` here, `peer` in the namespace the fd names, or here too when none is given.
    pub fn add_veth(&mut self, name: &str, peer: &str, peer_ns: Option<i32>) -> Result<(), Error> {
        let mut other = LinkMessage::default();
        other.attributes.push(LinkAttribute::IfName(peer.to_owned()));
        if let Some(fd) = peer_ns {
            other.attributes.push(LinkAttribute::NetNsFd(fd));
        }
        let mut message = LinkMessage::default();
        message.attributes.push(LinkAttribute::IfName(name.to_owned()));
        message
            .attributes
            .push(LinkAttribute::LinkInfo(vec![LinkInfo::Kind(InfoKind::Veth), LinkInfo::Data(InfoData::Veth(InfoVeth::Peer(other)))]));
        self.request(
            RouteNetlinkMessage::NewLink(message),
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL,
            &format!("making the veth pair {name}"),
        )?;
        Ok(())
    }

    pub fn set_alias(&mut self, index: u32, alias: &str) -> Result<(), Error> {
        if alias.len() > ALIAS_MAX {
            return Err(Error {
                what: format!("naming link {index}"),
                source: io::Error::other(format!("{alias} is {} bytes, and a link alias holds {ALIAS_MAX}", alias.len())),
            });
        }
        let mut message = LinkMessage::default();
        message.header.index = index;
        message.attributes.push(LinkAttribute::IfAlias(alias.to_owned()));
        self.request(RouteNetlinkMessage::SetLink(message), NLM_F_REQUEST | NLM_F_ACK, &format!("naming link {index} for {alias}"))?;
        Ok(())
    }

    pub fn set_up(&mut self, index: u32) -> Result<(), Error> {
        let mut message = LinkMessage::default();
        message.header.index = index;
        message.header.flags = LinkFlags::Up;
        message.header.change_mask = LinkFlags::Up;
        self.request(RouteNetlinkMessage::SetLink(message), NLM_F_REQUEST | NLM_F_ACK, &format!("bringing link {index} up"))?;
        Ok(())
    }

    pub fn add_address(&mut self, index: u32, address: Ipv4Addr, prefix: u8) -> Result<(), Error> {
        let mut message = AddressMessage::default();
        message.header.family = AddressFamily::Inet;
        message.header.prefix_len = prefix;
        message.header.index = index;
        message.attributes.push(AddressAttribute::Local(address.into()));
        message.attributes.push(AddressAttribute::Address(address.into()));
        self.request(
            RouteNetlinkMessage::NewAddress(message),
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL,
            &format!("giving link {index} the address {address}/{prefix}"),
        )?;
        Ok(())
    }

    /// The interface of the box's default route, the one with the lowest metric where there are several; none on a
    /// box with no way out.
    pub fn default_interface(&mut self) -> Result<Option<String>, Error> {
        let mut request = RouteMessage::default();
        request.header.address_family = AddressFamily::Inet;
        let rows = self.request(RouteNetlinkMessage::GetRoute(request), NLM_F_REQUEST | NLM_F_DUMP, "listing the routes")?;
        let mut best: Option<(u32, u32)> = None;
        for row in rows {
            let RouteNetlinkMessage::NewRoute(route) = row else { continue };
            if route.header.destination_prefix_length != 0
                || route.header.table != RouteHeader::RT_TABLE_MAIN
                || route.header.kind != RouteType::Unicast
            {
                continue;
            }
            let mut oif = None;
            let mut metric = 0;
            for a in &route.attributes {
                match a {
                    RouteAttribute::Oif(index) => oif = Some(*index),
                    RouteAttribute::Priority(p) => metric = *p,
                    _ => {}
                }
            }
            if let Some(index) = oif {
                if best.is_none_or(|(m, _)| metric < m) {
                    best = Some((metric, index));
                }
            }
        }
        let Some((_, index)) = best else { return Ok(None) };
        Ok(self.links()?.into_iter().find(|l| l.index == index).map(|l| l.name))
    }

    pub fn add_default_route(&mut self, gateway: Ipv4Addr) -> Result<(), Error> {
        let mut message = RouteMessage::default();
        message.header.address_family = AddressFamily::Inet;
        message.header.table = RouteHeader::RT_TABLE_MAIN;
        message.header.protocol = RouteProtocol::Boot;
        message.header.scope = RouteScope::Universe;
        message.header.kind = RouteType::Unicast;
        message.attributes.push(RouteAttribute::Gateway(RouteAddress::Inet(gateway)));
        self.request(
            RouteNetlinkMessage::NewRoute(message),
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL,
            &format!("routing through {gateway}"),
        )?;
        Ok(())
    }

    /// Removes the link; one that went between the listing and this call (a namespace dying takes its pair with
    /// it a moment after its last process) is what was asked for, and reads false.
    pub fn delete(&mut self, index: u32) -> Result<bool, Error> {
        let mut message = LinkMessage::default();
        message.header.index = index;
        match self.request(RouteNetlinkMessage::DelLink(message), NLM_F_REQUEST | NLM_F_ACK, &format!("removing link {index}")) {
            Ok(_) => Ok(true),
            Err(e) if e.source.raw_os_error() == Some(ENODEV) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Removes the link by name; one that is already gone is what was asked for.
    pub fn delete_named(&mut self, name: &str) -> Result<bool, Error> {
        match self.links()?.into_iter().find(|l| l.name == name) {
            Some(link) => self.delete(link.index),
            None => Ok(false),
        }
    }
}

/// Runs the work on a thread that has entered the network namespace, so this process's own threads never leave
/// theirs. A namespace is a thread's, and the thread ends with the work.
pub fn inside(ns: fs::File, work: impl FnOnce(&mut Route) -> Result<(), Error> + Send + 'static) -> Result<(), Error> {
    let handle = std::thread::Builder::new()
        .name("wsp-netns".into())
        .spawn(move || -> Result<(), Error> {
            setns(&ns, CloneFlags::CLONE_NEWNET).map_err(nix_at("entering the workspace's network namespace"))?;
            let mut route = Route::open()?;
            work(&mut route)
        })
        .map_err(at("starting the namespace thread"))?;
    handle.join().map_err(|_| Error { what: "the namespace thread".into(), source: io::Error::other("ended without an answer") })?
}

fn is_root() -> bool {
    nix::unistd::geteuid().is_root()
}

fn forwarding_file(iface: &str) -> String {
    format!("/proc/sys/net/ipv4/conf/{iface}/forwarding")
}

/// Turns forwarding on for one interface, and answers whether it was off: a box's own setting is left as found,
/// what this daemon turned on is its to turn off.
fn turn_forwarding_on(iface: &str) -> Result<bool, Error> {
    let file = forwarding_file(iface);
    if fs::read_to_string(&file).map_err(at(file.clone()))?.trim() == "1" {
        return Ok(false);
    }
    fs::write(&file, "1").map_err(at(file))?;
    Ok(true)
}

/// The interface a guard rule's comment names.
fn guarded_interface(comment: &str) -> Option<&str> {
    comment.strip_prefix(FORWARDING_COMMENT)
}

/// The rules of our own table, appended in order. `default` is the interface of the box's default route, the one
/// road out; `guard` is that interface where this daemon turned its forwarding on, so nothing arriving on it is
/// forwarded anywhere but into a workspace.
fn own_rules(default: Option<&str>, guard: Option<&str>) -> Vec<nft::Msg> {
    let table = TABLE;
    let rule = |chain: &str, exprs: Vec<Expr>, comment: &str| nft::new_rule(nft::NFPROTO_IPV4, table, chain, &exprs, comment, false);
    let mut rules = Vec::new();
    let mut metadata: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    metadata.extend(nft::ip_addr_in(true, METADATA_RANGE, METADATA_PREFIX, false));
    metadata.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("forward", metadata, RULE_COMMENT));
    let mut one_road: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    if let Some(default) = default {
        one_road.extend(nft::oifname_is_not(default));
    }
    one_road.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("forward", one_road, RULE_COMMENT));
    let mut answers: Vec<Expr> = nft::oifname_starts(LINK_PREFIX).into();
    answers.extend(nft::ct_established_or_related());
    answers.push(nft::verdict(nft::NF_ACCEPT));
    rules.push(rule("forward", answers, RULE_COMMENT));
    let mut nothing_else: Vec<Expr> = nft::oifname_starts(LINK_PREFIX).into();
    nothing_else.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("forward", nothing_else, RULE_COMMENT));
    if let Some(guard) = guard {
        let mut only_into: Vec<Expr> = nft::iifname_is(guard).into();
        only_into.extend(nft::oifname_not_starts(LINK_PREFIX));
        only_into.push(nft::verdict(nft::NF_DROP));
        rules.push(rule("forward", only_into, &format!("{FORWARDING_COMMENT}{guard}")));
    }
    let mut gateway_only: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    gateway_only.extend(nft::ip_addr_in(true, RANGE, RANGE_PREFIX, true));
    gateway_only.push(nft::verdict(nft::NF_DROP));
    rules.push(rule("input", gateway_only, RULE_COMMENT));
    let mut nat: Vec<Expr> = nft::ip_addr_in(false, RANGE, RANGE_PREFIX, false).into();
    nat.extend(nft::oifname_not_starts(LINK_PREFIX));
    nat.push(nft::masquerade());
    rules.push(rule("postrouting", nat, RULE_COMMENT));
    rules
}

fn own_table(default: Option<&str>, guard: Option<&str>) -> Vec<nft::Msg> {
    let chain = |name, kind, hook, priority| BaseChain {
        family: nft::NFPROTO_IPV4,
        table: TABLE,
        name,
        kind,
        hook,
        priority,
        policy: nft::NF_ACCEPT,
    };
    let mut msgs = vec![
        nft::new_table(nft::NFPROTO_IPV4, TABLE),
        nft::new_chain(&chain("forward", "filter", nft::NF_INET_FORWARD, OUR_PRIORITY)),
        nft::new_chain(&chain("input", "filter", nft::NF_INET_LOCAL_IN, OUR_PRIORITY)),
        nft::new_chain(&chain("postrouting", "nat", nft::NF_INET_POST_ROUTING, NF_IP_PRI_NAT_SRC)),
    ];
    msgs.extend(own_rules(default, guard));
    msgs
}

/// Whether a chain is another firewall's base chain on a hook the workspaces' packets cross.
fn is_a_foreign_filter(chain: &nft::ChainRow) -> bool {
    chain.table != TABLE
        && (chain.family == nft::NFPROTO_IPV4 || chain.family == nft::NFPROTO_INET)
        && chain.kind.as_deref() == Some("filter")
        && matches!(chain.hook, Some(nft::NF_INET_LOCAL_IN | nft::NF_INET_FORWARD))
}

/// Whether such a chain refuses what reaches its end: a drop policy (ufw), or a last rule that refuses everything
/// (firewalld's `reject with icmpx admin-prohibited` under a policy of accept).
fn refuses_at_its_end(chain: &nft::ChainRow, rules: &[nft::RuleRow]) -> bool {
    is_a_foreign_filter(chain) && (chain.policy == Some(nft::NF_DROP) || rules.last().is_some_and(nft::RuleRow::refuses_all))
}

/// The accepts a refusing chain gets at its head, for its hook.
fn accepts_for(chain: &nft::ChainRow) -> Vec<nft::Msg> {
    let rule = |exprs: Vec<Expr>| nft::new_rule(chain.family, &chain.table, &chain.name, &exprs, RULE_COMMENT, true);
    if chain.hook == Some(nft::NF_INET_LOCAL_IN) {
        let mut to_gateway: Vec<Expr> = Vec::new();
        if chain.family == nft::NFPROTO_INET {
            to_gateway.extend(nft::nfproto_ipv4());
        }
        to_gateway.extend(nft::iifname_starts(LINK_PREFIX));
        to_gateway.extend(nft::ip_addr_in(true, RANGE, RANGE_PREFIX, false));
        to_gateway.push(nft::verdict(nft::NF_ACCEPT));
        return vec![rule(to_gateway)];
    }
    // Plain interface matches alone: iptables renders those and refuses a chain holding a native conntrack rule,
    // and what reaches a workspace here already passed our own chain, which lets answers through and nothing else.
    let mut out: Vec<Expr> = nft::iifname_starts(LINK_PREFIX).into();
    out.push(nft::verdict(nft::NF_ACCEPT));
    let mut back: Vec<Expr> = nft::oifname_starts(LINK_PREFIX).into();
    back.push(nft::verdict(nft::NF_ACCEPT));
    vec![rule(out), rule(back)]
}

/// Puts the table and the accepts in place where they are not. The table is written with the default route as it
/// is at that moment, and forwarding on its interface turned on where it was off.
pub fn rules_up() -> Result<(), Error> {
    let mut conn = Conn::open()?;
    let mut batch = Vec::new();
    if !conn.tables()?.contains(&(nft::NFPROTO_IPV4, TABLE.to_owned())) {
        let default = Route::open()?.default_interface()?;
        let guard = match &default {
            Some(iface) => turn_forwarding_on(iface)?.then_some(iface.as_str()),
            None => None,
        };
        batch.extend(own_table(default.as_deref(), guard));
    }
    for chain in conn.chains()? {
        if !is_a_foreign_filter(&chain) {
            continue;
        }
        let rules = conn.rules(chain.family, &chain.table, &chain.name)?;
        if rules.iter().any(|r| r.comment.as_deref() == Some(RULE_COMMENT)) || !refuses_at_its_end(&chain, &rules) {
            continue;
        }
        batch.extend(accepts_for(&chain));
    }
    conn.batch(&batch, "writing the workspace rules")?;
    Ok(())
}

/// Takes the table and every marked accept away, and turns forwarding back off where this daemon turned it on.
pub fn rules_down() -> Result<(), Error> {
    let mut conn = Conn::open()?;
    let mut batch = Vec::new();
    for chain in conn.chains()? {
        if chain.table == TABLE {
            continue;
        }
        for rule in conn.rules(chain.family, &chain.table, &chain.name)? {
            if rule.comment.as_deref() == Some(RULE_COMMENT) {
                batch.push(nft::del_rule(chain.family, &chain.table, &chain.name, rule.handle));
            }
        }
    }
    let mut turned_on = Vec::new();
    if conn.tables()?.contains(&(nft::NFPROTO_IPV4, TABLE.to_owned())) {
        for rule in conn.rules(nft::NFPROTO_IPV4, TABLE, "forward")? {
            if let Some(iface) = rule.comment.as_deref().and_then(guarded_interface) {
                turned_on.push(iface.to_owned());
            }
        }
        batch.push(nft::del_table(nft::NFPROTO_IPV4, TABLE));
    }
    conn.batch(&batch, "removing the workspace rules")?;
    for iface in turned_on {
        let file = forwarding_file(&iface);
        match fs::write(&file, "0") {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(at(file)(e)),
        }
    }
    Ok(())
}

/// Whether anything of ours is in the kernel's ruleset: the table, or a marked accept in another chain.
pub fn rules_present() -> Result<bool, Error> {
    let mut conn = Conn::open()?;
    if conn.tables()?.contains(&(nft::NFPROTO_IPV4, TABLE.to_owned())) {
        return Ok(true);
    }
    for chain in conn.chains()? {
        if conn.rules(chain.family, &chain.table, &chain.name)?.iter().any(|r| r.comment.as_deref() == Some(RULE_COMMENT)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The kernel facts a workspace's network needs, each refusal one sentence for the doctor.
pub fn check() -> Result<(), String> {
    if !is_root() {
        return Err(format!("this daemon runs as uid {}; wsp runs workspaces on a computer as root", nix::unistd::geteuid()));
    }
    Conn::open()
        .and_then(|mut c| c.generation())
        .map_err(|e| format!("this computer's kernel has no nftables, which wsp needs to give a workspace a network: {e}"))?;
    let pair = (|| -> Result<(), Error> {
        let mut route = Route::open()?;
        route.add_veth(CHECK_LINK, CHECK_PEER, None)?;
        route.delete_named(CHECK_LINK)?;
        Ok(())
    })();
    pair.map_err(|e| format!("this computer's kernel makes no veth pair, which wsp needs to give a workspace a network: {e}"))
}

struct Listener {
    box_port: u16,
    task: JoinHandle<()>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The networks of every workspace under one root.
pub struct Net {
    layout: Layout,
    /// One turn at a time on the kernel's tables and links, since a block is picked by reading what is there.
    turn: Mutex<()>,
    listeners: Mutex<BTreeMap<String, BTreeMap<u16, Listener>>>,
}

impl Net {
    /// Opens the networks under the root and, as root, sweeps what belongs to no running workspace: a link whose
    /// alias names a workspace dir under this root that is not running goes, and once no workspace link is left on
    /// the box the rules go too. Not root: nothing here was made, so nothing is touched.
    pub fn open(layout: Layout, running: &[String]) -> Result<(Net, Swept), Error> {
        let net = Net { layout, turn: Mutex::new(()), listeners: Mutex::new(BTreeMap::new()) };
        let mut swept = Swept::default();
        if !is_root() {
            return Ok((net, swept));
        }
        let mut route = Route::open()?;
        for link in route.links()? {
            match link.alias.as_deref().and_then(|alias| net.workspace_of(alias)) {
                Some(id) if link.name.starts_with(LINK_PREFIX) && !running.contains(&id) => {
                    route.delete(link.index)?;
                    swept.links.push(link.name);
                }
                _ => {}
            }
        }
        // Listed again: a pair goes as one, so the peer of a link removed above is gone with it.
        if !route.links()?.iter().any(|l| l.name.starts_with(LINK_PREFIX)) {
            if rules_present()? {
                rules_down()?;
                swept.rules = true;
            }
        } else {
            rules_up()?;
        }
        Ok((net, swept))
    }

    /// The workspace an alias names, when it is a workspace dir under this root.
    fn workspace_of(&self, alias: &str) -> Option<String> {
        let path = Path::new(alias);
        if path.parent()? != self.layout.run() {
            return None;
        }
        Some(path.file_name()?.to_string_lossy().into_owned())
    }

    fn alias_of(&self, id: &str) -> String {
        self.layout.workspace(id).display().to_string()
    }

    pub fn record(&self, id: &str) -> Result<Option<Network>, Error> {
        let path = self.layout.net(id);
        match fs::read(&path) {
            Ok(text) => {
                serde_json::from_slice(&text).map(Some).map_err(|e| Error { what: path.display().to_string(), source: io::Error::other(e) })
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error { what: path.display().to_string(), source: e }),
        }
    }

    /// The listeners of every running workspace, bound again on the ports their records name; a port somebody else
    /// took meanwhile moves and the record says where.
    pub async fn restore(&self, running: &[String]) -> Result<(), Error> {
        for id in running {
            let Some(mut network) = self.record(id)? else { continue };
            let mut moved = false;
            for (port, box_port) in network.forwards.clone() {
                let bound = match bind(box_port).await {
                    Ok(listener) => listener,
                    Err(e) if e.kind() == io::ErrorKind::AddrInUse => bind(0).await.map_err(at("binding a forward"))?,
                    Err(e) => return Err(at(format!("binding 127.0.0.1:{box_port} for {id}"))(e)),
                };
                let got = bound.local_addr().map_err(at("reading a forward's port"))?.port();
                if got != box_port {
                    network.forwards.insert(port, got);
                    moved = true;
                }
                self.hold(id, port, bound, SocketAddrV4::new(network.address, port)).await;
            }
            if moved {
                bundle::write_json(&self.layout.net(id), &network)?;
            }
        }
        Ok(())
    }

    /// The pair, the addresses, the route inside, the rules: the workspace whose init is `pid` gets its network.
    pub async fn up(&self, id: &str, pid: i32) -> Result<Network, Error> {
        let _turn = self.turn.lock().await;
        let layout = Layout::new(self.layout.root());
        let alias = self.alias_of(id);
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            let ns_path = format!("/proc/{pid}/ns/net");
            let ns = fs::File::open(&ns_path).map_err(at(ns_path))?;
            let mut route = Route::open()?;
            let index = free_index(route.links()?.iter().filter_map(|l| index_of_link(&l.name)))
                .ok_or_else(|| Error { what: format!("{RANGE}/{RANGE_PREFIX}"), source: io::Error::other("every block is taken") })?;
            let (gateway, address) = block(index);
            let name = link_name(index);
            route.add_veth(&name, INSIDE_LINK, Some(ns.as_raw_fd()))?;
            let built = (|| -> Result<(), Error> {
                let box_end = route.index_of(&name)?;
                route.set_alias(box_end, &alias)?;
                route.add_address(box_end, gateway, BLOCK_PREFIX)?;
                route.set_up(box_end)?;
                let forwarding = forwarding_file(&name);
                fs::write(&forwarding, "1").map_err(at(forwarding))?;
                inside(ns, move |r| {
                    let eth = r.index_of(INSIDE_LINK)?;
                    let lo = r.index_of("lo")?;
                    r.add_address(eth, address, BLOCK_PREFIX)?;
                    r.set_up(lo)?;
                    r.set_up(eth)?;
                    r.add_default_route(gateway)
                })?;
                rules_up()
            })();
            if let Err(e) = built {
                let _ = route.delete_named(&name);
                return Err(e);
            }
            let network = Network { link: name, address, gateway, prefix: BLOCK_PREFIX, forwards: BTreeMap::new() };
            bundle::write_json(&layout.net(&id), &network)?;
            Ok(network)
        })
        .await
        .map_err(|e| Error { what: "the network task".into(), source: io::Error::other(e.to_string()) })?
    }

    /// The listeners, the link and the record go; with the last workspace link on the box the rules go too. A
    /// workspace whose namespace already died took its pair with it, which is what was asked for.
    pub async fn down(&self, id: &str) -> Result<(), Error> {
        let _turn = self.turn.lock().await;
        self.listeners.lock().await.remove(id);
        // The listeners' tasks end at the next turn of the runtime; taking it here means none is bound when this
        // returns.
        tokio::task::yield_now().await;
        let record = self.record(id)?;
        let alias = self.alias_of(id);
        let path = self.layout.net(id);
        tokio::task::spawn_blocking(move || {
            let mut route = Route::open()?;
            let named = record.as_ref().map(|n| n.link.clone());
            for link in route.links()? {
                if Some(&link.name) == named.as_ref() || link.alias.as_deref() == Some(alias.as_str()) {
                    route.delete(link.index)?;
                }
            }
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(at(path.display().to_string())(e)),
            }
            if !route.links()?.iter().any(|l| l.name.starts_with(LINK_PREFIX)) && rules_present()? {
                rules_down()?;
            }
            Ok(())
        })
        .await
        .map_err(|e| Error { what: "the network task".into(), source: io::Error::other(e.to_string()) })?
    }

    /// The port on the box's loopback that dials the workspace's port: the one already open for it, else a new one.
    pub async fn publish(&self, id: &str, port: u16) -> Result<u16, Error> {
        if let Some(held) = self.listeners.lock().await.get(id).and_then(|m| m.get(&port)) {
            return Ok(held.box_port);
        }
        let mut network =
            self.record(id)?.ok_or_else(|| Error { what: format!("workspace {id}"), source: io::Error::other("has no network") })?;
        let bound = bind(0).await.map_err(at("binding a forward"))?;
        let box_port = bound.local_addr().map_err(at("reading a forward's port"))?.port();
        network.forwards.insert(port, box_port);
        bundle::write_json(&self.layout.net(id), &network)?;
        self.hold(id, port, bound, SocketAddrV4::new(network.address, port)).await;
        Ok(box_port)
    }

    async fn hold(&self, id: &str, port: u16, bound: TcpListener, target: SocketAddrV4) {
        let box_port = bound.local_addr().map(|a| a.port()).unwrap_or(0);
        let task = tokio::spawn(serve(bound, target));
        self.listeners.lock().await.entry(id.to_owned()).or_default().insert(port, Listener { box_port, task });
    }
}

async fn bind(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await
}

/// Every connection accepted on the box's loopback is one connection to the workspace's port, bytes both ways
/// until either side closes.
async fn serve(listener: TcpListener, target: SocketAddrV4) {
    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        tokio::spawn(async move {
            if let Ok(mut outbound) = TcpStream::connect(target).await {
                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_are_thirties_out_of_the_range_and_links_carry_their_index() {
        assert_eq!(block(1), (Ipv4Addr::new(10, 65, 0, 5), Ipv4Addr::new(10, 65, 0, 6)));
        assert_eq!(block(64), (Ipv4Addr::new(10, 65, 1, 1), Ipv4Addr::new(10, 65, 1, 2)));
        assert_eq!(block(LAST_INDEX), (Ipv4Addr::new(10, 65, 255, 249), Ipv4Addr::new(10, 65, 255, 250)));
        assert_eq!(link_name(7), "wsp-7");
        assert_eq!(index_of_link("wsp-7"), Some(7));
        assert_eq!(index_of_link("wsp-x"), None);
        assert_eq!(index_of_link("eth0"), None);
        assert_eq!(free_index([1u16, 2, 4].into_iter()), Some(3));
        assert_eq!(free_index(std::iter::empty()), Some(FIRST_INDEX));
        assert_eq!(free_index(FIRST_INDEX..=LAST_INDEX), None);
    }

    #[test]
    fn a_network_record_reads_back_with_its_forwards() {
        let network = Network {
            link: "wsp-3".into(),
            address: Ipv4Addr::new(10, 65, 0, 14),
            gateway: Ipv4Addr::new(10, 65, 0, 13),
            prefix: 30,
            forwards: BTreeMap::from([(7070, 41234)]),
        };
        let text = serde_json::to_string(&network).unwrap();
        assert!(text.contains("\"forwards\":{\"7070\":41234}"), "{text}");
        assert_eq!(serde_json::from_str::<Network>(&text).unwrap(), network);
    }

    #[test]
    fn a_foreign_filter_chain_gets_an_accept_when_its_policy_or_its_last_rule_refuses() {
        let chain = |table: &str, family, kind: &str, hook, policy| nft::ChainRow {
            family,
            table: table.into(),
            name: "x".into(),
            kind: Some(kind.into()),
            hook: Some(hook),
            policy: Some(policy),
        };
        let rule = |exprs: &[&str], verdict| nft::RuleRow {
            handle: 1,
            comment: None,
            exprs: exprs.iter().map(|e| (*e).to_owned()).collect(),
            verdict,
        };
        let ufw = chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_FORWARD, nft::NF_DROP);
        assert!(refuses_at_its_end(&ufw, &[]));
        assert!(refuses_at_its_end(&chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_LOCAL_IN, nft::NF_DROP), &[]));
        // firewalld: policy accept, the last rule a bare reject.
        let firewalld = chain("firewalld", nft::NFPROTO_INET, "filter", nft::NF_INET_LOCAL_IN, nft::NF_ACCEPT);
        assert!(refuses_at_its_end(&firewalld, &[rule(&["meta", "cmp", "immediate"], Some(nft::NF_ACCEPT)), rule(&["reject"], None)]));
        assert!(refuses_at_its_end(&firewalld, &[rule(&["counter", "immediate"], Some(nft::NF_DROP))]));
        assert!(!refuses_at_its_end(&firewalld, &[]), "policy accept and no rule refuses nothing");
        assert!(
            !refuses_at_its_end(&firewalld, &[rule(&["meta", "cmp", "reject"], None)]),
            "a reject behind a match is not the chain's end"
        );
        assert!(!refuses_at_its_end(&chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_POST_ROUTING, nft::NF_DROP), &[]));
        assert!(!refuses_at_its_end(&chain("nat", nft::NFPROTO_IPV4, "nat", nft::NF_INET_FORWARD, nft::NF_DROP), &[]));
        assert!(!refuses_at_its_end(&chain(TABLE, nft::NFPROTO_IPV4, "filter", nft::NF_INET_FORWARD, nft::NF_DROP), &[]));
        assert!(
            !refuses_at_its_end(&chain("filter", 10, "filter", nft::NF_INET_FORWARD, nft::NF_DROP), &[]),
            "ip6 carries none of our packets"
        );
        assert_eq!(accepts_for(&ufw).len(), 2);
        assert_eq!(accepts_for(&chain("filter", nft::NFPROTO_IPV4, "filter", nft::NF_INET_LOCAL_IN, nft::NF_DROP)).len(), 1);
        assert_eq!(own_table(Some("eth0"), None).len(), 4 + 6);
        assert_eq!(own_table(Some("eth0"), Some("eth0")).len(), 4 + 7, "the guard rides along where this daemon turned forwarding on");
        assert_eq!(own_table(None, None).len(), 4 + 6, "no default route: the one road rule drops everything a workspace forwards");
        assert_eq!(guarded_interface("wsp workspaces: forwarding turned on for eth0"), Some("eth0"));
        assert_eq!(guarded_interface(RULE_COMMENT), None);
        assert_eq!(forwarding_file("wsp-3"), "/proc/sys/net/ipv4/conf/wsp-3/forwarding");
    }

    #[test]
    fn an_alias_names_a_workspace_under_this_root_alone() {
        let net = Net { layout: Layout::new(Path::new("/var/lib/wsp")), turn: Mutex::new(()), listeners: Mutex::new(BTreeMap::new()) };
        assert_eq!(net.workspace_of("/var/lib/wsp/run/wsp-a"), Some("wsp-a".to_owned()));
        assert_eq!(net.workspace_of("/tmp/other/run/wsp-a"), None);
        assert_eq!(net.workspace_of("wsp-a"), None);
        assert_eq!(net.alias_of("wsp-a"), "/var/lib/wsp/run/wsp-a");
    }
}
