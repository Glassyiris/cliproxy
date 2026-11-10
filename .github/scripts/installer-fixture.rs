// Local release fixtures: no provider clients, auth files or network access.
fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    #[cfg(not(legacy))]
    let args: Vec<_> = std::env::args().skip(1).collect();
    #[cfg(not(legacy))]
    if args.iter().any(|arg| arg == "config") {
        let status = std::process::Command::new(std::env::var_os("INSTALLER_REAL_BINARY").unwrap())
            .args(&args)
            .status()
            .unwrap();
        std::process::exit(status.code().unwrap_or(1));
    }
    if arg == "--version" {
        println!("cook-router 999.2.0");
    } else if arg == "--help" {
        #[cfg(legacy)]
        println!("--config PATH");
        #[cfg(not(legacy))]
        println!("--db PATH --config PATH --log-file PATH --working-dir DIR");
    } else {
        #[cfg(legacy)]
        std::process::exit(2);
        #[cfg(plain_health)]
        {
            use std::io::{Read, Write};
            let db = &args[args.iter().position(|arg| arg == "--db").unwrap() + 1];
            let output = std::process::Command::new(std::env::var_os("INSTALLER_REAL_BINARY").unwrap())
                .args(["--db", db, "config", "listener"])
                .output()
                .unwrap();
            assert!(output.status.success());
            let settings = String::from_utf8(output.stdout).unwrap();
            let mut settings = settings.lines();
            let host = settings.next().unwrap();
            let port = settings.next().unwrap().parse::<u16>().unwrap();
            let listener = std::net::TcpListener::bind((host, port)).unwrap();
            // Deliberately speaks HTTP despite a TLS config: a TCP-only probe
            // accepts this broken upgrade; a real HTTPS probe must roll it back.
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let _ = stream.read(&mut [0; 1024]);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
            }
        }
        #[cfg(not(any(legacy, plain_health)))]
        {
            #[cfg(unix)]
            unsafe {
                unsafe extern "C" {
                    fn signal(sig: i32, handler: usize) -> usize;
                }
                // SIG_IGN for SIGTERM: exercise the installer's bounded SIGKILL fallback.
                signal(15, 1);
            }
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
            }
        }
    }
}
