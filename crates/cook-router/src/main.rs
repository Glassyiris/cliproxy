mod config_cli;
mod discovery;
mod dotenv;
mod home;
mod home_plugins;
mod plugin_cli;
mod tui;

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::{ArgAction, CommandFactory, FromArgMatches, Parser};
use cpa_core::config::Config;
use cpa_exec::Executors;
use cpa_exec::claude::{ClaudeExecutor, DEFAULT_BASE_URL};
use cpa_server::Runtime;
use cpa_server::config_store::ConfigStore;
use cpa_server::credential_store::CredentialDb;
use cpa_server::listener::bind;
use cpa_server::runtime::CredentialAuthority;

/// Same strings as the management `X-CPA-*` headers.
const VERSION: &str = concat!("cook-router-", env!("CARGO_PKG_VERSION"));
const COMMIT: &str = match option_env!("CPA_COMMIT") {
    Some(v) => v,
    None => "none",
};
const BUILD_DATE: &str = match option_env!("CPA_BUILD_DATE") {
    Some(v) => v,
    None => "unknown",
};

fn banner() -> String {
    format!("CLIProxyAPI Version: {VERSION}, Commit: {COMMIT}, BuiltAt: {BUILD_DATE}")
}

/// Flags mirror CLIProxyAPI. Go's single-dash long flags (`-config`) are accepted.
#[derive(Parser)]
#[command(
    version,
    about,
    after_help = "Config commands: config import FILE | config export [--secrets] [-o FILE] | config validate [FILE] | config backup FILE | config listener\nUse config --help for details."
)]
struct Args {
    /// The config file a first start imports into the config database (default
    /// ./config.yaml); later starts do not read it.
    #[arg(long, default_value = "")]
    config: String,
    /// The config database (default: cook.db beside the config file, or COOK_DB).
    #[arg(long, default_value = "")]
    db: String,
    /// Write process logs to this file (10 MiB rotation), without a shell wrapper.
    #[arg(long)]
    log_file: Option<PathBuf>,
    /// Change to this directory first, before reading .env, plugins or relative paths.
    #[arg(long)]
    working_dir: Option<PathBuf>,
    /// Log in to Claude using browser OAuth and PKCE.
    #[arg(long)]
    claude_login: bool,
    /// Login to Codex using OAuth
    #[arg(long)]
    codex_login: bool,
    /// Login to Codex using device code flow
    #[arg(long)]
    codex_device_login: bool,
    /// Don't open browser automatically for OAuth
    #[arg(long)]
    no_browser: bool,
    /// Override OAuth callback port (defaults to provider-specific port)
    #[arg(long, default_value_t = 0)]
    oauth_callback_port: u16,
    /// Login to Antigravity using OAuth
    #[arg(long)]
    antigravity_login: bool,
    /// Login to Kimi (.com) using OAuth
    #[arg(long)]
    kimi_login: bool,
    /// Login to Kimi.ai using OAuth
    #[arg(long)]
    kimi_ai_login: bool,
    /// Login to xAI using OAuth
    #[arg(long)]
    xai_login: bool,
    /// Login to Devin using OAuth
    #[arg(long)]
    devin_login: bool,
    /// Login to Meta using OAuth
    #[arg(long)]
    meta_login: bool,
    /// Discover local AI gateways and CPA instances on the LAN
    #[arg(long)]
    discover: bool,
    /// Timeout in seconds for LAN discovery (default 3s)
    #[arg(long, default_value_t = 3, value_parser = go_int)]
    discover_timeout: i64,
    /// Output discovered gateways in JSON format
    #[arg(long)]
    discover_json: bool,
    /// DNS-SD service type for LAN discovery (default _ai-gateway._tcp)
    #[arg(long, default_value = "")]
    discover_service_type: String,
    /// Comma-separated interface names to scan during LAN discovery
    #[arg(long, action = ArgAction::Append)]
    discover_include: Vec<String>,
    /// Comma-separated interface names to skip during LAN discovery
    #[arg(long, action = ArgAction::Append)]
    discover_exclude: Vec<String>,
    /// Import Vertex service account key JSON file
    #[arg(long, default_value = "")]
    vertex_import: String,
    /// Prefix for Vertex model namespacing (use with -vertex-import)
    #[arg(long, default_value = "")]
    vertex_import_prefix: String,
    /// Bind Sign in with ChatGPT (SIWC) credentials to a Codex credential file
    #[arg(long, default_value = "")]
    siwc_bind: String,
    /// Management password accepted from loopback clients only.
    #[arg(long, hide = true, default_value = "")]
    password: String,
    /// Home control plane JWT for mTLS certificate bootstrap and connection
    #[arg(long, default_value = "")]
    home_jwt: String,
    /// Disable Home CLUSTER NODES discovery and keep using the configured -home-jwt address
    #[arg(long)]
    home_disable_cluster_discovery: bool,
    /// Start with terminal management UI
    #[arg(long)]
    tui: bool,
    /// In TUI mode, start an embedded local server
    #[arg(long)]
    standalone: bool,
    /// Base URL of remote management API for TUI client mode (e.g. https://proxy.example.com)
    #[arg(long, default_value = "")]
    management_base_url: String,
    /// Use embedded models.json and codex_client_models.json only, skip remote model catalog fetching
    #[arg(long)]
    local_model: bool,
}

/// Go's `discover` subcommand flag set.
#[derive(Parser)]
#[command(name = "discover")]
struct DiscoverArgs {
    /// Discovery timeout in seconds
    #[arg(long, default_value_t = 3, value_parser = go_int)]
    timeout: i64,
    /// Output in JSON format
    #[arg(long)]
    json: bool,
    /// DNS-SD service type (default _ai-gateway._tcp)
    #[arg(long, default_value = "")]
    service_type: String,
    /// Configure File Path
    #[arg(long, default_value = "")]
    config: String,
    /// Comma-separated interface names to scan (overrides default physical LAN filter)
    #[arg(long, action = ArgAction::Append)]
    include: Vec<String>,
    /// Comma-separated interface names to skip
    #[arg(long, action = ArgAction::Append)]
    exclude: Vec<String>,
}

/// Rewrites a command line parsed by Go's `flag` package into clap's form. Go decides
/// which token is a value (a non-boolean flag takes the next token even when it starts
/// with `-`), booleans accept `=value`, a repeated scalar keeps its last value, and
/// parsing stops at the first operand or `--`; Go ignores everything after that.
/// Unknown or malformed flags are passed on for clap to report. Plugin flags are set
/// on `plugins` as they are parsed; a value they reject is Go's parse error.
fn go_flags(
    cmd: &clap::Command,
    args: impl IntoIterator<Item = String>,
    plugins: &dyn plugin_cli::PluginFlags,
) -> Result<Vec<String>, String> {
    let mut args = args.into_iter();
    let mut out: Vec<String> = args.next().into_iter().collect();
    let args: Vec<String> = args.collect();
    let mut bools: Vec<(String, bool)> = Vec::new();
    let mut scalars: Vec<(String, String)> = Vec::new();
    let mut appended: Vec<String> = Vec::new();
    let mut tail = None;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if arg == "--" || arg.len() < 2 || !arg.starts_with('-') {
            break;
        }
        let bare = arg.strip_prefix("--").unwrap_or(&arg[1..]);
        let (name, value) = match bare.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (bare, None),
        };
        // Go's FlagSet holds the plugin flags beside the built-in ones (names never
        // clash: registration skips taken names).
        if let Some(is_bool) = plugins
            .lookup(name)
            .filter(|_| !name.is_empty() && !name.starts_with(['-', '=']))
        {
            let quote = cpa_common::gostr::quote;
            if is_bool {
                match value {
                    None => plugins
                        .set(name, "true")
                        .map_err(|e| format!("invalid boolean flag {name}: {e}"))?,
                    Some(v) => plugins
                        .set(name, v)
                        .map_err(|e| format!("invalid boolean value {} for -{name}: {e}", quote(v)))?,
                }
                continue;
            }
            let value = match value {
                Some(v) => v.to_owned(),
                None if i < args.len() => {
                    i += 1;
                    args[i - 1].clone()
                }
                None => return Err(format!("flag needs an argument: -{name}")),
            };
            plugins
                .set(name, &value)
                .map_err(|e| format!("invalid value {} for flag -{name}: {e}", quote(&value)))?;
            continue;
        }
        let known = cmd.get_arguments().find(|a| a.get_long() == Some(name));
        let Some(flag) = known.filter(|_| !name.is_empty() && !name.starts_with(['-', '='])) else {
            tail = Some(match name {
                "h" | "help" => "--help".to_owned(),
                "V" | "version" => "--version".to_owned(),
                _ => format!("--{bare}"),
            });
            break;
        };
        if !flag.get_action().takes_values() {
            match value.map(go_parse_bool) {
                None => upsert(&mut bools, name, true),
                Some(Some(b)) => upsert(&mut bools, name, b),
                Some(None) => {
                    tail = Some(format!("--{bare}"));
                    break;
                }
            }
            continue;
        }
        let value = match value {
            Some(v) => v.to_owned(),
            None if i < args.len() => {
                i += 1;
                args[i - 1].clone()
            }
            None => {
                tail = Some(format!("--{name}"));
                break;
            }
        };
        if matches!(flag.get_action(), ArgAction::Append) {
            appended.push(format!("--{name}={value}"));
        } else {
            upsert(&mut scalars, name, value);
        }
    }
    out.extend(bools.into_iter().filter(|(_, on)| *on).map(|(n, _)| format!("--{n}")));
    out.extend(scalars.into_iter().map(|(n, v)| format!("--{n}={v}")));
    out.extend(appended);
    out.extend(tail);
    Ok(out)
}

fn upsert<T>(list: &mut Vec<(String, T)>, name: &str, value: T) {
    match list.iter_mut().find(|(n, _)| n == name) {
        Some(slot) => slot.1 = value,
        None => list.push((name.to_owned(), value)),
    }
}

