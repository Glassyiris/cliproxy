Removed

- The dashboard no longer redirects the old page hashes (`#providers`, `#keys`, `#use`, `#usage`, `#logs`, `#payload`, `#config`, `#configuration`, `#plugins`, `#credentials`, `#quotas`, `#connect`, `#oauth`, `#system`); a bookmark to one opens Overview.
- The dashboard no longer shows the "Legacy layout, migrated on first save" note on Settings, and no longer reads the `cliproxy-rs-` version prefix.
- The dashboard's stored theme, palette, language, side-nav width and first-run flags move to `cook-router-*` keys, so those preferences reset once.
