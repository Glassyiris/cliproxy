// Collects the license text of every npm package that ends up in the bundle, for
// tools/third-party-notices.py. Only active when GNOCCHI_NOTICES_OUT names a file, so a normal
// build emits nothing extra and ui/dist stays byte-identical. The notices are not part of dist
// and are not embedded in the binary; the repository's THIRD-PARTY-NOTICES carries them.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

interface Notice {
  name: string;
  version: string;
  license: string;
  text: string;
}

const LICENSE_FILE = /^(licen[sc]e|copying)(\.[a-z]+)?$/i;

// Root directory of the package a module or asset path lives in, or null outside node_modules.
function packageRoot(path: string): string | null {
  const clean = path.split("?")[0];
  const marker = clean.lastIndexOf("node_modules/");
  if (marker < 0 || (marker > 0 && clean[marker - 1] !== "/")) return null;
  const parts = clean.slice(marker + "node_modules/".length).split("/");
  const name = parts[0].startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  return join(clean.slice(0, marker), "node_modules", ...name);
}

function readNotice(root: string): Notice {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const file = readdirSync(root)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()[0];
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "");
  const text = file ? readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n").trim() : "";
  return { name: pkg.name, version: pkg.version, license, text };
}

export function noticesPlugin(): Plugin {
  const out = process.env.GNOCCHI_NOTICES_OUT;
  return {
    name: "gnocchi-notices",
    apply: "build",
    generateBundle(_options, bundle) {
      if (!out) return;
      const roots = new Set<string>();
      for (const item of Object.values(bundle)) {
        const paths = item.type === "chunk" ? item.moduleIds : (item.originalFileNames ?? []);
        for (const path of paths) {
          const root = packageRoot(path);
          if (root && existsSync(join(root, "package.json"))) roots.add(root);
        }
      }
      const notices = [...roots]
        .map(readNotice)
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(notices, null, 1)}\n`);
    },
  };
}
