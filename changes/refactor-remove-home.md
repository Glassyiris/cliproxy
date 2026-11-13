Removed

- Home mode is removed: the Home control-plane client and its flags `--home-jwt` and `--home-disable-cluster-discovery`, the `HOME_JWT` variable, Home credential dispatch, Home plugin sync and the `X-CPA-HOME-VERSION` and `X-CPA-HOME-BUILD-DATE` headers.
- The config keys `credentials.concurrency` and `credentials.in-flight` (legacy `credential-concurrency` and `credential-in-flight`) are removed. YAML import and management writes now reject them as unknown keys.
