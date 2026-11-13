//! Plugin command-line flags in the binary (cmd/server/main.go): plugins load from the
//! bootstrap config before the flag parse and declare their flags; when one is given,
//! the plugins that own it run instead of the server (Go `RegisterCommandLineFlags`,
//! `HasTriggeredCommandLineFlags`, `ExecuteCommandLine`).

use std::io::Write as _;
use std::sync::Arc;

use clap::ArgAction;
use cpa_core::config::Config;
use cpa_plugin::Host;
use cpa_plugin::cli::{CliFlag, Output};
use cpa_server::credential_store::CredentialDb;

/// Loads plugins from the bootstrap config and registers their flags. `builtin` says
/// whether the binary already has a flag of that name. Returns the host and the flags
/// it accepted.
pub async fn bootstrap(cfg: Config, builtin: &dyn Fn(&str) -> bool) -> (Host, Vec<CliFlag>) {
    let host = Host::new();
    host.apply_config(Arc::new(cfg)).await;
    let flags = host.register_command_line_flags(builtin).await;
    (host, flags)
}

/// The command with the plugin flags added, so clap parses them and `--help` lists them.
pub fn with_flags(mut cmd: clap::Command, flags: &[CliFlag]) -> clap::Command {
    for flag in flags {
        // Go has no -version flag; a plugin may own the name.
        if flag.name == "version" {
            cmd = cmd.disable_version_flag(true);
        }
        let action = if flag.kind == "bool" {
            ArgAction::SetTrue
        } else {
            ArgAction::Set
        };
        // clap (without its `string` feature) takes static names; the few plugin flags
        // are leaked once at startup.
        let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
        cmd = cmd.arg(
            clap::Arg::new(leak(format!("plugin:{}", flag.name)))
                .long(leak(flag.name.clone()))
                .help(leak(flag.usage.clone()))
                .action(action),
        );
    }
    cmd
}

/// Hands each plugin flag given on the command line to its plugin, which validates the
/// value. A boolean flag is set to `true`.
pub fn set_flags(host: &Host, matches: &clap::ArgMatches) -> Result<(), String> {
    for id in matches.ids() {
        let id = id.as_str();
        let Some(name) = id.strip_prefix("plugin:") else {
            continue;
        };
        if matches.value_source(id) != Some(clap::parser::ValueSource::CommandLine) {
            continue;
        }
        let value = match matches.try_get_one::<bool>(id) {
            Ok(Some(_)) => "true".to_owned(),
            _ => matches.get_one::<String>(id).cloned().unwrap_or_default(),
        };
        host.set_command_line_flag(name, &value)
            .map_err(|e| format!("invalid value {value:?} for flag --{name}: {e}"))?;
    }
    Ok(())
}

/// Go `flag.CommandLine.VisitAll` for the built-in flags: each flag's `Value.String()`
/// after the parse (`flag.Func` flags print as empty).
pub fn builtin_values(cmd: &clap::Command, matches: &clap::ArgMatches) -> Vec<(String, String)> {
    cmd.get_arguments()
        .filter(|arg| !arg.get_id().as_str().starts_with("plugin:"))
        .filter_map(|arg| {
            let name = arg.get_long()?;
            // log-file and working-dir belong to this process, not Go's plugin
            // command-line contract.
            if matches!(name, "help" | "version" | "log-file" | "working-dir") {
                return None;
            }
            let id = arg.get_id().as_str();
            let value = match arg.get_action() {
                ArgAction::SetTrue => matches.get_flag(id).to_string(),
                ArgAction::Append => String::new(),
                _ => {
                    if let Ok(Some(v)) = matches.try_get_one::<String>(id) {
                        v.clone()
                    } else if let Ok(Some(v)) = matches.try_get_one::<i64>(id) {
                        v.to_string()
                    } else if let Ok(Some(v)) = matches.try_get_one::<u16>(id) {
                        v.to_string()
                    } else {
                        String::new()
                    }
                }
            };
            Some((name.to_owned(), value))
        })
        .collect()
}

