//! Offline config commands use the same SQLite authority as the server.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::Context as _;
use clap::{Parser, Subcommand};
use cpa_server::config_store::{ConfigStore, resources};

#[derive(Parser)]
#[command(name = "cook-router")]
pub struct Cli {
    /// Config database; defaults to COOK_DB or cook.db beside --config.
    #[arg(long, global = true, default_value = "")]
    db: String,
    #[arg(long, global = true, default_value = "config.yaml")]
    config: PathBuf,
    #[arg(long, global = true)]
    working_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    log_file: Option<PathBuf>,
    #[command(subcommand)]
    command: Top,
}

#[derive(Subcommand)]
enum Top {
    /// Import, export, validate or back up the SQLite config.
    Config {
        #[command(subcommand)]
        command: Command,
    },
}

#[derive(Subcommand)]
enum Command {
    /// Atomically replace config from YAML or a versioned JSON export (- for stdin).
    Import { file: PathBuf },
    /// Export versioned JSON; secrets are redacted unless --secrets is given.
    Export {
        #[arg(short, long)]
        output: Option<PathBuf>,
        #[arg(long)]
        secrets: bool,
    },
    /// Validate YAML/JSON without writing, or validate stored config when omitted.
    Validate { file: Option<PathBuf> },
    /// Create a consistent SQLite backup, including revision history and secrets.
    Backup { file: PathBuf },
    /// Print committed host, port and TLS-enabled boolean on three separate lines.
    Listener,
}

/// Detect the first operand using the binary's built-in value flags.
pub fn is_command(args: &[String]) -> bool {
    use clap::CommandFactory as _;
    let cmd = crate::Args::command();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if !arg.starts_with('-') || arg == "-" {
            return arg == "config";
        }
        if arg == "--" {
            return false;
        }
        let flag = arg.trim_start_matches('-');
        if !flag.contains('=') {
            let Some(flag) = cmd.get_arguments().find(|f| f.get_long() == Some(flag)) else {
                return false;
            };
            if flag.get_action().takes_values() {
                args.next();
            }
        }
    }
    false
}

fn read_config(file: &Path) -> anyhow::Result<String> {
    if file == Path::new("-") {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        Ok(text)
    } else {
        std::fs::read_to_string(file).with_context(|| format!("read {}", file.display()))
    }
}

fn import_config(text: &str) -> anyhow::Result<Vec<resources::Resource>> {
    if text.trim_start().starts_with('{') {
        // YAML also allows flow mappings, so retain that syntax when this is not
        // a versioned JSON export. Unknown export fields fail both strict parsers.
        match resources::import_json(text) {
            Ok(resources) => Ok(resources),
            Err(json_error) => resources::import_yaml(text).or(Err(json_error.into())),
        }
    } else {
        resources::import_yaml(text)
    }
}

fn existing(db: &Path) -> anyhow::Result<ConfigStore> {
    anyhow::ensure!(
        db.is_file(),
        "config database {} does not exist; run config import first",
        db.display()
    );
    ConfigStore::open_without_migration(db)
}

fn export(store: &ConfigStore, secrets: bool) -> anyhow::Result<String> {
    let (revision, all) = store.snapshot()?;
    Ok(serde_json::to_string_pretty(&resources::export_json(revision, &all, secrets))? + "\n")
}

pub fn execute(args: Vec<String>) -> anyhow::Result<()> {
    let cli = Cli::parse_from(args);
    if let Some(dir) = &cli.working_dir {
        std::env::set_current_dir(dir).with_context(|| format!("change to working directory {}", dir.display()))?;
    }
    crate::dotenv::load_from_working_dir();
    if let Some(path) = &cli.log_file {
        cpa_server::logging::set_log_file(path.clone()).context("open process log")?;
    }
    run(cli)
}