/// Go `strconv.ParseInt(s, 0, 64)`, as `flag.Int` parses: sign, `0x`/`0o`/`0b`/`0`
/// prefixes and digit-separating underscores.
fn go_int(s: &str) -> Result<i64, String> {
    let err = || format!("invalid value {s:?}: parse error");
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let lower = digits.to_ascii_lowercase();
    // A base prefix (or the leading 0 of an octal literal) counts as a digit before an
    // underscore, as in strconv's underscoreOK.
    let (radix, body, prefixed) = match lower.as_bytes() {
        [b'0', b'x', ..] => (16, &lower[2..], true),
        [b'0', b'o', ..] => (8, &lower[2..], true),
        [b'0', b'b', ..] => (2, &lower[2..], true),
        [b'0', _, ..] => (8, &lower[1..], true),
        _ => (10, lower.as_str(), false),
    };
    if body.is_empty() || (body.starts_with('_') && !prefixed) || body.ends_with('_') || body.contains("__") {
        return Err(err());
    }
    let magnitude = i128::from_str_radix(&body.replace('_', ""), radix).map_err(|_| err())?;
    i64::try_from(if neg { -magnitude } else { magnitude }).map_err(|_| err())
}

/// Go `strconv.ParseBool`.
fn go_parse_bool(v: &str) -> Option<bool> {
    match v {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

/// Go `argvEnablesBoolFlag`: a pre-parse scan (stops at the first non-flag) used to
/// keep stdout clean for `--discover-json`.
fn argv_enables_bool_flag(args: &[String], name: &str) -> bool {
    const BOOL_FLAGS: [&str; 16] = [
        "codex-login",
        "codex-device-login",
        "claude-login",
        "no-browser",
        "antigravity-login",
        "kimi-login",
        "kimi-ai-login",
        "xai-login",
        "devin-login",
        "meta-login",
        "discover",
        "discover-json",
        "home-disable-cluster-discovery",
        "tui",
        "standalone",
        "local-model",
    ];
    let mut enabled = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" || arg == "-" || !arg.starts_with('-') {
            break;
        }
        let bare = arg.strip_prefix('-').unwrap_or(arg);
        let bare = bare.strip_prefix('-').unwrap_or(bare);
        let (flag, value) = match bare.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (bare, None),
        };
        if flag == name {
            match value {
                None => enabled = true,
                Some(v) => enabled = go_parse_bool(v).unwrap_or(enabled),
            }
        }
        if value.is_none()
            && !flag.is_empty()
            && !BOOL_FLAGS.contains(&flag)
            && args
                .get(i + 1)
                .is_some_and(|n| n != "--" && (builtin_flag(flag) || !is_discover_flag(n)))
        {
            i += 1;
        }
        i += 1;
    }
    enabled
}

/// The value of the built-in flag `wanted` (`-flag V`, `--flag V`, `-flag=V`,
/// `--flag=V`; the last one wins), read from the raw arguments for what must happen
/// before the parse: `-working-dir` changes the directory before `.env`, the plugin
/// bootstrap or any relative path is read, and `-log-file` opens before the runtime
/// starts. Like Go's parse it stops at the first operand or `--`, and built-in value
/// flags take the next token. A flag the binary does not define may be a plugin flag:
/// it is read as taking the next token unless that token is a flag; the full parse
/// confirms the result.
fn prescan_value(args: &[String], wanted: &str) -> Option<String> {
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if arg == "--" || arg.len() < 2 || !arg.starts_with('-') {
            break;
        }
        let bare = arg.strip_prefix("--").unwrap_or(&arg[1..]);
        let (name, value) = match bare.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (bare, None),
        };
        if value.is_some() {
            if name == wanted {
                found = value.map(str::to_owned);
            }
            continue;
        }
        let Some(next) = args.get(i) else { break };
        let takes_value = match Args::command().get_arguments().find(|a| a.get_long() == Some(name)) {
            Some(flag) => flag.get_action().takes_values(),
            None => !next.starts_with('-'),
        };
        if takes_value {
            if name == wanted {
                found = Some(next.clone());
            }
            i += 1;
        }
    }
    found
}

/// Whether the binary itself defines `name` (plugin flags are only known once the
/// plugins have loaded).
fn builtin_flag(name: &str) -> bool {
    static NAMES: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| {
        Args::command()
            .get_arguments()
            .filter_map(|a| a.get_long().map(str::to_owned))
            .collect()
    });
    NAMES.iter().any(|n| n == name)
}

/// `-discover` or `-discover-json`, with one or two dashes and an optional value.
fn is_discover_flag(arg: &str) -> bool {
    let Some(bare) = arg.strip_prefix('-') else {
        return false;
    };
    let bare = bare.strip_prefix('-').unwrap_or(bare);
    let flag = bare.split_once('=').map_or(bare, |(f, _)| f);
    matches!(flag, "discover" | "discover-json")
}

/// In discover mode no plugin loads, so the parse accepts exactly the flags the
/// pre-scan read as boolean plugin flags (an undefined flag right before
/// `-discover` or `-discover-json`) and ignores them.
struct PrescanBools(Vec<String>);

impl PrescanBools {
    fn from_args(args: &[String]) -> Self {
        let names = args
            .iter()
            .zip(args.iter().skip(1))
            .take_while(|(arg, _)| *arg != "--")
            .filter(|(_, next)| is_discover_flag(next))
            .filter_map(|(arg, _)| {
                let bare = arg.strip_prefix('-')?;
                let bare = bare.strip_prefix('-').unwrap_or(bare);
                (!bare.is_empty() && !bare.contains('=') && !builtin_flag(bare)).then(|| bare.to_owned())
            })
            .collect();
        Self(names)
    }
}

impl plugin_cli::PluginFlags for PrescanBools {
    fn lookup(&self, name: &str) -> Option<bool> {
        self.0.iter().any(|n| n == name).then_some(true)
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Go's `appendCSV` flag function: each occurrence is split and appended.
fn csv_flags(values: &[String]) -> Vec<String> {
    values
        .iter()
        .flat_map(|v| discovery::cli::parse_interface_list(std::slice::from_ref(v)))
        .collect()
}

fn discover_options(
    timeout: i64,
    json: bool,
    service_type: String,
    config: &str,
    cli: (Vec<String>, Vec<String>),
) -> discovery::cli::Options {
    // CLI filters replace the file's, as in Go, so only an unfiltered scan needs them.
    let file = if cli.0.is_empty() && cli.1.is_empty() {
        discovery::cli::load_scan_filters(config).unwrap_or_else(|e| {
            eprintln!("{e}");
            std::process::exit(1)
        })
    } else {
        Default::default()
    };
    let (include, exclude) = discovery::cli::resolve_filters(cli, file);
    discovery::cli::Options {
        timeout: Duration::from_secs(timeout.clamp(0, 3600) as u64),
        json,
        service_type,
        include,
        exclude,
    }
}

/// A personal proxy spends its time waiting on upstreams, so two workers serve hundreds
/// of requests per second, and each extra worker can hold its own glibc arena. The
/// blocking pool keeps tokio's default ceiling (512): its threads start on demand and
/// exit after 10 idle seconds, and a native plugin call holds one for the whole call
/// while its HTTP callbacks need others (DNS), so a low ceiling could deadlock.
fn runtime(config: Option<&Config>) -> io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads(config))
        .enable_all()
        .build()
}

/// `TOKIO_WORKER_THREADS`, else `worker-threads` in `config` (read once at start), else
/// the smaller of the CPU count and 2.
fn worker_threads(config: Option<&Config>) -> usize {
    let positive = |n: u64| usize::try_from(n).ok().filter(|n| *n > 0);
    if let Ok(raw) = std::env::var("TOKIO_WORKER_THREADS") {
        match raw.trim().parse().ok().and_then(positive) {
            Some(n) => return n,
            None => tracing::warn!("ignoring TOKIO_WORKER_THREADS={raw:?}: not a positive number"),
        }
    }
    let configured = config
        .and_then(|c| c.document.get("worker-threads")?.as_u64())
        .and_then(positive);
    configured.unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get().min(2)))
}

/// Waits for Ctrl+C or SIGTERM, Go's `signal.NotifyContext(SIGINT, SIGTERM)`.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler installs");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// The config database: `--db`, else `COOK_DB`, else `cook.db` beside the config file.
fn db_path(flag: &str, config_file: &Path) -> PathBuf {
    if !flag.trim().is_empty() {
        return PathBuf::from(flag);
    }
    if let Some(env) = std::env::var_os("COOK_DB").filter(|v| !v.is_empty()) {
        return PathBuf::from(env);
    }
    config_file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .join("cook.db")
}

/// Opens the one config authority and imports YAML only before its first revision.
/// Cloud and Home may initialize an empty config when the import file is absent or
/// blank (Go `LoadConfigOptional`). A missing import fails before a new database file
/// is created.
fn load_config(db: &Path, config_file: &Path, optional: bool) -> anyhow::Result<(Arc<ConfigStore>, Config)> {
    let read_import = || match std::fs::read_to_string(config_file) {
        Ok(text) if optional && text.trim().is_empty() => Ok(String::new()),
        Ok(text) => Ok(text),
        Err(e) if optional && e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e).with_context(|| format!("read first config import {}", config_file.display())),
    };
    let mut text = if db.exists() { None } else { Some(read_import()?) };
    let store = Arc::new(ConfigStore::open(db)?);
    if store.is_empty()? {
        let text = match text.take() {
            Some(text) => text,
            None => read_import()?,
        };
        let done = store
            .import_yaml(&text, "import", &format!("import {}", config_file.display()))
            .with_context(|| format!("import config {} into {}", config_file.display(), db.display()))?;
        tracing::info!(
            revision = done.rev,
            "initialized config database {}; later starts do not read YAML",
            db.display()
        );
    }
    let loaded = store
        .load()
        .map_err(|e| anyhow::anyhow!("load config database {}: {e}", db.display()))?;
    Ok((store, loaded.config))
}

/// The settings that selected a remote config store before SQLite, upper and lower case.
const REMOTE_STORE_KEYS: [&str; 6] = [
    "PGSTORE_DSN",
    "pgstore_dsn",
    "OBJECTSTORE_ENDPOINT",
    "objectstore_endpoint",
    "GITSTORE_GIT_URL",
    "gitstore_git_url",
];

