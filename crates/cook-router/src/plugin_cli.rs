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
use cpa_server::runtime::CredentialAuthority;

/// Plugin-declared flags as Go's `flag` package sees them: a `flag.Value` looked up by
/// name, `IsBoolFlag` for bools, and `Set` called for every occurrence as it is parsed.
pub trait PluginFlags {
    /// `Some(is_bool)` for a plugin flag.
    fn lookup(&self, name: &str) -> Option<bool>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
}

/// No plugin flags (the `discover` subcommand, and Go's discover mode).
impl PluginFlags for () {
    fn lookup(&self, _: &str) -> Option<bool> {
        None
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

impl PluginFlags for Host {
    fn lookup(&self, name: &str) -> Option<bool> {
        self.command_line_flag(name).map(|f| f.kind == "bool")
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.set_command_line_flag(name, value)
    }
}

/// Loads plugins from the bootstrap config and registers their flags. `builtin` says
/// whether the binary already has a flag of that name. Returns the host and the flags
/// it accepted.
pub async fn bootstrap(cfg: Config, builtin: &dyn Fn(&str) -> bool) -> (Host, Vec<CliFlag>) {
    let host = Host::new();
    host.apply_config(Arc::new(cfg)).await;
    let flags = host.register_command_line_flags(builtin).await;
    (host, flags)
}

/// The command with the plugin flags added, so `-h` lists them as Go's usage does.
/// Parsing never reaches clap for them (the flag rewrite consumes them first).
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
pub async fn execute(host: &Host, builtin: &[(String, String)], backend: &CredentialAuthority) -> Option<i32> {
    if !host.has_triggered_command_line_flags() {
        return None;
    }
    let raw: Vec<String> = std::env::args().collect();
    let program = raw.first().cloned().unwrap_or_default();
    let auth_dir = host.host_config_summary().auth_dir;
    let home_rejected = std::sync::atomic::AtomicBool::new(false);
    let persist = |auths: Vec<cpa_plugin::auth::PluginAuth>| {
        let CredentialAuthority::Local(backend) = backend else {
            if auths.is_empty() {
                return Ok(Vec::new());
            }
            home_rejected.store(true, std::sync::atomic::Ordering::Relaxed);
            return Err(HOME_CREDENTIAL_ERROR.into());
        };
        save_auths(auths, &auth_dir, backend)
    };
    let (code, handled, mut output) = host
        .execute_command_line(
            &program,
            raw.get(1..).unwrap_or_default(),
            // SQLite has no YAML backing file. The host summary and config callbacks
            // remain authoritative; an empty optional ConfigPath advertises no file.
            "",
            builtin,
            &persist,
        )
        .await;
    if home_rejected.load(std::sync::atomic::Ordering::Relaxed) {
        output.push(Output::Stderr(format!("{HOME_CREDENTIAL_ERROR}\n").into()));
    }
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
    handled.then_some(code)
}

pub const HOME_CREDENTIAL_ERROR: &str =
    "Home owns credentials; run without a Home JWT against a local --db to log in or import credentials";

/// CLI plugins keep their file-based listing and raw document behavior; saves
/// acknowledge SQLite. Home commands may run but cannot save local credentials.
pub fn attach_credentials(host: &Host, authority: CredentialAuthority) {
    host.set_auth_manager(Some(Arc::new(CliCredentials(authority))));
}

struct CliCredentials(CredentialAuthority);

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
        match &self.0 {
            CredentialAuthority::Local(db) => db
                .read(path)
                .map_err(std::io::Error::other)?
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound)),
            CredentialAuthority::Home => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
        }
    }

    fn save(
        &self,
        auths: cpa_plugin::hostauth::SavedAuths,
        write: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        use cpa_plugin::hostauth::SavedAuths;
        let CredentialAuthority::Local(backend) = &self.0 else {
            return Err(HOME_CREDENTIAL_ERROR.into());
        };
        let path = match auths {
            SavedAuths::BuiltIn(auth) => {
                std::path::PathBuf::from(auth.attributes.get("path").ok_or("auth file path unavailable")?)
            }
            SavedAuths::Plugin { path, .. } | SavedAuths::Written { path, .. } => path,
        };
        backend
            .write_files(&[path], || write().map_err(anyhow::Error::msg))
            .map_err(|error| format!("commit plugin CLI credential to SQLite: {error:#}"))
    }

    fn lookup_session_affinity(&self, _: &str, _: &str, _: &str) -> (String, Option<cpa_plugin::hostauth::HostAuth>) {
        ("unsupported".into(), None)
    }
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
    fn home_cli_rejects_host_saves_before_writing() {
        use cpa_plugin::hostauth::{AuthManager as _, SavedAuths};
        let mut called = false;
        let error = CliCredentials(CredentialAuthority::Home)
            .save(
                SavedAuths::Written {
                    path: "unused.json".into(),
                    data: b"{}".to_vec(),
                },
                &mut || {
                    called = true;
                    Ok(())
                },
            )
            .unwrap_err();
        assert!(!called);
        assert_eq!(error, HOME_CREDENTIAL_ERROR);
    }

    #[tokio::test]
    async fn home_cli_rejects_plugin_auth_results_before_writing() {
        use cpa_plugin::testing::scripted::{Script, host_with};
        let dir = std::env::temp_dir().join(format!("cook-cli-plugin-home-{}", std::process::id()));
        let script = Script {
            caps: r#""command_line_plugin":true"#,
            results: [
                ("command_line.register", r#"{"Flags":[{"Name":"plugin-save","Type":"bool"}]}"#),
                ("command_line.execute", r#"{"Auths":[{"Provider":"acme","ID":"first","FileName":"first.json","Metadata":{"token":"secret"}}]}"#),
            ].into(),
            ..Default::default()
        };
        let (host, _) = host_with(&dir, [("cli", script)].into()).await;
        let auth_dir = dir.join("auth");
        let config = Config::parse(&format!(
            "auth-dir: '{}'\nplugins:\n  enabled: true\n  dir: '{}'\n  configs:\n    cli:\n      enabled: true\n",
            auth_dir.display(),
            dir.display()
        ))
        .unwrap();
        attach_credentials(&host, CredentialAuthority::Home);
        host.apply_config(Arc::new(config)).await;
        host.register_command_line_flags(&|_| false).await;
        host.set_command_line_flag("plugin-save", "true").unwrap();
        assert_eq!(execute(&host, &[], &CredentialAuthority::Home).await, Some(1));
        assert!(!auth_dir.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_later_plugin_auth_restores_the_whole_command_batch() {
        use cpa_plugin::auth::PluginAuth;
        use cpa_server::config_store::ConfigStore;
        let dir = std::env::temp_dir().join(format!("cook-cli-plugin-batch-{}", std::process::id()));
        let path = dir.join("cook.db");
        let db = CredentialDb::initialize(Arc::new(ConfigStore::open(&path).unwrap()), &dir.join("missing")).unwrap();
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
        let db = CredentialDb::initialize(Arc::new(ConfigStore::open(&path).unwrap()), &dir.join("missing")).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), old);
        assert!(!db.auth_dir().join("second.json").exists());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn an_invalid_later_plugin_auth_leaves_no_cli_documents() {
        use cpa_plugin::testing::scripted::{Script, host_with};
        use cpa_server::config_store::ConfigStore;
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
            Arc::new(ConfigStore::open(&dir.join("cook.db")).unwrap()),
            &dir.join("missing"),
        )
        .unwrap();
        let config = Config::parse(&format!(
            "auth-dir: '{}'\nplugins:\n  enabled: true\n  dir: '{}'\n  configs:\n    cli:\n      enabled: true\n",
            db.auth_dir().display(),
            dir.display()
        ))
        .unwrap();
        host.apply_config(Arc::new(config)).await;
        host.register_command_line_flags(&|_| false).await;
        host.set_command_line_flag("plugin-save", "true").unwrap();
        assert_eq!(
            execute(&host, &[], &CredentialAuthority::Local(db.clone())).await,
            Some(1)
        );
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
        let config = Config::parse(&format!(
            "auth-dir: '{}'\nplugins:\n  enabled: true\n  dir: '{}'\n  configs:\n    cli:\n      enabled: true\n",
            dir.join("auth").display(),
            dir.display()
        ))
        .unwrap();
        host.apply_config(Arc::new(config)).await;
        host.register_command_line_flags(&|_| false).await;
        assert_eq!(execute(&host, &[], &CredentialAuthority::Home).await, None);
        host.set_command_line_flag("plugin-run", "true").unwrap();
        assert_eq!(execute(&host, &[], &CredentialAuthority::Home).await, Some(17));
        assert!(
            calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call == "cli command_line.execute")
        );
        assert!(!dir.join("config.yaml").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn plugin_explicit_path_survives_reopen_and_sqlite_failure_exits_nonzero() {
        use cpa_plugin::testing::scripted::{Script, host_with};
        use cpa_server::config_store::ConfigStore;
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
        let db = CredentialDb::initialize(Arc::new(ConfigStore::open(&path).unwrap()), &dir.join("missing")).unwrap();
        use cpa_plugin::hostauth::{AuthManager as _, SavedAuths};
        let nested = db.auth_dir().join("nested.json");
        let raw = b"{\"type\":\"acme\",\"opaque\":[1,2]}";
        CliCredentials(CredentialAuthority::Local(db.clone()))
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
            "auth-dir: '{}'\nplugins:\n  enabled: true\n  dir: '{}'\n  configs:\n    cli:\n      enabled: true\n",
            db.auth_dir().display(),
            dir.display()
        ))
        .unwrap();
        host.apply_config(Arc::new(config)).await;
        host.register_command_line_flags(&|_| false).await;
        host.set_command_line_flag("plugin-save", "true").unwrap();
        assert_eq!(
            execute(&host, &[], &CredentialAuthority::Local(db.clone())).await,
            Some(0)
        );
        let explicit = dir.join("explicit.token");
        let bytes = std::fs::read(&explicit).unwrap();
        assert_eq!(db.read(&explicit).unwrap().unwrap(), bytes);
        let workspace = db.auth_dir();
        drop(db);
        std::fs::remove_file(&explicit).unwrap();
        std::fs::remove_dir_all(&workspace).unwrap();
        let db = CredentialDb::initialize(Arc::new(ConfigStore::open(&path).unwrap()), &dir.join("missing")).unwrap();
        assert_eq!(std::fs::read(&explicit).unwrap(), bytes);
        let blocker = ConfigStore::open(&path).unwrap();
        let (locked, acquired) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            blocker
                .edit("test", "hold write transaction", |_| {
                    locked.send(()).unwrap();
                    released.recv().unwrap();
                    Ok(())
                })
                .unwrap()
        });
        acquired.recv().unwrap();
        let code = execute(&host, &[], &CredentialAuthority::Local(db.clone())).await;
        release.send(()).unwrap();
        writer.join().unwrap();
        assert_eq!(code, Some(1));
        assert_eq!(db.read(&explicit).unwrap().unwrap(), bytes);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
