use std::fmt::Write;
use std::io::Write as _;
use std::path::Path;

use flate2::{Compression, GzBuilder};

fn collect(path: &Path, files: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(path)
        .expect("the dashboard is required; run npm run build in ui")
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, files);
        } else {
            files.push(path);
        }
    }
}

fn main() {
    // ui/dist is not committed: `npm run build` in ui/ or the Dockerfile's dashboard stage
    // writes it.
    let root = Path::new("../../ui/dist")
        .canonicalize()
        .expect("ui/dist is required; run npm run build in ui");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    collect(&root, &mut files);
    files.sort();
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let mut output =
        String::from("fn dashboard_asset(path: &str) -> Option<(&'static [u8], &'static str, bool)> { match path {\n");
    for path in files {
        // The match key is a URL path, so it is joined with `/` on every host;
        // `display()` would give `\` on Windows. include_bytes! keeps the native path.
        let name: String = path
            .strip_prefix(&root)
            .unwrap()
            .components()
            .map(|part| format!("/{}", part.as_os_str().to_str().unwrap()))
            .collect();
        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or_default();
        let gzip = matches!(extension, "html" | "js" | "css" | "svg" | "json");
        let stored = if gzip {
            let target = out_dir.join(format!("{}.gz", name.trim_start_matches('/')));
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            let mut encoder = GzBuilder::new().mtime(0).write(Vec::new(), Compression::best());
            encoder.write_all(&std::fs::read(&path).unwrap()).unwrap();
            std::fs::write(&target, encoder.finish().unwrap()).unwrap();
            target
        } else {
            path.clone()
        };
        let mime = match extension {
            "html" => "text/html; charset=utf-8",
            "js" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "svg" => "image/svg+xml",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
        writeln!(
            output,
            "{name:?} => Some((include_bytes!({:?}), {mime:?}, {gzip})),",
            stored.to_str().unwrap()
        )
        .unwrap();
        // The page is served at /management.html (the URL the Go dashboard used) and the build
        // emits only index.html, so one file answers both.
        if name == "/index.html" {
            writeln!(
                output,
                "\"/management.html\" => Some((include_bytes!({:?}), {mime:?}, {gzip})),",
                stored.to_str().unwrap()
            )
            .unwrap();
        }
    }
    output.push_str("_ => None, } }\n");
    std::fs::write(out_dir.join("dashboard.rs"), output).unwrap();
}