fn reject_remote_store(env: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<()> {
    anyhow::ensure!(
        !REMOTE_STORE_KEYS
            .iter()
            .any(|key| env(key).is_some_and(|v| !v.trim().is_empty())),
        "PGSTORE/OBJECTSTORE/GITSTORE live storage is no longer supported. Export the old config with the previous release and import it with cook-router --db PATH config import FILE, migrate auths, then remove the remote-store environment variables. SQLite is the durable authority; mount a persistent volume for --db or COOK_DB in ephemeral containers. Remote data has not been changed."
    );
    Ok(())
}

/// Home owns runtime settings; only explicitly configured local listener settings
/// replace its listener. The bootstrap's normalized Home port remains the default.
fn home_listener_config(remote: Config, local: &Config) -> anyhow::Result<Config> {
    let mut doc = remote.document.clone();
    if let Some(server) = local.document.get("server") {
        for key in ["host", "port", "tls"] {
            if let Some(value) = server.get(key) {
                doc["server"][key] = value.clone();
            }
        }
    }
    if let Some(value) = local.document.get("worker-threads") {
        doc["worker-threads"] = value.clone();
    }
    let text = cpa_core::config::yaml_string(&doc)?;
    let base = Config::parse(&text)?;
    let mut config = home::overlay(text.as_bytes(), Some(&base))?;
    config.plugin_configs = remote.plugin_configs;
    Ok(config)
}

/// Go's cloud-deploy check, of the config database.
fn cloud_config_present(store: &ConfigStore, config: &Config) -> bool {
    let (present, message) = if store.is_empty().unwrap_or(true) {
        (
            false,
            "Cloud deploy mode: No configuration detected; standing by for configuration",
        )
    } else if config.port == 0 {
        (
            false,
            "Cloud deploy mode: Configuration is empty or invalid; standing by for valid configuration",
        )
    } else {
        (true, "Cloud deploy mode: Configuration detected; starting service")
    };
    tracing::info!("{message}");
    present
}

/// Go `cmd.WaitForCloudDeploy`.
async fn wait_for_cloud_deploy() {
    tracing::info!(
        "Cloud deploy mode: No config found; standing by for configuration. API server is not started. Press Ctrl+C to exit."
    );
    shutdown_signal().await;
    tracing::info!("Cloud deploy mode: Shutdown signal received; exiting");
}

/// Go `flag.ExitOnError` after a parse error: the message, the usage, exit 2.
fn flag_error(cmd: &mut clap::Command, message: &str) -> ! {
    eprintln!("{message}");
    eprint!("{}", cmd.render_help());
    std::process::exit(2);
}

fn main() -> anyhow::Result<()> {
    cpa_server::logging::init();
    let raw: Vec<String> = std::env::args().collect();
    if config_cli::is_command(&raw[1..]) {
        return config_cli::execute(raw);
    }
    // First, so .env, plugins, the default config and relative paths resolve there.
    let working_dir = prescan_value(&raw[1..], "working-dir");
    if let Some(dir) = &working_dir {
        std::env::set_current_dir(dir).with_context(|| format!("change to working directory {dir:?}"))?;
    }
    // Next, relative to that directory, so every line from here on reaches the file:
    // sizing the runtime can warn, and stdout may be hidden (the Windows Run entry).
    // An empty value is left for the parse to reject.
    let log_file = prescan_value(&raw[1..], "log-file");
    if let Some(path) = log_file.as_deref().filter(|p| !p.is_empty()) {
        cpa_server::logging::set_log_file(path.into()).context("open process log")?;
    }
    if raw.get(1).map(String::as_str) == Some("discover") {
        let flags = go_flags(&DiscoverArgs::command(), raw.into_iter().skip(1), &())
            .unwrap_or_else(|e| flag_error(&mut DiscoverArgs::command(), &e));
        let args = DiscoverArgs::parse_from(flags);
        if !args.json {
            eprintln!("{}", banner());
        }
        let cli = (csv_flags(&args.include), csv_flags(&args.exclude));
        let opts = discover_options(args.timeout, args.json, args.service_type, &args.config, cli);
        std::process::exit(runtime(None)?.block_on(discovery::cli::discover(&opts)));
    }
    if !argv_enables_bool_flag(&raw[1..], "discover-json") {
        println!("{}", banner());
    }
    // Go `isDiscoverMode`: discovery neither loads plugins nor reads .env.
    let discover_mode =
        argv_enables_bool_flag(&raw[1..], "discover-json") || argv_enables_bool_flag(&raw[1..], "discover");
    // Before the runtime starts: setting variables is only sound single-threaded.
    // ponytail: Go reads .env after the flag parse, so plugins loaded for their flags do
    // not see it; here it is read before they load (they do).
    if !discover_mode {
        dotenv::load_from_working_dir();
    }
    // Help and version never open a DB, import YAML or load native plugins.
    if raw[1..]
        .iter()
        .any(|v| matches!(v.as_str(), "-h" | "--help" | "-help" | "-V" | "--version"))
    {
        let flags =
            go_flags(&Args::command(), raw.clone(), &()).unwrap_or_else(|e| flag_error(&mut Args::command(), &e));
        if let Err(error) = Args::try_parse_from(flags) {
            error.exit();
        }
    }
    let config_flag = prescan_value(&raw[1..], "config").unwrap_or_default();
    let db_flag = prescan_value(&raw[1..], "db").unwrap_or_default();
    let config_file = if config_flag.is_empty() {
        PathBuf::from("config.yaml")
    } else {
        PathBuf::from(&config_flag)
    };
    let db = db_path(&db_flag, &config_file);
    let home = prescan_value(&raw[1..], "home-jwt").is_some_and(|v| !v.trim().is_empty())
        || ["HOME_JWT", "home_jwt"]
            .iter()
            .any(|k| std::env::var(k).is_ok_and(|v| !v.trim().is_empty()));
    let remote_client = go_flags(&Args::command(), raw.clone(), &())
        .ok()
        .and_then(|flags| Args::try_parse_from(flags).ok())
        .is_some_and(|args| {
            args.tui && !args.standalone && !args.management_base_url.trim().is_empty() && !command_mode(&args)
        });
    let loaded = if discover_mode || remote_client {
        None
    } else {
        let optional = home || std::env::var("DEPLOY").is_ok_and(|v| v == "cloud");
        let loaded =
            reject_remote_store(&|key| std::env::var(key).ok()).and_then(|()| load_config(&db, &config_file, optional));
        // Like a failure inside `run`: the process log keeps why startup stopped.
        if let Err(error) = &loaded
            && log_file.as_deref().is_some_and(|p| !p.is_empty())
        {
            tracing::error!("{error:#}");
        }
        Some(loaded?)
    };
    let runtime = runtime(loaded.as_ref().map(|(_, config)| config))?;
    let builtin_cmd = Args::command();
    let plugins = (!discover_mode).then(|| {
        let builtin = |name: &str| builtin_cmd.get_arguments().any(|a| a.get_long() == Some(name));
        let boot = loaded
            .as_ref()
            .map(|(_, config)| config.clone())
            .unwrap_or_else(|| Config::parse("").expect("empty config"));
        runtime.block_on(plugin_cli::bootstrap(boot, &builtin))
    });
    let mut cmd = match &plugins {
        Some((_, flags)) => plugin_cli::with_flags(Args::command(), flags),
        None => Args::command(),
    };
    let flags = match &plugins {
        Some((host, _)) => go_flags(&cmd, raw, host),
        None => {
            let prescanned = PrescanBools::from_args(&raw[1..]);
            go_flags(&cmd, raw, &prescanned)
        }
    }
    .unwrap_or_else(|e| flag_error(&mut cmd, &e));
    let matches = cmd.clone().get_matches_from(flags);
    let args = Args::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());
    if args.working_dir.as_deref() != working_dir.as_deref().map(Path::new) {
        // The pre-scan read a plugin flag's value differently from the parse.
        flag_error(
            &mut cmd,
            "-working-dir must come before any plugin flag that takes a value",
        );
    }
    if args.log_file.as_deref() != log_file.as_deref().map(Path::new) {
        flag_error(
            &mut cmd,
            "-log-file must come before any plugin flag that takes a value",
        );
    }
    if args.config != config_flag || args.db != db_flag {
        flag_error(&mut cmd, "--config and --db must come before ambiguous plugin flags");
    }
    if args.discover || args.discover_json {
        let cli = (csv_flags(&args.discover_include), csv_flags(&args.discover_exclude));
        let opts = discover_options(
            args.discover_timeout,
            args.discover_json,
            args.discover_service_type.clone(),
            &args.config,
            cli,
        );
        std::process::exit(runtime.block_on(discovery::cli::discover(&opts)));
    }
    let builtin = plugin_cli::builtin_values(&cmd, &matches);
    let host = plugins.map(|(host, _)| host).unwrap_or_default();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    runtime.spawn(heap_trim::run());
    let file_log = args.log_file.is_some();
    let result = runtime.block_on(run(args, host, builtin, loaded));
    if file_log && let Err(error) = &result {
        tracing::error!("{error:#}");
    }
    result
}

/// glibc keeps the memory that request handling frees in its per-thread arenas and only
/// returns the top of each arena to the kernel, so after a burst of large prompts the
/// process stays near its peak size while most of that memory is free. `malloc_trim`
/// hands the free pages of every arena back. Trimming under load costs page faults on
/// the next requests, so it runs once the process goes quiet (under 50 ms of CPU in five
/// seconds), and at least once a minute while busy. It trims once after startup, then
/// parks until a response or a WebSocket turn ends: with no requests, no timer and no wakeup. The trim
/// itself runs on the blocking pool, off the two request threads. See
/// docs/BENCHMARKS.md (Claude soak).
///
/// Cost per request: the response body is boxed once more, and its drop does one
/// atomic load (plus a wakeup when the task is parked).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod heap_trim {
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use axum::body::{Body, Bytes, HttpBody};

    const TICK: Duration = Duration::from_secs(5);
    const QUIET: Duration = Duration::from_millis(50);
    const MAX_GAP: u32 = 12;

    fn cpu_time() -> Duration {
        // SAFETY: getrusage writes only into the struct it is given.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        let tv = |t: libc::timeval| Duration::new(t.tv_sec as u64, t.tv_usec as u32 * 1000);
        tv(usage.ru_utime) + tv(usage.ru_stime)
    }

    pub async fn run() {
        loop {
            let (mut last, mut ticks) = (cpu_time(), 0);
            loop {
                tokio::time::sleep(TICK).await;
                let now = cpu_time();
                let quiet = now.saturating_sub(last) < QUIET;
                last = now;
                ticks += 1;
                if quiet || ticks >= MAX_GAP {
                    // Milliseconds to tens of ms on a large heap: not on a request thread.
                    // SAFETY: malloc_trim only releases the allocator's own free memory.
                    let _ = tokio::task::spawn_blocking(|| unsafe { libc::malloc_trim(0) }).await;
                    ticks = 0;
                }
                if quiet {
                    break;
                }
            }
            cpa_common::idle::park().await;
        }
    }

    /// Wakes the parked task when a response body is done (sent, or dropped with the
    /// connection).
    pub fn layer(app: axum::Router) -> axum::Router {
        app.layer(tower::util::MapResponseLayer::new(|res: axum::response::Response| {
            res.map(|body| Body::new(Done(body)))
        }))
    }

    struct Done(Body);

    impl HttpBody for Done {
        type Data = Bytes;
        type Error = axum::Error;

        fn poll_frame(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<Option<Result<http_body::Frame<Bytes>, axum::Error>>> {
            Pin::new(&mut self.get_mut().0).poll_frame(cx)
        }

        fn is_end_stream(&self) -> bool {
            self.0.is_end_stream()
        }

        fn size_hint(&self) -> http_body::SizeHint {
            self.0.size_hint()
        }
    }

    impl Drop for Done {
        fn drop(&mut self) {
            cpa_common::idle::activity();
        }
    }
}

