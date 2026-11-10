//! Config commands and help must not start the runtime or depend on a YAML mirror.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cook-config-{name}-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("tmp")).unwrap();
    dir
}

fn cli(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cook-router"))
        .current_dir(dir)
        .env_clear()
        .env("TMPDIR", dir.join("tmp"))
        .env("TMP", dir.join("tmp"))
        .env("TEMP", dir.join("tmp"))
        .args(args)
        .output()
        .unwrap()
}

fn success(output: Output) -> String {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn help_never_creates_a_database_and_bad_databases_never_fall_back_to_yaml() {
    let dir = scratch("help");
    for args in [
        vec!["--help"],
        vec!["--db", "nested/chosen.db", "--help"],
        vec!["config", "--help"],
        vec!["config", "validate", "--help", "--db", "nested/chosen.db"],
    ] {
        success(cli(&dir, &args));
        assert!(!dir.join("cook.db").exists());
        assert!(!dir.join("nested").exists());
    }
    std::fs::write(dir.join("bad.db"), "not SQLite").unwrap();
    std::fs::write(dir.join("config.yaml"), "host: 127.0.0.1\nport: 0\n").unwrap();
    let output = cli(&dir, &["--db", "bad.db", "--config", "config.yaml", "--local-model"]);
    assert!(!output.status.success());
    assert_eq!(std::fs::read_to_string(dir.join("bad.db")).unwrap(), "not SQLite");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn import_validate_export_and_backup_share_the_selected_database() {
    let dir = scratch("roundtrip");
    std::fs::write(dir.join("source.yaml"), "port: 8345\napi-keys: [fake-client-secret]\n").unwrap();
    success(cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]));
    assert!(!dir.join("cook.db").exists());
    std::fs::write(dir.join("source.yaml"), "port: wrong\n").unwrap();
    success(cli(&dir, &["config", "validate", "--db", "chosen.db"]));
    let invalid = cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]);
    assert!(!invalid.status.success());
    let redacted = success(cli(&dir, &["config", "export", "--db", "chosen.db"]));
    assert!(!redacted.contains("fake-client-secret"));
    let full = success(cli(&dir, &["--db", "chosen.db", "config", "export", "--secrets"]));
    assert!(full.contains("8345"));
    assert!(full.contains("fake-client-secret"));
    let exported: serde_json::Value = serde_json::from_str(&full).unwrap();
    assert_eq!(exported["format"], "cook-router-config");
    std::fs::write(dir.join("export.json"), &full).unwrap();
    success(cli(&dir, &["--db", "chosen.db", "config", "validate", "export.json"]));
    success(cli(&dir, &["--db", "restored.db", "config", "import", "export.json"]));
    let restored = success(cli(&dir, &["--db", "restored.db", "config", "export", "--secrets"]));
    assert_eq!(full, restored);
    success(cli(&dir, &["--db", "chosen.db", "config", "backup", "backup.db"]));
    let backup = success(cli(&dir, &["--db", "backup.db", "config", "export", "--secrets"]));
    assert_eq!(full, backup);
    let overwrite = cli(
        &dir,
        &["--db", "chosen.db", "config", "export", "--output", "chosen.db"],
    );
    assert!(!overwrite.status.success());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn concurrent_cli_writers_publish_one_complete_latest_snapshot() {
    let dir = scratch("process-race");
    std::fs::write(dir.join("initial.yaml"), "port: 8500\n").unwrap();
    success(cli(&dir, &["--db", "shared.db", "config", "import", "initial.yaml"]));
    let children: Vec<_> = (1..=4)
        .map(|writer| {
            let source = format!("writer-{writer}.yaml");
            std::fs::write(dir.join(&source), format!("port: {}\n", 8500 + writer)).unwrap();
            Command::new(env!("CARGO_BIN_EXE_cook-router"))
                .current_dir(&dir)
                .env_clear()
                .env("TMPDIR", dir.join("tmp"))
                .env("TMP", dir.join("tmp"))
                .env("TEMP", dir.join("tmp"))
                .args(["--db", "shared.db", "config", "import", &source])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    std::fs::copy(dir.join("shared.db"), dir.join("copy.db")).unwrap();
    success(cli(&dir, &["--db", "copy.db", "config", "validate"]));
    for child in children {
        success(child.wait_with_output().unwrap());
    }
    let exported = success(cli(&dir, &["--db", "shared.db", "config", "export"]));
    let exported: serde_json::Value = serde_json::from_str(&exported).unwrap();
    assert_eq!(exported["revision"], 5);
    assert_eq!(&std::fs::read(dir.join("shared.db")).unwrap()[18..20], &[1, 1]);
    let temporary = dir.join("tmp/cook-router");
    assert!(temporary.join("coordination.db").exists());
    assert!(
        !std::fs::read_dir(&temporary)
            .unwrap()
            .any(|entry| entry.unwrap().file_type().unwrap().is_dir())
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn database_flag_overrides_environment_and_environment_overrides_default() {
    let dir = scratch("environment");
    std::fs::write(dir.join("source.yaml"), "port: 8345\n").unwrap();
    for args in [
        vec!["config", "import", "source.yaml"],
        vec!["--db", "flag.db", "config", "import", "source.yaml"],
    ] {
        success(
            Command::new(env!("CARGO_BIN_EXE_cook-router"))
                .current_dir(&dir)
                .env_clear()
                .env("TMPDIR", dir.join("tmp"))
                .env("TMP", dir.join("tmp"))
                .env("TEMP", dir.join("tmp"))
                .env("COOK_DB", "environment.db")
                .args(args)
                .output()
                .unwrap(),
        );
    }
    assert!(dir.join("environment.db").is_file());
    assert!(dir.join("flag.db").is_file());
    assert!(!dir.join("cook.db").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn listener_reports_committed_defaults_and_tls_without_secrets_or_yaml_reads() {
    let dir = scratch("listener");
    for (source, expected) in [
        ("{}\n", "\n0\nfalse\n"),
        (
            "host: '::1'\nport: 8443\ntls: {enable: true, cert: fake-cert.pem, key: fake-private-key.pem}\napi-keys: [fake-client-secret]\n",
            "::1\n8443\ntrue\n",
        ),
    ] {
        std::fs::write(dir.join("source.yaml"), source).unwrap();
        success(cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]));
        std::fs::remove_file(dir.join("source.yaml")).unwrap();
        assert_eq!(
            success(cli(&dir, &["--db", "chosen.db", "config", "listener"])),
            expected
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn read_commands_leave_older_schema_versions_unchanged_and_refuse_newer_ones() {
    let dir = scratch("old-schema");
    std::fs::write(dir.join("source.yaml"), "host: 127.0.0.1\nport: 8345\n").unwrap();
    success(cli(&dir, &["--db", "chosen.db", "config", "import", "source.yaml"]));
    let path = dir.join("chosen.db");
    let mut database = std::fs::read(&path).unwrap();
    let current_version = database[60..64].to_vec();
    // SQLite's user_version is a big-endian u32 in the database header.
    database[60..64].copy_from_slice(&1u32.to_be_bytes());
    std::fs::write(&path, &database).unwrap();
    for args in [
        vec!["config", "listener"],
        vec!["config", "export"],
        vec!["config", "validate"],
        vec!["config", "validate", "source.yaml"],
        vec!["config", "backup", "backup.db"],
    ] {
        let mut command = vec!["--db", "chosen.db"];
        command.extend(args);
        success(cli(&dir, &command));
        assert_eq!(&std::fs::read(&path).unwrap()[60..64], &1u32.to_be_bytes());
    }
    assert_eq!(
        &std::fs::read(dir.join("backup.db")).unwrap()[60..64],
        &1u32.to_be_bytes()
    );
    database[60..64].copy_from_slice(&u32::MAX.to_be_bytes());
    std::fs::write(&path, &database).unwrap();
    let output = cli(&dir, &["--db", "chosen.db", "config", "listener"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("newer than this build"));
    database[60..64].copy_from_slice(&current_version);
    std::fs::write(&path, database).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