/// Go's `ExecuteCommandLine` step in main, once the loaded config is applied: runs the
/// plugins whose flags were given, writing their output and saving the auths they
/// produce to the auth directory. Returns the exit code when a plugin handled the run.
pub async fn execute(host: &Host, builtin: &[(String, String)], backend: &Arc<CredentialDb>) -> Option<i32> {
    if !host.has_triggered_command_line_flags() {
        return None;
    }
    let raw: Vec<String> = std::env::args().collect();
    let program = raw.first().cloned().unwrap_or_default();
    let auth_dir = host.host_config_summary().auth_dir;
    let backend = backend.clone();
    let persist = Arc::new(move |auths: Vec<cpa_plugin::auth::PluginAuth>| save_auths(auths, &auth_dir, &backend));
    let (code, handled, output) = host
        .execute_command_line(
            &program,
            raw.get(1..).unwrap_or_default(),
            // SQLite has no YAML backing file. The host summary and config callbacks
            // remain authoritative; an empty optional ConfigPath advertises no file.
            "",
            builtin,
            persist,
        )
        .await;
    write_output(output);
    handled.then_some(code)
}

pub async fn execute_online(
    host: &Host,
    builtin: &[(String, String)],
    raw: &[String],
    save: cpa_exec::login_store::LoginSave,
) -> Option<i32> {
    if !host.has_triggered_command_line_flags() {
        return None;
    }
    let auth_dir = host.host_config_summary().auth_dir;
    let persist: cpa_plugin::cli::CommandAuthSave = Arc::new(move |auths| save_auths_online(auths, &auth_dir, &save));
    let (code, handled, output) = host
        .execute_command_line(
            raw.first().map(String::as_str).unwrap_or_default(),
            raw.get(1..).unwrap_or_default(),
            "",
            builtin,
            persist,
        )
        .await;
    write_output(output);
    handled.then_some(code)
}

fn write_output(output: Vec<Output>) {
    for item in output {
        let written = match item {
            Output::Stdout(data) => std::io::stdout()
                .write_all(&data)
                .and_then(|()| std::io::stdout().flush()),
            Output::Stderr(data) => std::io::stderr().write_all(&data),
        };
        if let Err(e) = written {
            tracing::warn!("pluginhost: failed to write command-line plugin output: {e}");
        }
    }
}

/// CLI plugins keep their file-based listing and raw document behavior; saves
/// acknowledge SQLite.
pub fn attach_credentials(host: &Host, db: Arc<CredentialDb>) {
    host.set_auth_manager(Some(Arc::new(CliCredentials::Owner(db))));
}

pub fn attach_online_credentials(host: &Host, root: std::path::PathBuf, save: cpa_exec::login_store::LoginSave) {
    host.set_auth_manager(Some(Arc::new(CliCredentials::Online { root, save })));
}

enum CliCredentials {
    Owner(Arc<CredentialDb>),
    Online {
        root: std::path::PathBuf,
        save: cpa_exec::login_store::LoginSave,
    },
}

impl cpa_plugin::hostauth::AuthManager for CliCredentials {
    fn manages_auths(&self) -> bool {
        false
    }

    fn list(&self) -> Vec<cpa_plugin::hostauth::HostAuth> {
        Vec::new()
    }

    fn get_by_id(&self, _: &str) -> Option<cpa_plugin::hostauth::HostAuth> {
        None
    }

    fn read_file(&self, path: &std::path::Path) -> std::io::Result<Vec<u8>> {
        match self {
            Self::Owner(db) => db
                .read(path)
                .map_err(std::io::Error::other)?
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound)),
            Self::Online { root, .. } => {
                let path = cpa_server::credential_store::credential_path_key(path)?;
                if path.parent() != Some(root.as_path()) {
                    return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
                }
                std::fs::read(path)
            }
        }
    }

    fn save(
        &self,
        auths: cpa_plugin::hostauth::SavedAuths,
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        use cpa_plugin::hostauth::SavedAuths;
        let path = match auths {
            SavedAuths::BuiltIn(auth) => {
                std::path::PathBuf::from(auth.attributes.get("path").ok_or("auth file path unavailable")?)
            }
            SavedAuths::Plugin { path, .. } | SavedAuths::Written { path, .. } => path,
        };
        match self {
            Self::Owner(backend) => backend
                .write_files(&[path], || write().map_err(anyhow::Error::msg))
                .map_err(|error| format!("commit plugin CLI credential to SQLite: {error:#}")),
            Self::Online { root, save } => {
                if path.parent() != Some(root.as_path()) {
                    return Err("online plugin target escaped its private scratch directory".into());
                }
                save(&[path], write)
            }
        }
    }

    fn lookup_session_affinity(&self, _: &str, _: &str, _: &str) -> (String, Option<cpa_plugin::hostauth::HostAuth>) {
        ("unsupported".into(), None)
    }
}