async fn run(
    args: Args,
    plugins: cpa_plugin::Host,
    builtin: Vec<(String, String)>,
    loaded: Option<(Arc<ConfigStore>, Config)>,
) -> anyhow::Result<()> {
    // An explicit remote URL makes `-tui` a pure management client: it needs no local
    // config, store or Home bootstrap (Go loads them first and can fail or wait there).
    // Login, import and plugin flags still run first, as in Go.
    if args.tui
        && !args.standalone
        && !args.management_base_url.trim().is_empty()
        && !command_mode(&args)
        && !plugins.has_triggered_command_line_flags()
    {
        remote_tui(args.management_base_url.trim().to_owned(), args.password).await;
        return Ok(());
    }
    let home_jwt = [
        args.home_jwt.clone(),
        std::env::var("HOME_JWT").unwrap_or_default(),
        std::env::var("home_jwt").unwrap_or_default(),
    ];
    // Go: the flag, else HOME_JWT / home_jwt.
    let home_jwt = home_jwt
        .iter()
        .map(|v| v.trim())
        .find(|v| !v.is_empty())
        .map(str::to_owned);
    let (config_store, local_config) = loaded.context("local config was not initialized")?;
    let cloud = std::env::var("DEPLOY").is_ok_and(|v| v == "cloud");
    let (mut config, home_config, home_plugins) = match &home_jwt {
        Some(jwt) => {
            let (home_config, config, home_plugins) =
                home::bootstrap(jwt, args.home_disable_cluster_discovery, &plugins)
                    .await
                    .map_err(anyhow::Error::msg)?;
            (
                home_listener_config(config, &local_config)?,
                Some(home_config),
                Some(home_plugins),
            )
        }
        None => (local_config, None, None),
    };
    let config_present = match &home_config {
        // Go: `configFileExists = cfg.Port != 0` for a config loaded from Home.
        Some(_) => !cloud || config.port != 0,
        None => !cloud || cloud_config_present(&config_store, &config),
    };
    let backend = initialize_credentials(config_store.clone(), &mut config, home_config.is_some())?;
    plugin_cli::attach_credentials(&plugins, backend.clone());
    // Go ConfigureLogOutput and SetLogLevel, before any login command.
    cpa_server::logging::configure(&config);
    tracing::info!("{}", banner());
    // Go: the loaded config reaches the plugins (and Home learns which of its plugins
    // loaded), and a plugin flag hands the run to the plugins that own it.
    plugins.apply_config(Arc::new(config.clone())).await;
    if let Some(home_plugins) = home_plugins
        && let Err(line) = home_plugins.finish(&plugins).await
    {
        tracing::error!("{line}");
        return Ok(());
    }
    if let Some(code) = plugin_cli::execute(&plugins, &builtin, &backend).await {
        if code != 0 {
            std::process::exit(code);
        }
        return Ok(());
    }
    if command_mode(&args) {
        let CredentialAuthority::Local(db) = backend else {
            anyhow::bail!(plugin_cli::HOME_CREDENTIAL_ERROR);
        };
        return command(&args, &config, db).await.map(|_| ());
    }
    if !config_present {
        wait_for_cloud_deploy().await;
        return Ok(());
    }
    if args.local_model && (!args.tui || args.standalone) {
        tracing::info!("Local model mode: using embedded model catalogs, remote model updates disabled");
    }
    if args.tui {
        if args.standalone {
            standalone_tui(
                config,
                config_store,
                backend,
                args.password,
                args.local_model,
                home_config,
                plugins,
            )
            .await;
        } else {
            let base = resolve_management_base_url(&args.management_base_url, &config);
            remote_tui(base, args.password).await;
        }
        return Ok(());
    }
    // Only the plain server detaches: discovery, login, import, TUI and plugin
    // commands keep their console.
    if args.log_file.is_some() {
        free_console();
    }
    serve(
        config,
        config_store,
        backend,
        args.password,
        args.local_model,
        home_config,
        plugins,
        shutdown_signal(),
        None,
    )
    .await
}

/// A direct Windows Run entry needs no persistent console or shell parent; logs go
/// to the `--log-file` instead.
fn free_console() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn FreeConsole() -> i32;
        }
        // SAFETY: detaches only this process from its console; no pointers.
        unsafe {
            FreeConsole();
        }
    }
}

/// Go's `commandMode`: a login or import flag is set.
fn command_mode(args: &Args) -> bool {
    !args.vertex_import.is_empty()
        || !args.siwc_bind.is_empty()
        || args.antigravity_login
        || args.codex_login
        || args.codex_device_login
        || args.claude_login
        || args.kimi_login
        || args.kimi_ai_login
        || args.xai_login
        || args.devin_login
        || args.meta_login
}

/// Go's TUI client mode: a pure management client; the server runs elsewhere.
async fn remote_tui(base: String, password: String) {
    let run = tokio::task::spawn_blocking(move || tui::run(&base, &password, None, io::stdout())).await;
    if let Err(e) = run.map_err(io::Error::other).and_then(|r| r) {
        eprintln!("TUI error: {e}");
    }
}

/// Go `resolveManagementBaseURL`: the flag, then `remote-management.base-url`, then
/// the local server's port (8317 when unset).
fn resolve_management_base_url(flag: &str, config: &Config) -> String {
    let configured = config
        .document
        .get("management")
        .and_then(|m| m.get("base-url"))
        .and_then(serde_yaml_ng::Value::as_str)
        .unwrap_or_default();
    management_base_url(flag, configured, i64::from(config.port))
}

fn management_base_url(flag: &str, configured: &str, port: i64) -> String {
    for url in [flag, configured] {
        if !url.trim().is_empty() {
            return url.trim().to_owned();
        }
    }
    format!("http://127.0.0.1:{}", if port > 0 { port } else { 8317 })
}

/// Go's standalone TUI points stdout and stderr at /dev/null while it runs and draws on
/// the original stdout; dropping this restores both.
#[cfg(unix)]
struct QuietStdio {
    out: libc::c_int,
    err: libc::c_int,
}

#[cfg(unix)]
impl QuietStdio {
    /// Silences fds 1 and 2; returns the guard and a handle on the original stdout.
    fn start() -> io::Result<(Self, std::fs::File)> {
        use std::os::fd::{AsRawFd, FromRawFd};
        io::Write::flush(&mut io::stdout())?;
        let null = std::fs::OpenOptions::new().write(true).open("/dev/null")?;
        // SAFETY: plain fd duplication; each new fd is owned by the guard or the File.
        unsafe {
            let (out, err, tty) = (libc::dup(1), libc::dup(2), libc::dup(1));
            if out < 0 || err < 0 || tty < 0 {
                return Err(io::Error::last_os_error());
            }
            libc::dup2(null.as_raw_fd(), 1);
            libc::dup2(null.as_raw_fd(), 2);
            Ok((QuietStdio { out, err }, std::fs::File::from_raw_fd(tty)))
        }
    }
}

#[cfg(unix)]
impl Drop for QuietStdio {
    fn drop(&mut self) {
        // SAFETY: restores the fds saved in `start` and closes the saved copies.
        unsafe {
            libc::dup2(self.out, 1);
            libc::dup2(self.err, 2);
            libc::close(self.out);
            libc::close(self.err);
        }
    }
}

/// ponytail: Windows keeps the console handles. Go swaps only its `os.Stdout`
/// variable there too; the log lines already go to the hook, so only a stray direct
/// print could reach the screen.
#[cfg(not(unix))]
struct QuietStdio;

#[cfg(not(unix))]
impl QuietStdio {
    fn start() -> io::Result<(Self, io::Stdout)> {
        Ok((QuietStdio, io::stdout()))
    }
}

/// Go's `-tui -standalone`: the server runs in this process with a local management
/// password (`tui-<pid>-<nanos>` unless -password is set), its log lines feed the logs
/// tab, and it stops after the TUI quits.
async fn standalone_tui(
    config: Config,
    config_store: Arc<ConfigStore>,
    backend: CredentialAuthority,
    password: String,
    local_model: bool,
    home_config: Option<cpa_home::HomeConfig>,
    plugins: cpa_plugin::Host,
) {
    let hook = cpa_server::logging::capture(2000);
    let (quiet, out): (Option<QuietStdio>, Box<dyn io::Write + Send>) = match QuietStdio::start() {
        Ok((guard, tty)) => (Some(guard), Box::new(tty)),
        Err(_) => (None, Box::new(io::stdout())),
    };
    let password = if password.is_empty() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        format!("tui-{}-{nanos}", std::process::id())
    } else {
        password
    };
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let shutdown = async {
        let _ = stopped.await;
    };
    let (listening, listener) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(serve(
        config,
        config_store,
        backend,
        password.clone(),
        local_model,
        home_config,
        plugins,
        shutdown,
        Some(listening),
    ));
    // No listener means serve failed; its error is logged below.
    let base = match listener.await {
        Ok(listener) => standalone_base_url(listener),
        Err(_) => Err("embedded server is not ready".to_owned()),
    };
    let result = match &base {
        Ok(base) if tui::wait_ready(base, &password).await => {
            let base = base.clone();
            let run = tokio::task::spawn_blocking(move || tui::run(&base, &password, Some(hook), out)).await;
            run.map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| e.to_string()))
        }
        Ok(_) => Err("embedded server is not ready".to_owned()),
        Err(e) => Err(e.clone()),
    };
    // Restores stdout and stderr on Unix; outside Unix nothing was redirected.
    #[cfg_attr(not(unix), allow(clippy::drop_non_drop))]
    drop(quiet);
    cpa_server::logging::release();
    if let Err(e) = result {
        eprintln!("TUI error: {e}");
    }
    let _ = stop.send(());
    if let Ok(Err(e)) = server.await {
        tracing::error!("{e:#}");
    }
}