fn run(cli: Cli) -> anyhow::Result<()> {
    let db = crate::db_path(&cli.db, &cli.config);
    let Top::Config { command } = cli.command;
    match command {
        Command::Import { file } => {
            let text = read_config(&file)?;
            // Parse and validate before creating a database; replace commits atomically.
            let resources = import_config(&text)?;
            let store = ConfigStore::open(&db)?;
            let done = store.replace(resources, "cli", &format!("import {}", file.display()), false)?;
            println!("Imported revision {} into {}", done.rev, db.display());
        }
        Command::Export { output, secrets } => {
            let text = export(&existing(&db)?, secrets)?;
            match output {
                Some(file) => {
                    anyhow::ensure!(file != db, "export must not overwrite the config database");
                    let mut options = std::fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt as _;
                        options.mode(0o600);
                    }
                    options
                        .open(&file)
                        .with_context(|| format!("create {}", file.display()))?
                        .write_all(text.as_bytes())?;
                }
                None => std::io::stdout().write_all(text.as_bytes())?,
            }
        }
        Command::Validate { file } => {
            match file {
                Some(file) => {
                    let parsed = import_config(&read_config(&file)?)?;
                    let store = if db.is_file() {
                        existing(&db)?
                    } else {
                        ConfigStore::memory()
                    };
                    store.replace(parsed, "cli", "validate", true)?;
                }
                None => {
                    existing(&db)?.load().map_err(|e| anyhow::anyhow!("{e}"))?;
                }
            }
            println!("Configuration is valid");
        }
        Command::Backup { file } => existing(&db)?.backup(&file)?,
        Command::Listener => {
            let config = existing(&db)?.load().map_err(|e| anyhow::anyhow!("{e}"))?.config;
            anyhow::ensure!(
                !config.host.contains(['\r', '\n']),
                "configured listener host contains line breaks"
            );
            let tls = config
                .document
                .get("server")
                .and_then(|server| server.get("tls"))
                .and_then(|tls| tls.get("enable"))
                .and_then(serde_yaml_ng::Value::as_bool)
                .unwrap_or(false);
            println!("{}\n{}\n{tls}", config.host, config.port);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_commands_parse_global_database_before_or_after_command() {
        for args in [
            vec!["cook-router", "--db", "selected.db", "config", "validate"],
            vec!["cook-router", "config", "validate", "--db", "selected.db"],
        ] {
            let cli = Cli::try_parse_from(&args).unwrap();
            assert_eq!(cli.db, "selected.db");
            assert!(is_command(&args[1..].iter().map(|s| s.to_string()).collect::<Vec<_>>()));
        }
        assert!(!is_command(&["--config".into(), "config".into()]));
    }

    #[test]
    fn exports_hide_secrets_unless_requested_and_invalid_import_does_not_create_a_database() {
        let store = ConfigStore::memory_with("api-keys: [fake-client-secret]\nport: 8317\n");
        assert!(!export(&store, false).unwrap().contains("fake-client-secret"));
        assert!(export(&store, true).unwrap().contains("fake-client-secret"));
        let dir = std::env::temp_dir().join(format!("cook-config-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("invalid.db");
        let yaml = dir.join("invalid.yaml");
        std::fs::write(&yaml, "port: wrong\n").unwrap();
        let cli = Cli::try_parse_from([
            "cook-router",
            "--db",
            db.to_str().unwrap(),
            "config",
            "import",
            yaml.to_str().unwrap(),
        ])
        .unwrap();
        assert!(run(cli).is_err());
        assert!(!db.exists());
        assert!(existing(&dir.join("missing.db")).is_err());
        assert!(!dir.join("missing.db").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn json_export_preserves_oauth_scope_and_raw_plugin_semantics() {
        let source = "codex:\n  disable-codex-cloaking: true\noauth:\n  providers:\n    codex:\n      response-steering: true\nplugins:\n  enabled: true\n  configs:\n    acme:\n      ratio: 1.50\n      tagged: !!float 1\n      binary: !!binary YWJj\n      quoted: '007'\n";
        let original = ConfigStore::memory_with(source);
        let expected = original.load().unwrap().config;
        let text = export(&original, true).unwrap();
        let document: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(document["format"], "cook-router-config");
        let restored = ConfigStore::memory();
        restored
            .replace(import_config(&text).unwrap(), "cli", "restore", false)
            .unwrap();
        let actual = restored.load().unwrap().config;
        assert_eq!(actual.oauth_only, expected.oauth_only);
        assert_eq!(actual.plugin_configs, expected.plugin_configs);
        assert_eq!(actual.for_api_key().document, expected.for_api_key().document);
        let masked = export(&restored, false).unwrap();
        restored
            .replace(import_config(&masked).unwrap(), "cli", "masked roundtrip", false)
            .unwrap();
        assert_eq!(restored.load().unwrap().config.plugin_configs, expected.plugin_configs);
        assert!(import_config("{port: 8317}").is_ok(), "flow YAML remains valid input");
    }
}
