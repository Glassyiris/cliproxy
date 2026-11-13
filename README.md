# cook-router
Cook Router is an AI Gateway, renew by prep-cook teams

Currently in the development and refactoring phase

## Run

cook-router ships as the Docker image `ghcr.io/prep-cook/cook-router` (tags `<version>` such as `0.3.0`, and `latest`) for linux/amd64 and linux/arm64. The container runs as uid and gid 10001, so the data directory must belong to that user.

```sh
mkdir -m 700 -p data
$EDITOR data/config.yaml        # first import only: server.host "", port 8317, access.api-keys, management.secret-key, management.allow-remote true
sudo chown -R 10001:10001 data
docker run -d --name cook-router -p 127.0.0.1:8317:8317 -v "$PWD/data:/data" ghcr.io/prep-cook/cook-router:latest --db /data/cook.db --config /data/config.yaml
```

Open <http://127.0.0.1:8317/management.html> and sign in with `management.secret-key`. See [docs/INSTALL.md](docs/INSTALL.md) for the config file, upgrades, backups and building from source.