fn initialize_credentials(
    store: Arc<ConfigStore>,
    config: &mut Config,
    home: bool,
) -> anyhow::Result<CredentialAuthority> {
    if home {
        return Ok(CredentialAuthority::Home);
    }
    let backend = CredentialDb::initialize(store, &config.auth_dir)?;
    config.auth_dir = backend.auth_dir();
    Ok(CredentialAuthority::Local(backend))
}

fn login_save(backend: Arc<CredentialDb>) -> (cpa_exec::login_store::LoginSave, Arc<std::sync::Mutex<Option<String>>>) {
    let failure = Arc::new(std::sync::Mutex::new(None));
    let failed = failure.clone();
    let save: cpa_exec::login_store::LoginSave = Arc::new(move |paths, write| {
        let committed = (|| -> anyhow::Result<()> {
            let mut paths = paths
                .iter()
                .map(|path| cpa_server::credential_store::credential_path_key(path))
                .collect::<io::Result<Vec<_>>>()?;
            paths.sort();
            paths.dedup();
            let _locks = paths
                .iter()
                .map(|path| cpa_exec::codex_siwc_bind::lock_file(path).map_err(anyhow::Error::msg))
                .collect::<anyhow::Result<Vec<_>>>()?;
            backend.write_files(&paths, || write().map_err(anyhow::Error::msg))
        })();
        committed.map_err(|error| {
            let message = format!("commit CLI credentials to SQLite: {error:#}");
            *failed.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(message.clone());
            message
        })
    });
    (save, failure)
}

/// Whether a command flag handled this invocation.
enum Ran {
    Nothing,
    Handled,
    Login(PathBuf, &'static str),
    Imported(PathBuf),
    Bound(PathBuf),
}

async fn command(args: &Args, config: &Config, backend: Arc<CredentialDb>) -> anyhow::Result<Ran> {
    let (save, failure) = login_save(backend);
    let result = command_inner(args, config, save).await;
    if let Some(error) = failure.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
        anyhow::bail!(error);
    }
    match &result {
        Ok(Ran::Login(path, provider)) => {
            println!("Authentication saved to {}", path.display());
            println!("{provider} authentication successful!");
        }
        Ok(Ran::Imported(path)) => println!("Vertex credentials imported: {}", path.display()),
        Ok(Ran::Bound(path)) => {
            println!("SIWC credentials bound and saved to {}", path.display());
            println!("Sign in with ChatGPT authentication successful!");
        }
        _ => {}
    }
    result
}

/// Go's command modes, in Go's order.
async fn command_inner(args: &Args, config: &Config, save: cpa_exec::login_store::LoginSave) -> anyhow::Result<Ran> {
    // Go DoVertexImport: failures are logged and the command still exits normally.
    if !args.vertex_import.is_empty() {
        match cpa_exec::vertex_auth::import(
            &config.auth_dir,
            &args.vertex_import,
            &args.vertex_import_prefix,
            Some(&save),
        ) {
            Ok(path) => return Ok(Ran::Imported(path)),
            Err(error) => tracing::error!("{error}"),
        }
        return Ok(Ran::Handled);
    }
    if !args.siwc_bind.is_empty() {
        // Go DoSIWCBind: failures are reported and the command still exits normally,
        // except a busy callback port (ErrPortInUse's code 13).
        let options = cpa_exec::codex_oauth::LoginOptions {
            no_browser: args.no_browser,
            callback_port: args.oauth_callback_port,
        };
        match cpa_exec::codex_siwc_bind::bind(config, &args.siwc_bind, &options, Some(save)).await {
            Ok(path) => return Ok(Ran::Bound(path)),
            Err(cpa_exec::codex_siwc_bind::BindError::Log(line)) => tracing::error!("{line}"),
            Err(cpa_exec::codex_siwc_bind::BindError::Print(line)) => println!("{line}"),
            Err(cpa_exec::codex_siwc_bind::BindError::PortInUse) => {
                tracing::error!(
                    "The required port is already in use. Please close any applications using port 3000 and try again."
                );
                std::process::exit(13);
            }
        }
        return Ok(Ran::Handled);
    }
    if args.antigravity_login {
        // Go DoAntigravityLogin: a failure is logged and the command still exits normally.
        let options = cpa_exec::antigravity_auth::LoginOptions {
            no_browser: args.no_browser,
            callback_port: args.oauth_callback_port,
        };
        match cpa_exec::antigravity_auth::login(&config.auth_dir, config, &options, Some(save)).await {
            Ok((path, _)) => return Ok(Ran::Login(path, "Antigravity")),
            Err(error) => tracing::error!("Antigravity authentication failed: {error}"),
        }
        return Ok(Ran::Handled);
    }
    if args.codex_login || args.codex_device_login {
        let options = cpa_exec::codex_oauth::LoginOptions {
            no_browser: args.no_browser,
            callback_port: match args.oauth_callback_port {
                0 => cpa_exec::codex_oauth::DEFAULT_CALLBACK_PORT,
                port => port,
            },
        };
        let path = if args.codex_login {
            cpa_exec::codex_oauth::login(&config.auth_dir, &options, Some(save)).await?
        } else {
            cpa_exec::codex_oauth::device_login(&config.auth_dir, &options, Some(save)).await?
        };
        return Ok(Ran::Login(path, "Codex"));
    }
    if args.claude_login {
        let options = cpa_exec::claude_login::LoginOptions {
            no_browser: args.no_browser,
            callback_port: match args.oauth_callback_port {
                0 => cpa_exec::claude_login::DEFAULT_CALLBACK_PORT,
                port => port,
            },
        };
        let error = match cpa_exec::claude_login::login(&config.auth_dir, &options, Some(save)).await {
            Ok(path) => return Ok(Ran::Login(path, "Claude")),
            Err(error) => error,
        };
        let message = String::from_utf8_lossy(&error.body).into_owned();
        // DoClaudeLogin: a busy callback port exits with ErrPortInUse's code 13.
        if message.starts_with(cpa_exec::claude_login::PORT_IN_USE) {
            tracing::error!(
                "The required port is already in use. Please close any applications using port 3000 and try again."
            );
            std::process::exit(13);
        }
        println!("Claude authentication failed: {message}");
        return Ok(Ran::Handled);
    }
    if args.kimi_login || args.kimi_ai_login {
        let provider = if args.kimi_login { "kimi" } else { "kimi-ai" };
        let path = cpa_exec::kimi_auth::login(provider, config, args.no_browser, Some(save)).await?;
        return Ok(Ran::Login(path, if args.kimi_login { "Kimi" } else { "Kimi.ai" }));
    }
    if args.xai_login {
        // Go DoXAILogin: a failure is logged and the command still exits normally.
        match cpa_exec::xai_auth::login(config, args.no_browser, Some(save)).await {
            Ok(path) => return Ok(Ran::Login(path, "xAI")),
            Err(error) => tracing::error!("xAI authentication failed: {}", String::from_utf8_lossy(&error.body)),
        }
        return Ok(Ran::Handled);
    }
    if args.devin_login {
        // Go DoDevinLogin: a failure is logged and the command still exits normally.
        return Ok(
            match cpa_exec::devin_auth::login(config, args.no_browser, args.oauth_callback_port, Some(save)).await {
                Some(path) => Ran::Login(path, "Devin"),
                None => Ran::Handled,
            },
        );
    }
    if args.meta_login {
        let path = cpa_exec::meta_auth::login(config, args.no_browser, Some(save)).await?;
        return Ok(Ran::Login(path, "Meta"));
    }
    Ok(Ran::Nothing)
}

/// The standalone TUI's server address: the bound one, or loopback for a wildcard bind.
/// The local password works only from loopback, so other hosts are refused, and so is
/// TLS, which would need the server certificate to be trusted for that address.
fn standalone_base_url((addr, tls): (SocketAddr, bool)) -> Result<String, String> {
    if tls {
        return Err("the standalone TUI does not support server.tls; turn it off or run the TUI as a client".into());
    }
    let ip = match addr.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => Ipv4Addr::LOCALHOST.into(),
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => Ipv6Addr::LOCALHOST.into(),
        ip if ip.is_loopback() => ip,
        ip => {
            return Err(format!(
                "the standalone TUI needs a loopback or wildcard host, not {ip}; run the TUI as a client"
            ));
        }
    };
    Ok(format!("http://{}", SocketAddr::new(ip, addr.port())))
}

/// Go `Service.ensureAuthDir`.
fn ensure_auth_dir(dir: &Path) -> anyhow::Result<()> {
    match std::fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => anyhow::bail!("cliproxy: auth path exists but is not a directory: {}", dir.display()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o755);
            builder
                .create(dir)
                .with_context(|| format!("cliproxy: failed to create auth directory {}", dir.display()))?;
            tracing::info!("created missing auth directory: {}", dir.display());
            Ok(())
        }
        Err(e) => Err(e).with_context(|| format!("cliproxy: error checking auth directory {}", dir.display())),
    }
}

/// The served routes. In Home mode the config comes from Home and every management
/// route answers 404 (Go `managementAvailable`), so the Management API is not mounted.
fn app(rt: &Arc<Runtime>, management: &Arc<cpa_server::management::Management>, home: bool) -> axum::Router {
    let app = if home {
        cpa_server::router(rt.clone()).layer(axum::middleware::from_fn_with_state(
            rt.clone(),
            cpa_server::remote::gate,
        ))
    } else {
        let app = cpa_server::app(rt.clone(), cpa_server::management::router(management.clone()));
        cpa_server::safe_mode::router(rt, app)
    };
    // Go applies its CORS middleware to every route, not only management.
    let app = app.layer(axum::middleware::from_fn(cpa_server::management::cors));
    let app = cpa_server::request_logging::router(management, app);
    let app = cpa_server::body_limit::layer(rt, app);
    cpa_server::observability::router(rt, app)
}

