//! Home mode is gone: its flags are unknown flags and its environment variables are
//! ordinary unread variables. Runs a short import command; no network.
use std::process::{Command, Output};

fn run(dir: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cook-router"))
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
    std::fs::write(
        dir.join("config.yaml"),
        "config-version: 8\nport: 0\nauth-dir: ./auth\n",
    )
    .unwrap();
    let import = ["-local-model", "-vertex-import", "missing-key.json"];
    for flag in [
        &["--home-jwt", "fake-jwt"][..],
        &["-home-jwt", "fake-jwt"],
        &["--home-disable-cluster-discovery"],
    ] {
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
