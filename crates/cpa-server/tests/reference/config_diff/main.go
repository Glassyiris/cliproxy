// Run inside pinned Go module with external networking denied. No real secrets.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/watcher/diff"
	"gopkg.in/yaml.v3"
)

func main() {
	root, err := os.MkdirTemp("", "cpa-diff-go-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(root)
	load := func(text string) *config.Config {
		path := filepath.Join(root, "config.yaml")
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			panic(err)
		}
		cfg, err := config.LoadConfig(path)
		if err != nil {
			panic(err)
		}
		cfg.AuthDir, err = util.ResolveAuthDir(cfg.AuthDir)
		if err != nil {
			panic(err)
		}
		return cfg
	}
	cases := []map[string]any{}
	pairs := [][2]string{
		{"", ""},
		{"", `client: {codex: {enable-apply-patch: true, optimize-multi-agent-v2: true}}
server:
  port: 9001
oauth:
  providers:
    aistudio:
      ws-auth: false
    antigravity:
      antigravity-credits: true
    devin: {sensitive-words: [c]}
    codex:
      live-media-relay: {enabled: true, max-sessions: 3, disable-private-remote-ips: true, public-ip: 1.2.3.4, udp-port-min: 4000, udp-port-max: 5000, ice-servers: [{urls: ['stun:fixture'], username: fixture-user, credential: fixture-secret}]}
observability:
  logs:
    debug: true
    logging-to-file: true
    request-log: true
    logs-max-total-size-mb: 45
    error-logs-max-files: 4
  pprof: {enable: true, addr: ' 127.0.0.1:9002 '}
  usage:
    usage-statistics-enabled: true
    redis-usage-queue-retention-seconds: 89
upstream:
  claude:
    disable-claude-cloak-mode: true
    disable-cloaking-model-list: true
  codex:
    disable-codex-cloaking: true
    stream-bootstrap-buffering: true
    stream-bootstrap-timeout: 3s
    orphan-delegation-compatibility: true
  xai: {inject-x-search: true}
multimedia:
  disable-image-generation: true
  gpt-image-2-base-model: ' custom '
requests:
  proxy-url: http://fixture-user:fixture-pass@127.0.0.1:9000/private?key=fixture-secret
  nonstream-keepalive-interval: 5
quota-exceeded:
  switch-project: true
  switch-preview-model: true
routing:
  strategy: fill-first
  cooldown:
    disable-cooling: true
    save-cooldown-status: true
    transient-error-cooldown-seconds: 12
  retry:
    request-retry: 2
    max-retry-credentials: 3
    max-retry-interval: 7
  force-model-prefix: true
management: {allow-remote: true, disable-control-panel: true, disable-auto-update-panel: true, panel-github-repository: 'https://user:pass@example.com/private?q=fixture-secret', base-url: 'https://user:pass@panel.test/private'}
`},
		{"access:\n  api-keys: [fixture-one, fixture-two]\n", "access:\n  api-keys: [fixture-three, fixture-four]\n"},
		{"access:\n  api-keys: [fixture-one]\n", "access:\n  api-keys: [fixture-two, fixture-three]\n"},
		{"", "requests:\n  payload: {default: [{models: [{name: a}], params: {key: fixture-secret}}], override: [{models: [{name: b}], params: {value: 5}}], filter: [{models: [{name: c}], params: [secret]}]}\n"},
		{"", "api-keys:\n  gemini:\n  - name: gemini-1\n    base-url: https://user:pass@gemini.test/path\n    keys:\n      - api-key: fixture-secret\n  claude:\n  - name: claude-1\n    keys:\n      - api-key: fixture-secret\n  codex:\n  - name: codex-1\n    base-url: https://codex.test\n    keys:\n      - api-key: fixture-secret\n  xai:\n  - name: xai-1\n    base-url: https://xai.test\n    keys:\n      - api-key: fixture-secret\n  meta:\n  - name: meta-1\n    keys:\n      - api-key: fixture-secret\n  vertex:\n  - name: vertex-1\n    keys:\n      - api-key: fixture-secret\n  interactions:\n  - name: interactions-1\n    keys:\n      - api-key: fixture-secret\n"},
		{"api-keys:\n  gemini:\n  - name: gemini-1\n    base-url: https://old.test\n    models: [{name: A, alias: B}]\n    keys:\n      - api-key: fixture-one\n", "api-keys:\n  gemini:\n  - name: gemini-1\n    base-url: https://user:pass@new.test/private\n    prefix: test\n    proxy-url: http://user:pass@proxy.test/private\n    models: [{name: A, alias: B, is-compat: true}]\n    headers: {X-Foo: fixture-secret}\n    excluded-models: [A,B]\n    disable-cooling: false\n    request-retry: 0\n    keys:\n      - api-key: fixture-two\n"},
		{"api-keys:\n  claude:\n  - name: claude-1\n    keys:\n      - api-key: fixture-one\n        cloak: {mode: auto}\n", "api-keys:\n  claude:\n  - name: claude-1\n    models: [{name: a, alias: b}]\n    keys:\n      - api-key: fixture-two\n        cloak: {mode: always, strict-mode: true, sensitive-words: [fixture-secret]}\n        rebuild-mid-system-message: true\n        fingerprint-profile: default\n"},
		{"api-keys:\n  codex:\n  - name: codex-1\n    base-url: https://codex.test\n    keys:\n      - api-key: fixture-one\n", "api-keys:\n  codex:\n  - name: codex-1\n    base-url: https://codex.test\n    disable-cooling: true\n    request-retry: 2\n    keys:\n      - api-key: fixture-two\n        websockets: true\n        alpha-search: true\n        disable-codex-cloaking: true\n"},
		{"oauth:\n  excluded-models: {codex: [A, B], claude: [a]}\n", "oauth:\n  excluded-models: {codex: [a, b, b], gemini: [b]}\n"},
		{"oauth:\n  model-alias: {codex: [{name: a, alias: b, display-name: Old}]}\n", "oauth:\n  model-alias: {codex: [{name: a, alias: b, display-name: New}], claude: [{name: c, alias: d, fork: true}]}\n"},
		{"oauth:\n  settings: {codex: [{name: a, max-context-length: 1024}, {name: b}]}\n", "oauth:\n  settings: {codex: [{name: b}, {name: a, max-context-length: 1024}]}\n"},
		{"oauth:\n  request-scoped-errors: {codex: [{status: 400, match: [a], action: request}]}\n", "oauth:\n  request-scoped-errors: {codex: [{status: 400, match: [b], action: request}], claude: [{status: 500, match-regexr: [error], action: cooldown}]}\n"},
		{"api-keys:\n  openai-compatibility:\n  - name: same\n    base-url: https://a.test\n    keys: [{api-key: fixture-one}]\n  - name: same\n    base-url: https://b.test\n    keys: []\n", "api-keys:\n  openai-compatibility:\n  - name: same\n    base-url: https://a.test\n    disabled: true\n    support-prompt-cache-key: true\n    disable-cooling: false\n    request-retry: 2\n    keys: [{api-key: fixture-two}]\n  - name: same\n    base-url: https://b.test\n    models: [{name: a}]\n    keys: []\n"},
	}
	for _, family := range []string{"gemini", "interactions", "claude", "codex", "xai", "meta", "vertex"} {
		key := func(fields string) string {
			return fmt.Sprintf("%s-api-key: [{api-key: fixture-key, base-url: https://fixture.test, %s}]\n", family, fields)
		}
		pairs = append(pairs,
			[2]string{key("disable-cooling: null, request-retry: null"), key("disable-cooling: false, request-retry: 0, priority: 3, websockets: true")},
			[2]string{key("models: [{name: A, alias: B}]"), key("models: [{name: A, alias: B, thinking: {min: 1, levels: [low, high]}}]")},
			[2]string{key("models: [{name: A, alias: B}]"), key("models: [{name: A, alias: B, is-compat: true}]")},
			[2]string{key("models: [{name: A, alias: B}, {name: C, alias: D}]"), key("models: [{name: C, alias: D}, {name: A, alias: B}, {name: A, alias: B}]")},
		)
	}
	pairs = append(pairs,
		[2]string{"requests:\n  payload: {default: [{models: [], params: {temperature: 1000000.0}}]}\n", "requests:\n  payload: {default: [{models: [], params: {temperature: 1000000.0}}]}\n"},
		[2]string{"requests:\n  payload: {default: [{models: [], params: {temperature: 1000000.0}}]}\n", "requests:\n  payload: {default: [{models: [], params: {temperature: 1000000}}]}\n"},
		[2]string{"requests:\n  payload: {filter: [{models: [], params: [42]}]}\n", "requests:\n  payload: {filter: [{models: [], params: ['42']}]}\n"},
		[2]string{"", "requests:\n  payload: {default: []}\noauth:\n  providers:\n    antigravity: {sensitive-words: []}\n"},
		[2]string{"access:\n  api-keys: [fixture-one]\n", "access:\n  api-keys: [fixture-one, fixture-one]\n"},
		[2]string{"requests:\n  payload: {default: [{params: {temperature: 1}}]}\n", "requests:\n  payload: {default: [{params: {temperature: 1.0}}]}\n"},
		[2]string{"api-keys:\n  gemini:\n  - name: gemini-1\n    models: [{name: a, thinking: {}}]\n    keys:\n      - api-key: fixture-key\n", "api-keys:\n  gemini:\n  - name: gemini-1\n    models: [{name: a, thinking: {levels: []}}]\n    keys:\n      - api-key: fixture-key\n"},
		[2]string{"access:\n  api-keys: [' fixture-one ']\n", "access:\n  api-keys: [fixture-one]\n"},
		[2]string{"requests:\n  proxy-url: http://user:password@same.test/old\n", "requests:\n  proxy-url: http://user:password@same.test/new\n"},
		[2]string{"upstream:\n  claude:\n    tool-search: false\napi-keys:\n  claude:\n  - name: claude-1\n    keys:\n      - api-key: fixture-key\n", "upstream: {claude: {tool-search: true}}\napi-keys:\n  claude:\n  - name: claude-1\n    keys:\n      - api-key: fixture-key\n        native-tool-search: true\n"},
	)
	for _, section := range []string{"default", "default-raw", "override", "override-raw", "filter"} {
		for _, field := range []string{"match", "not-match"} {
			rule := func(number string) string {
				match, notMatch := "[]", "[]"
				value := "[{temperature: " + number + "}]"
				if field == "match" {
					match = value
				} else {
					notMatch = value
				}
				params := "{temperature: '{}'}"
				if section == "filter" {
					params = "[temperature]"
				}
				return fmt.Sprintf("requests:\n  payload: {%s: [{models: [{name: fixture-model, headers: {}, match: %s, not-match: %s, exist: [], not-exist: []}], params: %s}]}\n", section, match, notMatch, params)
			}
			pairs = append(pairs, [2]string{rule("1"), rule("1.0")})
		}
	}
	for _, pair := range pairs {
		oldCfg, newCfg := load(pair[0]), load(pair[1])
		// Watcher rebuilds the old side from its own YAML snapshot, without loading
		// or re-sanitizing it; nil payload slices roundtrip as non-nil empty slices.
		previous, err := yaml.Marshal(oldCfg)
		if err != nil {
			panic(err)
		}
		var snapshot config.Config
		if err := yaml.Unmarshal(previous, &snapshot); err != nil {
			panic(err)
		}
		oldCfg = &snapshot
		cases = append(cases, map[string]any{"old": pair[0], "new": pair[1], "changes": diff.BuildConfigChangeDetails(oldCfg, newCfg)})
	}
	if err := json.NewEncoder(os.Stdout).Encode(cases); err != nil {
		panic(err)
	}
}
