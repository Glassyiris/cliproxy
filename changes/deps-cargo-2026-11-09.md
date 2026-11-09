Changed

- Saving the config through the management API keeps flow-style sections such as `access: {api-keys: [a, b]}` as they are written. Before, changing a list inside one rewrote the whole file in block style and kept only the header comment.
- Rust dependencies are updated to tokio 1.54.1, hyper 1.12.0, yaml-edit 0.3.6, serde_json 1.0.154, libc 0.2.191 and other patch releases.
