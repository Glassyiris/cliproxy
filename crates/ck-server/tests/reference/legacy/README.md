# v0 management goldens

`../../fixtures/legacy_go.json` holds Go's answers to the v0 management routes
(`/v0/management/...`) at CLIProxyAPI v8.0.35 (`ae3ee3be`), recorded by `main.go` through a
complete `api.NewServer` behind `httptest`: exact status and body for every request,
the exact `GET /v0/management/config` body after every write, and for v8 files the
key-group names in the saved file after every write. No sockets are
opened and no provider, GitHub or OAuth endpoint is called; secrets are `fake-*`.

The generator is overlaid into the reference module, which stays unmodified. Run
it with external network denied (for example inside `unshare -rn` with
`GOPROXY=off GOTOOLCHAIN=local`, after `go mod download`):

```sh
reference=/absolute/path/to/CLIProxyAPI   # at ae3ee3be, Go 1.26.4
here=$PWD                                 # this directory
crate=$(cd ../../.. && pwd)               # crates/ck-server
echo "{\"Replace\": {\"$reference/cmd/zzlegacy/main.go\": \"$here/main.go\"}}" > /tmp/legacy-overlay.json
(cd "$reference" && go run -overlay /tmp/legacy-overlay.json ./cmd/zzlegacy "$crate/tests/fixtures/legacy_go.json")
```

Go's harness registers no credentials, so its key lists carry no `auth-index`; the
Rust replay strips that field and `v0_aliases_match_v8_and_lists_carry_live_auth_indexes`
checks the indexes against the synthesized credentials instead.
