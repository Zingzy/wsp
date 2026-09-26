// SPDX-License-Identifier: AGPL-3.0-only
//! A port a test counts on being refused, held for the test's life. A port freed for the dial to be refused is free
//! for any other test's bind to port 0 to be handed, and that listener answers.
#![allow(dead_code)]

use std::net::SocketAddr;

use tokio::net::{TcpListener, TcpSocket, TcpStream};

/// A port nothing listens on at 127.0.0.1 or ::1, the two loopbacks a tunnel dials. A connected socket of ours owns
/// it on each, and the kernel never hands a port a connected socket holds to a bind to port 0.
pub struct RefusedPort {
    pub port: u16,
    _held: [(TcpListener, TcpStream); 2],
}

impl RefusedPort {
    pub fn addrs(&self) -> [SocketAddr; 2] {
        [([127, 0, 0, 1], self.port).into(), ([0, 0, 0, 0, 0, 0, 0, 1], self.port).into()]
    }
}

pub async fn refused_port() -> RefusedPort {
    loop {
        let anchor4 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let held4 = TcpStream::connect(anchor4.local_addr().unwrap()).await.unwrap();
        let port = held4.local_addr().unwrap().port();
        let anchor6 = TcpListener::bind("[::1]:0").await.unwrap();
        let socket = TcpSocket::new_v6().unwrap();
        if socket.bind(([0, 0, 0, 0, 0, 0, 0, 1], port).into()).is_err() {
            continue;
        }
        let Ok(held6) = socket.connect(anchor6.local_addr().unwrap()).await else {
            continue;
        };
        return RefusedPort { port, _held: [(anchor4, held4), (anchor6, held6)] };
    }
}

/// Whether another test's listener could take this address, bound without SO_REUSEADDR as the kernel checks a port
/// it hands to a bind to port 0.
pub fn squatter_binds(at: SocketAddr) -> bool {
    let socket = if at.is_ipv4() { TcpSocket::new_v4() } else { TcpSocket::new_v6() }.unwrap();
    socket.bind(at).is_ok() && socket.listen(1).is_ok()
}
