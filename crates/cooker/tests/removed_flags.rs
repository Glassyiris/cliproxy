//! Home mode is gone: its flags are unknown flags and its environment variables are
//! ordinary unread variables. Runs a short import command; no network.
use std::process::{Command, Output};

fn run(dir: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cooker"))
        .args(args)
        .current_dir(dir)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", dir)
        .envs(env.iter().copied())
        .output()
        .unwrap()
}

#[test]
fn home_flags_are_unknown_and_home_variables_start_nothing() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("cook-router-no-home-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(dir.join("auth")).unwrap();
    std::fs::write(dir.join("config.yaml"), "config-version: 8\nserver:\n  port: 0\n").unwrap();
    let import = ["--local-model", "--vertex-import", "missing-key.json"];
    for flag in [&["--home-jwt", "fake-jwt"][..], &["--home-disable-cluster-discovery"]] {
        let args: Vec<&str> = flag.iter().chain(&import).copied().collect();
        let output = run(&dir, &args, &[]);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{flag:?} was accepted: {stderr}");
        assert!(stderr.contains(flag[0].trim_start_matches('-')), "{flag:?}: {stderr}");
    }
    let plain = run(&dir, &import, &[]);
    let with_env = run(&dir, &import, &[("HOME_JWT", "fake-jwt"), ("home_jwt", "fake-jwt")]);
    assert!(plain.status.success(), "{}", String::from_utf8_lossy(&plain.stderr));
    assert_eq!(with_env.status.code(), plain.status.code());
    let output = [with_env.stdout, with_env.stderr].concat();
    assert!(
        !String::from_utf8_lossy(&output).to_ascii_lowercase().contains("jwt"),
        "{}",
        String::from_utf8_lossy(&output)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn go_single_dash_flags_are_rejected_and_discover_json_keeps_stdout_clean() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("cook-router-no-go-flags-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for args in [
        &["-config", "config.yaml"][..],
        &["-local-model", "--vertex-import", "x.json"],
        &["--local-model=true"],
    ] {
        let output = run(&dir, args, &[]);
        assert_eq!(output.status.code(), Some(2), "{args:?} was accepted");
        assert!(!dir.join("cook.db").exists(), "{args:?} opened a database");
    }
    // An interface that does not exist: the scan finds nothing and sends nothing.
    let output = run(
        &dir,
        &[
            "--discover-json",
            "--discover-timeout",
            "0",
            "--discover-include",
            "cook-none0",
        ],
        &[],
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<serde_json::Value>(&stdout).unwrap_or_else(|e| panic!("{e}: {stdout:?}"));
    assert!(!dir.join("cook.db").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_possible_plugin_flag_before_discover_json_opens_no_database() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("cook-router-discover-order-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("config.yaml"), "port: 0\n").unwrap();
    // Discovery loads no plugin, so the unknown flag is refused, as when it follows
    // --discover-json, and nothing is imported or logged first.
    let output = run(
        &dir,
        &[
            "--config",
            "config.yaml",
            "--mine",
            "--discover-json",
            "--discover-include",
            "cook-none0",
        ],
        &[],
    );
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty(), "{}", String::from_utf8_lossy(&output.stdout));
    assert!(!dir.join("cook.db").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