fn save_auths_online(
    auths: Vec<cpa_plugin::auth::PluginAuth>,
    auth_dir: &str,
    save: &cpa_exec::login_store::LoginSave,
) -> Result<Vec<String>, String> {
    let mut paths = auths
        .iter()
        .map(|auth| auth.file_path(auth_dir).map(std::path::PathBuf::from))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    paths.dedup();
    cpa_exec::login_store::save_login(Some(save), &paths, || {
        auths
            .into_iter()
            .map(|auth| auth.save_file(auth_dir, false))
            .collect::<Result<Vec<_>, _>>()
    })
    .map(|paths| {
        paths
            .into_iter()
            .filter_map(|path| {
                std::path::Path::new(&path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
            })
            .collect()
    })
}

fn save_auths(
    auths: Vec<cpa_plugin::auth::PluginAuth>,
    auth_dir: &str,
    backend: &CredentialDb,
) -> Result<Vec<String>, String> {
    let mut paths = auths
        .iter()
        .map(|auth| auth.file_path(auth_dir).map(std::path::PathBuf::from))
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();
    paths.dedup();
    backend
        .write_files(&paths, || {
            auths
                .into_iter()
                .map(|auth| auth.save_file(auth_dir, false).map_err(anyhow::Error::msg))
                .collect::<anyhow::Result<Vec<_>>>()
        })
        .map_err(|error| format!("commit plugin CLI credentials to SQLite: {error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_later_plugin_auth_restores_the_whole_command_batch() {
        use cpa_plugin::auth::PluginAuth;
        let dir = std::env::temp_dir().join(format!("cook-cli-plugin-batch-{}", std::process::id()));
        let path = dir.join("cook.db");
        let db = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&path).unwrap()),
            &dir.join("missing"),
        )
        .unwrap();
        let first = db.auth_dir().join("first.json");
        let old = b"{\"type\":\"acme\",\"token\":\"old\",\"unknown\":[1,2]}";
        db.save(&first, old).unwrap();
        let auths = vec![
            PluginAuth {
                provider: "acme".into(),
                id: "first".into(),
                file_name: "first.json".into(),
                metadata: [("token".into(), "new".into())].into(),
                ..Default::default()
            },
            PluginAuth {
                provider: "acme".into(),
                id: "second".into(),
                file_name: "second.json".into(),
                attributes: [("weight".into(), "invalid".into())].into(),
                ..Default::default()
            },
        ];
        assert!(save_auths(auths, db.auth_dir().to_str().unwrap(), &db).is_err());
        assert_eq!(std::fs::read(&first).unwrap(), old);
        assert_eq!(db.read(&first).unwrap().unwrap(), old);
        assert!(db.read(&db.auth_dir().join("second.json")).unwrap().is_none());
        let workspace = db.auth_dir();
        drop(db);
        std::fs::remove_dir_all(workspace).unwrap();
        let db = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&path).unwrap()),
            &dir.join("missing"),
        )
        .unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), old);
        assert!(!db.auth_dir().join("second.json").exists());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn an_invalid_later_plugin_auth_leaves_no_cli_documents() {
        use cpa_plugin::testing::scripted::{Script, host_with};
        let dir = std::env::temp_dir().join(format!("cook-cli-plugin-invalid-batch-{}", std::process::id()));
        let script = Script {
            caps: r#""command_line_plugin":true"#,
            results: [
                ("command_line.register", r#"{"Flags":[{"Name":"plugin-save","Type":"bool"}]}"#),
                ("command_line.execute", r#"{"Auths":[{"Provider":"acme","ID":"first","FileName":"first.json","Metadata":{"token":"secret"}},{"Provider":""}]}"#),
            ].into(),
            ..Default::default()
        };
        let (host, _) = host_with(&dir, [("cli", script)].into()).await;
        let db = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&dir.join("cook.db")).unwrap()),
            &dir.join("missing"),
        )
        .unwrap();
        let config = Config::parse(&format!(
            "oauth:\n  auth-dir: '{}'\nplugins:\n  enabled: true\n  dir: '{}'\n  configs:\n    cli:\n      enabled: true\n",
            db.auth_dir().display(),
            dir.display()
        ))
        .unwrap();
        host.apply_config(Arc::new(config)).await;
        host.register_command_line_flags(&|_| false).await;
        host.set_command_line_flag("plugin-save", "true").unwrap();
        assert_eq!(execute(&host, &[], &db).await, Some(1));
        assert!(db.documents().unwrap().is_empty());
        assert!(!db.auth_dir().join("first.json").exists());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn executes_only_triggered_plugin_commands_without_a_yaml_backing_file() {
        use cpa_plugin::testing::scripted::{Script, host_with};
        let dir = std::env::temp_dir().join(format!("cook-cli-plugin-{}", std::process::id()));
        let script = Script {
            caps: r#""command_line_plugin":true"#,
            results: [
                (
                    "command_line.register",
                    r#"{"Flags":[{"Name":"plugin-run","Type":"bool"}]}"#,
                ),
                ("command_line.execute", r#"{"ExitCode":17}"#),
            ]
            .into(),
            ..Default::default()
        };
        let (host, calls) = host_with(&dir, [("cli", script)].into()).await;
        let db = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&dir.join("cook.db")).unwrap()),
            &dir.join("missing"),
        )
        .unwrap();
        let config = Config::parse(&format!(
            "oauth:\n  auth-dir: '{}'\nplugins:\n  enabled: true\n  dir: '{}'\n  configs:\n    cli:\n      enabled: true\n",
            db.auth_dir().display(),
            dir.display()
        ))
        .unwrap();
        host.apply_config(Arc::new(config)).await;
        host.register_command_line_flags(&|_| false).await;
        assert_eq!(execute(&host, &[], &db).await, None);
        host.set_command_line_flag("plugin-run", "true").unwrap();
        assert_eq!(execute(&host, &[], &db).await, Some(17));
        assert!(
            calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call == "cli command_line.execute")
        );
        assert!(!dir.join("config.yaml").exists());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn plugin_explicit_path_survives_reopen_and_sqlite_failure_exits_nonzero() {
        use cpa_plugin::testing::scripted::{Script, host_with};
        let dir = std::env::temp_dir().join(format!("cook-cli-plugin-durable-{}", std::process::id()));
        let path = dir.join("cook.db");
        let script = Script {
            caps: r#""command_line_plugin":true"#,
            results: [
                ("command_line.register", r#"{"Flags":[{"Name":"plugin-save","Type":"bool"}]}"#),
                ("command_line.execute", r#"{"Auths":[{"Provider":"acme","ID":"explicit","FileName":"../explicit.token","Metadata":{"token":"secret","unknown":[1,2]}}]}"#),
            ].into(),
            ..Default::default()
        };
        let (host, _) = host_with(&dir, [("cli", script)].into()).await;
        let db = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&path).unwrap()),
            &dir.join("missing"),
        )
        .unwrap();
        use cpa_plugin::hostauth::{AuthManager as _, SavedAuths};
        let nested = db.auth_dir().join("nested.json");
        let raw = b"{\"type\":\"acme\",\"opaque\":[1,2]}";
        CliCredentials::Owner(db.clone())
            .save(
                SavedAuths::Written {
                    path: nested.clone(),
                    data: raw.to_vec(),
                },
                &mut || std::fs::write(&nested, raw).map_err(|error| error.to_string()),
            )
            .unwrap();
        assert_eq!(db.read(&nested).unwrap().unwrap(), raw);
        let config = Config::parse(&format!(
            "oauth:\n  auth-dir: '{}'\nplugins:\n  enabled: true\n  dir: '{}'\n  configs:\n    cli:\n      enabled: true\n",
            db.auth_dir().display(),
            dir.display()
        ))
        .unwrap();
        host.apply_config(Arc::new(config)).await;
        host.register_command_line_flags(&|_| false).await;
        host.set_command_line_flag("plugin-save", "true").unwrap();
        assert_eq!(execute(&host, &[], &db).await, Some(0));
        let explicit = dir.join("explicit.token");
        let bytes = std::fs::read(&explicit).unwrap();
        assert_eq!(db.read(&explicit).unwrap().unwrap(), bytes);
        let workspace = db.auth_dir();
        drop(db);
        std::fs::remove_file(&explicit).unwrap();
        std::fs::remove_dir_all(&workspace).unwrap();
        let owner = Arc::new(cpa_server::testing::config_store(&path).unwrap());
        let db = CredentialDb::initialize(owner.clone(), &dir.join("missing")).unwrap();
        assert_eq!(std::fs::read(&explicit).unwrap(), bytes);
        let mut previous: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        previous["token"] = "before-failed-save".into();
        let previous = serde_json::to_vec(&previous).unwrap();
        db.save(&explicit, &previous).unwrap();
        let blocker = cpa_server::testing::block_checkpoint_install(&owner);
        let code = execute(&host, &[], &db).await;
        drop(blocker);
        assert_eq!(code, Some(1));
        assert_eq!(db.read(&explicit).unwrap().unwrap(), previous);
        assert_eq!(std::fs::read(&explicit).unwrap(), previous);
        drop((db, owner));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
