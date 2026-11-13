// Refuses to test a server whose credentials could be real. Credentials live only in the
// server's database, so a test sign-in writes fake accounts into whichever database the
// server runs on, and isolated.sh isolates the network only, not the filesystem. The server
// must keep its credential store under the system temp dir, as reported by `auth_dir` in
// GET /admin/v1/credentials (the working directory beside its database, `<db>.credentials`).
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

/**
 * The real path of `dir` when it is a strict descendant of the real system temp dir; throws
 * otherwise. Symlinks are resolved first, so /tmp/x pointing at a real home directory is
 * refused, and a path that does not resolve is refused too.
 */
export function privateDir(dir) {
  let real, tmp;
  try {
    tmp = realpathSync(tmpdir());
    real = isAbsolute(dir) ? realpathSync(dir) : "";
  } catch (e) {
    throw new Error(`refusing to run: the credential store "${dir}" does not resolve (${e.code || e.message})`);
  }
  const rel = real && relative(tmp, real);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`refusing to run: the credential store "${dir}" is ${real ? `"${real}", ` : ""}not a private directory under ${tmp}`);
  return real;
}

/** `url` is the dashboard page or the server base; the API is looked up beside it. */
export async function assertPrivateCredentialStore(url, key) {
  const r = await fetch(new URL("admin/v1/credentials", new URL(".", url.endsWith("/") || /\.html$/.test(url) ? url : `${url}/`)), {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`refusing to run: GET /admin/v1/credentials answered ${r.status}, so the credential store is unknown`);
  const { auth_dir: dir } = await r.json();
  return privateDir(String(dir ?? ""));
}