/// `listening` (standalone TUI only) receives the bound address and whether TLS is on.
#[allow(clippy::too_many_arguments)]
async fn serve(
    config: Config,
    config_store: Arc<ConfigStore>,
    backend: CredentialAuthority,
    password: String,
    local_model: bool,
    home_config: Option<cpa_home::HomeConfig>,
    plugins: cpa_plugin::Host,
    shutdown: impl std::future::Future<Output = ()>,
    listening: Option<tokio::sync::oneshot::Sender<(SocketAddr, bool)>>,
) -> anyhow::Result<()> {
    if config.api_keys.is_empty() && home_config.is_none() {
        tracing::warn!("access.api-keys is empty: the proxy API is open to anyone who can reach it");
    }
    // Go `ensureAuthDir`: outside Home mode a missing auth-dir is created, so the
    // watcher has a folder to watch for the first login.
    if home_config.is_none() {
        ensure_auth_dir(&config.auth_dir)?;
    }
    // Auth-dir files and config API keys, synthesized as Go's watcher does. Home mode
    // runs on credentials Home dispatches per request.
    let (credentials, read) = match &backend {
        CredentialAuthority::Home => Default::default(),
        CredentialAuthority::Local(db) => {
            let scan = db.scan(&config)?;
            let mut all = scan.credentials;
            all.extend(cpa_core::config::credentials::from_config(&config));
            (all, scan.read)
        }
    };
    tracing::info!(credentials = credentials.len(), "credentials loaded");
    let listener =
        bind(&config.host, config.port).with_context(|| format!("binding {}:{}", config.host, config.port))?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    // Go `Server.Start`: TLS is validated after the listener is open.
    let tls = cpa_server::listener::tls_acceptor(&config)?;
    tracing::info!(addr = %listener.local_addr()?, tls = tls.is_some(), "listening");
    let standalone = listening.is_some();
    if let Some(listening) = listening {
        let _ = listening.send((listener.local_addr()?, tls.is_some()));
    }
    let executors = Executors {
        claude: ClaudeExecutor::new(DEFAULT_BASE_URL)?,
        codex: cpa_exec::codex::CodexExecutor::new()?,
        devices: Default::default(),
        openai: Default::default(),
        google: Default::default(),
    };
    let rt = match backend {
        CredentialAuthority::Home => Runtime::home(config, credentials, executors),
        CredentialAuthority::Local(db) => Runtime::new(config, credentials, executors, db),
    };
    let rt = Arc::new(rt.with_plugin_host(plugins));
    // What each file credential was loaded from, for Go-exact management saves.
    rt.store().note_loaded(&read);
    rt.set_local_model(local_model);
    // Go `misc.StartAntigravityVersionUpdater` and `startModelCatalogUpdaters`.
    cpa_server::model_updater::start(&rt, home_config.is_some());
    // Model router benchmarks (cook-router only); idle without `artificial-analysis.api-key`.
    if home_config.is_none() {
        cpa_server::aa::start(&rt);
    }
    let home = home_config.map(|home_config| {
        let dispatcher = Arc::new(home::Dispatcher::new(&rt));
        rt.set_remote_dispatch(Some(dispatcher.clone()));
        let shutdown = tokio_util::sync::CancellationToken::new();
        let task = home::spawn_subscriber(home_config, rt.clone(), dispatcher, shutdown.clone());
        (shutdown, task)
    });
    // Translators and thinking validation read model capabilities through the global
    // overlay; without it they see only the static catalog.
    cpa_server::install_registry(&rt);
    rt.start_auto_refresh();
    let options = cpa_server::management::Options {
        local_password: password,
        standalone,
        ..Default::default()
    };
    let management = cpa_server::management::Management::with_options(rt.clone(), config_store, options);
    if home.is_some() {
        // Go enables the usage queue in Home mode whatever the management secret
        // (`redisqueue.SetEnabled(... || cfg.Home.Enabled)`); the forwarder drains it.
        rt.usage_queue().configure(true, &rt.config());
    }
    // Go applies the plugin config before serving; later publishes resync the host.
    cpa_server::plugins::start(&rt).await;
    if home.is_none() {
        cpa_server::plugins::reload_plugin_auth_files(&rt).await;
    }
    let pprof = cpa_server::pprof::Server::start(&rt);
    // Home mode: the config comes from Home, and management answers 404 (Go
    // `managementAvailable`).
    let _watcher = home.is_none().then(|| cpa_server::watching::start(&management));
    let advertiser = {
        let rt = rt.clone();
        // The served transport decides `tls=`: HTTPS exactly when server.tls loaded.
        let published = rt.subscribe_config();
        discovery::advertise::Advertiser::spawn(move || rt.config(), published, tls.is_some())
    };
    let app = app(&rt, &management, home.is_some());
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    let app = heap_trim::layer(app);
    // Go's listener also serves the Redis protocol (usage queue) to management clients;
    // in Home mode it answers "ERR redis usage output disabled in home mode".
    let mut server = Box::pin(cpa_server::listener::serve_with_resp(
        listener,
        app,
        tls,
        Some(management),
    ));
    let mut home = home;
    // Go `cancelServiceRun`: a Home subscriber that stops on its own (an unsafe drain or
    // an unsettled dispatch) stops the service; executions it could not drain end with
    // the process instead of running on unaccounted.
    let home_stopped = async {
        match home.as_mut() {
            Some((_, task)) => {
                let _ = task.await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    let mut home_failed = false;
    let mut server_done = false;
    let served = tokio::select! {
        r = &mut server => {
            server_done = true;
            r.map_err(anyhow::Error::from)
        },
        _ = shutdown => Ok(()),
        _ = home_stopped => {
            home_failed = true;
            Err(anyhow::anyhow!("home subscriber stopped; shutting down"))
        }
    };
    // Go v8.0.35 stops Home, pprof, discovery, then the API server. Keep serving
    // API requests while Home drains and flushes releases and pprof drains.
    let cleanup = async {
        if let Some((shutdown, task)) = home
            && !home_failed
        {
            shutdown.cancel();
            let _ = task.await;
        }
        pprof.shutdown().await;
        advertiser.shutdown().await;
        // A Codex refresh holding a credential file's lock writes its tokens first.
        rt.shutdown_codex_refreshes().await;
    };
    tokio::pin!(cleanup);
    if server_done {
        cleanup.await;
    } else {
        tokio::select! {
            _ = &mut cleanup => {},
            _ = &mut server => cleanup.await,
        }
    }
    // Server.Stop closes the HTTP server without draining (http.Server.Close).
    drop(server);
    served
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential_test_dir() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "cook-cli-credential-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn credential_initialization_skips_home() {
        // Home must return before touching credentials, even when legacy files exist.
        let root = credential_test_dir();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("legacy.json"), b"{\"secret\":true}").unwrap();
        let mut config = Config::parse("").unwrap();
        config.auth_dir = root.clone();
        assert!(matches!(
            initialize_credentials(Arc::new(ConfigStore::memory()), &mut config, true).unwrap(),
            CredentialAuthority::Home
        ));
        assert_eq!(config.auth_dir, root);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cli_changes_and_claude_legacy_deletion_survive_reopen() {
        let root = credential_test_dir();
        let legacy = root.join("legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("claude-old.json"), b"{\"type\":\"claude\",\"old\":true}").unwrap();
        let path = root.join("cook.db");
        let mut config = Config::parse("").unwrap();
        config.auth_dir = legacy.clone();
        let CredentialAuthority::Local(db) = initialize_credentials(
            Arc::new(cpa_server::testing::config_store(&path).unwrap()),
            &mut config,
            false,
        )
        .unwrap() else {
            panic!("local credentials expected");
        };
        assert_eq!(config.auth_dir, db.auth_dir());
        let canonical = config.auth_dir.join("claude-new.json");
        let bytes = b"{\"type\":\"claude\",\"access_token\":\"new\",\"unknown\":[1,2]}";
        let (save, failure) = login_save(db.clone());
        cpa_exec::login_store::save_login(
            Some(&save),
            &[canonical.clone(), config.auth_dir.join("claude-old.json")],
            || {
                std::fs::write(&canonical, bytes).map_err(|error| error.to_string())?;
                std::fs::remove_file(config.auth_dir.join("claude-old.json")).map_err(|error| error.to_string())
            },
        )
        .unwrap();
        assert!(failure.lock().unwrap().is_none());
        drop(save);
        drop(db);
        std::fs::remove_dir_all(&config.auth_dir).unwrap();
        let db =
            CredentialDb::initialize(Arc::new(cpa_server::testing::config_store(&path).unwrap()), &legacy).unwrap();
        assert_eq!(std::fs::read(&canonical).unwrap(), bytes);
        assert!(db.read(&config.auth_dir.join("claude-old.json")).unwrap().is_none());
        assert!(!config.auth_dir.join("claude-old.json").exists());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cli_durable_failure_is_returned_and_restores_working_bytes() {
        let root = credential_test_dir();
        let path = root.join("cook.db");
        let db = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        let auth = db.auth_dir().join("login.json");
        db.save(&auth, b"{\"old\":true}").unwrap();
        let (save, failure) = login_save(db.clone());
        let blocker = cpa_server::testing::config_store(&path).unwrap();
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
        let mut called = false;
        let result = cpa_exec::login_store::save_login(Some(&save), std::slice::from_ref(&auth), || {
            called = true;
            std::fs::write(&auth, b"{\"new\":true}").map_err(|error| error.to_string())
        });
        release.send(()).unwrap();
        writer.join().unwrap();
        assert!(result.unwrap_err().contains("commit CLI credentials to SQLite"));
        assert!(failure.lock().unwrap().is_some());
        assert!(!called, "SQLite failure must precede the working-file mutation");
        assert_eq!(std::fs::read(&auth).unwrap(), b"{\"old\":true}");
        assert_eq!(db.read(&auth).unwrap().unwrap(), b"{\"old\":true}");
        drop(save);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cli_writer_cannot_be_reverted_by_concurrent_materialization() {
        let root = credential_test_dir();
        let path = root.join("cook.db");
        let db = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        let auth = db.auth_dir().join("login.json");
        db.save(&auth, b"{\"old\":true}").unwrap();
        let watcher = CredentialDb::initialize(
            Arc::new(cpa_server::testing::config_store(&path).unwrap()),
            &root.join("missing"),
        )
        .unwrap();
        let (save, _) = login_save(db.clone());
        let (written, changed) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let target = auth.clone();
        let writer = std::thread::spawn(move || {
            cpa_exec::login_store::save_login(Some(&save), std::slice::from_ref(&target), || {
                std::fs::write(&target, b"{\"new\":true}").map_err(|error| error.to_string())?;
                written.send(()).unwrap();
                released.recv().unwrap();
                Ok(())
            })
            .unwrap()
        });
        changed.recv().unwrap();
        let (started, starting) = std::sync::mpsc::channel();
        let (finished, done) = std::sync::mpsc::channel();
        let materializer = std::thread::spawn(move || {
            started.send(()).unwrap();
            watcher.materialize().unwrap();
            finished.send(()).unwrap();
        });
        starting.recv().unwrap();
        let blocked = done.recv_timeout(Duration::from_millis(100));
        release.send(()).unwrap();
        writer.join().unwrap();
        materializer.join().unwrap();
        assert!(matches!(blocked, Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
        assert_eq!(db.read(&auth).unwrap().unwrap(), b"{\"new\":true}");
        assert_eq!(std::fs::read(&auth).unwrap(), b"{\"new\":true}");
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Positive configured worker counts override the CPU-based default.
    #[test]
    fn worker_threads_come_from_the_config() {
        let default = std::thread::available_parallelism().map_or(1, |n| n.get().min(2));
        let cfg = Config::parse("worker-threads: 5\n").unwrap();
        assert_eq!(worker_threads(Some(&cfg)), 5);
        for text in ["worker-threads: 0\n", "worker-threads: -3\n", ""] {
            let cfg = Config::parse(text).unwrap();
            assert_eq!(worker_threads(Some(&cfg)), default, "{text:?}");
        }
        assert_eq!(worker_threads(None), default);
    }

    // Expected values: Go resolveManagementBaseURL (tests/fixtures/discovery_main_go.json).
    #[test]
    fn management_base_url_follows_go() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/discovery_main_go.json")).unwrap();
        let cases = fixture["management_base_url"].as_array().unwrap();
        assert!(cases.len() >= 6);
        for case in cases {
            let got = management_base_url(
                case["flag"].as_str().unwrap(),
                case["remote"].as_str().unwrap(),
                case["port"].as_i64().unwrap(),
            );
            assert_eq!(got, case["out"].as_str().unwrap(), "{case}");
        }
        let config = Config::parse("config-version: 8\nmanagement:\n  base-url: ' http://y '\n").unwrap();
        assert_eq!(resolve_management_base_url("", &config), "http://y");
    }

    #[test]
    fn argv_prescan_matches_go() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/discovery_main_go.json")).unwrap();
        for case in fixture["argv"].as_array().unwrap() {
            let args: Vec<String> = serde_json::from_value(case["args"].clone()).unwrap();
            assert_eq!(
                argv_enables_bool_flag(&args, "discover-json"),
                case["discover_json"],
                "{args:?}"
            );
            assert_eq!(argv_enables_bool_flag(&args, "discover"), case["discover"], "{args:?}");
        }
    }

    /// A flag the binary does not define may be a boolean plugin flag, so a discover
    /// flag after it still selects discover mode, before any plugin loads. Built-in
    /// flags that take a value keep consuming it as Go does.
    #[test]
    fn a_plugin_flag_before_discover_keeps_discover_mode() {
        let argv = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(argv_enables_bool_flag(
            &argv(&["-plugin-verbose", "-discover"]),
            "discover"
        ));
        assert!(argv_enables_bool_flag(
            &argv(&["--plugin-verbose", "--discover-json"]),
            "discover-json"
        ));
        assert!(argv_enables_bool_flag(
            &argv(&["-plugin-verbose", "-discover=true"]),
            "discover"
        ));
        // A plugin flag still takes an ordinary value.
        assert!(argv_enables_bool_flag(
            &argv(&["-plugin-mode", "fast", "-discover"]),
            "discover"
        ));
        assert!(!argv_enables_bool_flag(
            &argv(&["-plugin-mode", "x", "fast", "-discover"]),
            "discover"
        ));
        // A built-in value flag consumes the next token, as in Go.
        assert!(!argv_enables_bool_flag(&argv(&["-config", "-discover"]), "discover"));
        assert!(!argv_enables_bool_flag(
            &argv(&["-password", "--discover-json"]),
            "discover-json"
        ));
    }

    /// `-plugin-verbose -discover` selects discover mode, and the parse that follows
    /// (without plugins) accepts that flag; another undefined flag still fails.
    #[test]
    fn a_plugin_flag_before_discover_parses_in_discover_mode() {
        let parse = |a: &[&str]| {
            let raw: Vec<String> = std::iter::once("cook-router")
                .chain(a.iter().copied())
                .map(str::to_owned)
                .collect();
            assert!(argv_enables_bool_flag(&raw[1..], "discover"), "{a:?}");
            let flags = go_flags(&Args::command(), raw.clone(), &PrescanBools::from_args(&raw[1..]))?;
            Args::try_parse_from(flags).map_err(|e| e.to_string())
        };
        assert!(parse(&["-plugin-verbose", "-discover"]).unwrap().discover);
        assert!(
            parse(&["--plugin-verbose", "--discover", "-discover-timeout", "5"])
                .unwrap()
                .discover
        );
        assert!(parse(&["-plugin-mode", "fast", "-discover"]).is_err());
    }

    #[test]
    fn every_go_flag_parses_in_single_and_double_dash_form() {
        let argv = |a: &[&str]| {
            go_flags(
                &Args::command(),
                std::iter::once("cook-router")
                    .chain(a.iter().copied())
                    .map(String::from),
                &(),
            )
            .unwrap()
        };
        let args = Args::try_parse_from(argv(&[
            "-discover",
            "-discover-timeout",
            "-2",
            "--discover-json",
            "-discover-service-type=_x._tcp",
            "-discover-include",
            "eth0,en0",
            "-discover-include=wl*",
            "-discover-exclude",
            "docker0",
            "-vertex-import",
            "k.json",
            "-vertex-import-prefix",
            "p",
            "-siwc-bind",
            "codex-a.json",
            "-home-jwt",
            "j",
            "-home-disable-cluster-discovery",
            "-tui",
            "-standalone",
            "-management-base-url",
            "https://x",
            "-local-model",
            "-antigravity-login",
            "-devin-login",
            "-config",
            "c.yaml",
            "-password",
            "pw",
        ]))
        .unwrap();
        assert!(args.discover && args.discover_json && args.tui && args.standalone && args.local_model);
        assert!(args.antigravity_login && args.devin_login && args.home_disable_cluster_discovery);
        assert_eq!(args.discover_timeout, -2);
        assert_eq!(csv_flags(&args.discover_include), ["eth0", "en0", "wl*"]);
        assert_eq!(args.management_base_url, "https://x");
        assert_eq!(args.siwc_bind, "codex-a.json");
        let sub = |a: &[&str]| {
            DiscoverArgs::try_parse_from(
                go_flags(
                    &DiscoverArgs::command(),
                    std::iter::once("discover").chain(a.iter().copied()).map(String::from),
                    &(),
                )
                .unwrap(),
            )
        };
        let parsed = sub(&[
            "-timeout", "5", "-json", "-include", "a,b", "-include", "a", "-config", "x.yaml",
        ])
        .unwrap();
        assert_eq!(
            (parsed.timeout, parsed.json, csv_flags(&parsed.include)),
            (5, true, vec!["a".into(), "b".into(), "a".into()])
        );
        // Go flag rules that plain clap rejects.
        let parsed = sub(&[
            "--json=true",
            "-timeout",
            "2",
            "-timeout",
            "-10",
            "-config",
            "-local.yaml",
        ])
        .unwrap();
        assert_eq!(
            (parsed.json, parsed.timeout, parsed.config.as_str()),
            (true, -10, "-local.yaml")
        );
        assert!(!sub(&["--json=false"]).unwrap().json);
        assert!(!sub(&["-json", "-json=0"]).unwrap().json);
        assert_eq!(sub(&["-timeout=0x10"]).unwrap().timeout, 16);
        // Parsing stops at the first operand; Go ignores the rest.
        let parsed = sub(&["-json", "extra", "-timeout", "9"]).unwrap();
        assert_eq!((parsed.json, parsed.timeout), (true, 3));
        assert!(sub(&["-json=maybe"]).is_err());
        assert!(sub(&["-nope"]).is_err());
        assert!(sub(&["-timeout"]).is_err());
        assert!(sub(&["-timeout", "1.5"]).is_err());
        assert!(sub(&["---x"]).is_err());
    }

    #[test]
    fn prescan_reads_every_spelling() {
        // The same table for each prescanned flag, written for -working-dir.
        for flag in ["working-dir", "log-file"] {
            let scan = |a: &[&str]| {
                let args: Vec<String> = a.iter().map(|s| s.replace("working-dir", flag)).collect();
                prescan_value(&args, flag)
            };
            for spelling in [
                &["-working-dir", "d"][..],
                &["--working-dir", "d"],
                &["-working-dir=d"],
                &["--working-dir=d"],
                &["-tui", "-config", "c.yaml", "--working-dir", "d", "-local-model"],
                &["-working-dir", "x", "-working-dir=d"],
                // An undefined (plugin) flag with a value, or a boolean one before a flag.
                &["-plugin-mode", "fast", "-working-dir", "d"],
                &["-plugin-verbose", "-working-dir", "d"],
            ] {
                assert_eq!(scan(spelling).as_deref(), Some("d"), "{flag}: {spelling:?}");
            }
            // The value may start with a dash, as for every Go value flag.
            assert_eq!(scan(&["-working-dir", "-d"]).as_deref(), Some("-d"), "{flag}");
            assert_eq!(scan(&["-working-dir="]).as_deref(), Some(""), "{flag}");
            // Values of other flags, operands, `--` and a missing value are not it.
            assert_eq!(scan(&["-config", "-working-dir", "x"]), None, "{flag}");
            assert_eq!(scan(&["-password", "--working-dir=x"]), None, "{flag}");
            assert_eq!(scan(&["run", "-working-dir", "x"]), None, "{flag}");
            assert_eq!(scan(&["--", "-working-dir", "x"]), None, "{flag}");
            assert_eq!(scan(&["-working-dir"]), None, "{flag}");
            assert_eq!(scan(&["discover", "-working-dir", "x"]), None, "{flag}");
        }
        let args = ["-working-dir", "-log-file", "l"].map(str::to_owned);
        assert_eq!(prescan_value(&args, "log-file"), None);
        // The full parse agrees, and neither flag is passed to plugins.
        let raw = ["cook-router", "-tui", "--working-dir=d", "-log-file", "l"].map(str::to_owned);
        let cmd = Args::command();
        let matches = cmd.clone().get_matches_from(go_flags(&cmd, raw.clone(), &()).unwrap());
        let args = Args::from_arg_matches(&matches).unwrap();
        assert_eq!(args.working_dir.as_deref(), Some(Path::new("d")));
        assert_eq!(args.log_file.as_deref(), Some(Path::new("l")));
        assert_eq!(prescan_value(&raw[1..], "working-dir").as_deref(), Some("d"));
        assert_eq!(prescan_value(&raw[1..], "log-file").as_deref(), Some("l"));
        let builtin = plugin_cli::builtin_values(&cmd, &matches);
        assert!(builtin.iter().all(|(n, _)| n != "working-dir" && n != "log-file"));
        assert!(builtin.iter().any(|(n, v)| n == "tui" && v == "true"));
    }

    #[test]
    fn go_int_matches_strconv_base_zero() {
        for (s, want) in [
            ("3", Some(3)),
            ("-10", Some(-10)),
            ("+7", Some(7)),
            ("0x1f", Some(31)),
            ("010", Some(8)),
        ] {
            assert_eq!(go_int(s).ok(), want, "{s}");
        }
        for (s, want) in [
            ("0b101", Some(5)),
            ("0o17", Some(15)),
            ("1_000", Some(1000)),
            ("0_10", Some(8)),
            ("", None),
        ] {
            assert_eq!(go_int(s).ok(), want, "{s}");
        }
        for bad in ["9223372036854775808", "_1", "1_", "1__0", "0x", "1.5", "0x_"] {
            assert!(go_int(bad).is_err(), "{bad}");
        }
        assert_eq!(go_int("0x_1f").ok(), Some(31));
        assert_eq!(go_int("-9223372036854775808").ok(), Some(i64::MIN));
    }

    #[test]
    fn standalone_url_follows_the_listener() {
        let url = |addr: &str, tls| standalone_base_url((addr.parse().unwrap(), tls));
        assert_eq!(url("127.0.0.1:4100", false).unwrap(), "http://127.0.0.1:4100");
        assert_eq!(url("0.0.0.0:4101", false).unwrap(), "http://127.0.0.1:4101");
        assert_eq!(url("[::]:4102", false).unwrap(), "http://[::1]:4102");
        assert_eq!(url("[::1]:4103", false).unwrap(), "http://[::1]:4103");
        assert!(url("192.0.2.7:4104", false).unwrap_err().contains("192.0.2.7"));
        assert!(url("127.0.0.1:4105", true).unwrap_err().contains("server.tls"));
    }

    /// `-tui -standalone` with no management key anywhere and `port: 0`: the TUI finds
    /// the ephemeral port and signs in with the generated password.
    #[tokio::test]
    async fn standalone_server_starts_without_any_secret() {
        let dir = std::env::temp_dir().join(format!("cpa-standalone-{}", std::process::id()));
        let auth = dir.join("auth");
        std::fs::create_dir_all(&auth).unwrap();
        let store = Arc::new(cpa_server::testing::config_store(&dir.join("cook.db")).unwrap());
        store
            .import_yaml(
                &format!("host: 127.0.0.1\nport: 0\nauth-dir: '{}'\n", auth.display()),
                "test",
                "standalone server",
            )
            .unwrap();
        let mut config = store.load().unwrap().config;
        let backend = initialize_credentials(store.clone(), &mut config, false).unwrap();
        assert!(config.management.secret_key.is_empty());
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let (listening, listener) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve(
            config,
            store,
            backend,
            "fake-tui-password".into(),
            true,
            None,
            cpa_plugin::Host::default(),
            async {
                let _ = stopped.await;
            },
            Some(listening),
        ));
        let base = standalone_base_url(listener.await.unwrap()).unwrap();
        assert_ne!(base, "http://127.0.0.1:0");
        assert!(tui::wait_ready(&base, "fake-tui-password").await);
        let _ = stop.send(());
        server.await.unwrap().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Go `TestSIWCManagementRouteAccessControl`: the v8 SIWC bind route answers its
    /// own validation once authorized, 401 without the key, and 404 when management is
    /// disabled or the node runs in Home mode.
    #[tokio::test]
    async fn siwc_bind_route_follows_management_availability() {
        use tower::ServiceExt as _;
        let dir = std::env::temp_dir().join(format!("cpa-siwc-route-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("auth")).unwrap();
        let store = Arc::new(ConfigStore::memory_with(&format!(
            "auth-dir: '{}'\n",
            dir.join("auth").display()
        )));
        let config = store.load().unwrap().config;
        for (name, enabled, home, authorized, want) in [
            ("authorized invalid target", true, false, true, 400),
            ("missing management key", true, false, false, 401),
            ("management disabled", false, false, true, 404),
            ("home disabled local API", true, true, true, 404),
        ] {
            let executors = Executors {
                claude: ClaudeExecutor::new("http://127.0.0.1:9").unwrap(),
                codex: Default::default(),
                devices: Default::default(),
                openai: Default::default(),
                google: Default::default(),
            };
            let rt = Arc::new(cpa_server::testing::runtime(config.clone(), Vec::new(), executors));
            let options = cpa_server::management::Options {
                // MANAGEMENT_PASSWORD; with no config secret it alone decides availability.
                management_password: Some(if enabled {
                    "fake-management-only".into()
                } else {
                    String::new()
                }),
                // Keeps the log-folder probe out of the working directory.
                log_dir: Some(dir.join("logs")),
                ..Default::default()
            };
            let management = cpa_server::management::Management::with_options(rt.clone(), store.clone(), options);
            let mut request = axum::http::Request::post("/v8/management/oauth/siwc/bind")
                .header("content-type", "application/json")
                .extension(axum::extract::ConnectInfo(SocketAddr::from((
                    Ipv4Addr::LOCALHOST,
                    1234,
                ))));
            if authorized {
                request = request.header("authorization", "Bearer fake-management-only");
            }
            let response = app(&rt, &management, home)
                .oneshot(request.body(axum::body::Body::from("{}")).unwrap())
                .await
                .unwrap();
            let status = response.status().as_u16();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(status, want, "{name}: {}", String::from_utf8_lossy(&body));
            match want {
                400 => assert_eq!(&body[..], br#"{"error":"name is required"}"#, "{name}"),
                // gin `AbortWithStatus`: no body.
                404 => assert!(body.is_empty(), "{name}: {}", String::from_utf8_lossy(&body)),
                _ => {}
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn optional_first_import_only_tolerates_a_missing_file() {
        let dir = std::env::temp_dir().join(format!(
            "cpa-cloud-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("cook.db");
        let missing = dir.join("missing.yaml");
        let (store, cfg) = load_config(&db, &missing, true).unwrap();
        assert_eq!(cfg.port, 0);
        assert!(!store.is_empty().unwrap(), "even an empty initial import is durable");
        assert!(!cloud_config_present(&store, &cfg));
        std::fs::write(&missing, "port: 9000\n").unwrap();
        assert_eq!(load_config(&db, &missing, false).unwrap().1.port, 0);
        for (i, text) in ["port: [\n", "port: wrong\n", "- a\n- b\n"].iter().enumerate() {
            let broken = dir.join("broken.yaml");
            std::fs::write(&broken, text).unwrap();
            assert!(
                load_config(&dir.join(format!("invalid-{i}.db")), &broken, true).is_err(),
                "{text}"
            );
        }
        assert!(load_config(&dir.join("directory.db"), &dir, true).is_err());
        let invalid_db = dir.join("invalid.db");
        std::fs::write(&invalid_db, "not SQLite").unwrap();
        assert!(
            load_config(&invalid_db, &missing, true).is_err(),
            "a valid YAML file cannot mask a bad DB"
        );
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn local_home_listener_overrides_preserve_remote_runtime_ownership() {
        let remote = home::overlay(b"port: 0\nrequest-retry: 7\napi-keys: [remote-key]\n", None).unwrap();
        let default_port = remote.port;
        assert_ne!(default_port, 0);
        let empty = Config::parse("").unwrap();
        assert_eq!(home_listener_config(remote.clone(), &empty).unwrap().port, default_port);
        let local = Config::parse("host: 127.0.0.1\nport: 9345\ntls:\n  enable: true\n  cert: local.crt\n  key: local.key\nworker-threads: 3\nrequest-retry: 99\napi-keys: [local-key]\n").unwrap();
        let merged = home_listener_config(remote, &local).unwrap();
        assert_eq!(merged.host, "127.0.0.1");
        assert_eq!(merged.port, 9345);
        assert_eq!(merged.document["server"]["tls"], local.document["server"]["tls"]);
        assert_eq!(merged.document["worker-threads"], local.document["worker-threads"]);
        assert_eq!(merged.document["routing"]["retry"]["request-retry"].as_i64(), Some(7));
        assert!(merged.api_keys.is_empty());
        let updated = home::overlay(b"port: 9999\nhost: 0.0.0.0\n", Some(&merged)).unwrap();
        assert_eq!(updated.host, "127.0.0.1");
        assert_eq!(updated.port, 9345);
    }

    #[test]
    fn live_remote_store_selection_is_rejected_without_touching_it() {
        for key in ["PGSTORE_DSN", "OBJECTSTORE_ENDPOINT", "GITSTORE_GIT_URL", "pgstore_dsn"] {
            let error = reject_remote_store(&|name| (name == key).then(|| "fake-secret".to_owned()))
                .unwrap_err()
                .to_string();
            assert!(error.contains("config import"));
            assert!(error.contains("persistent volume"));
            assert!(!error.contains("fake-secret"));
        }
        reject_remote_store(&|_| None).unwrap();
        reject_remote_store(&|_| Some("  ".to_owned())).unwrap();
    }

    #[test]
    fn an_existing_database_does_not_reread_the_import_file() {
        let dir = std::env::temp_dir().join(format!(
            "cpa-import-once-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("cook.db");
        let file = dir.join("config.yaml");
        std::fs::write(&file, "port: 9\n").unwrap();
        assert_eq!(load_config(&db, &file, false).unwrap().1.port, 9);
        std::fs::write(&file, "port: 10\n").unwrap();
        assert_eq!(load_config(&db, &file, false).unwrap().1.port, 9);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn explicit_host_listener_is_nonblocking_for_tokio() {
        let listener = bind("127.0.0.1", 0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let client = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port));
        let (client, accepted) = tokio::join!(client, listener.accept());
        assert!(client.is_ok() && accepted.is_ok());
    }

    #[test]
    fn empty_host_is_dual_stack_and_port_in_use_is_an_error() {
        let listener = bind("", 0).unwrap();
        let port = listener.local_addr().unwrap().port();
        if listener.local_addr().unwrap().is_ipv6() {
            std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("IPv4 reaches the [::] listener");
            std::net::TcpStream::connect((Ipv6Addr::LOCALHOST, port)).expect("IPv6 reaches the [::] listener");
        }
        let err = bind("", port).unwrap_err();
        assert_eq!(
            err.kind(),
            io::ErrorKind::AddrInUse,
            "must not silently fall back to IPv4"
        );
    }
}
