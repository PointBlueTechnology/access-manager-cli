# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.2.0

- `afc` commands for the Advanced File Configurator, on Identity Server clusters: `list`, `upload` (one file at a time; replacing keeps the file's description and settings), `send` with `--wait`, `fetch` (any file from a server, current or the first or last copy AFC kept), `get` (AFC's saved copy), `remove` (deletes added files from the servers, puts product files back to the original) and `untrack`
- Requests under `/roma/` go to the console's older REST API, with the same credentials

## 0.1.0

First release.

- Read Identity Server clusters, authentication classes, methods, contracts and user stores, by display name or ID
- Create, update and delete classes, methods and contracts; properties merge into what's there
- `apply`: create or update a whole configuration from a JSON file, idempotently, with `${env:NAME}` for secrets; `--delete` removes it
- `update`: the console's Update, optionally waiting until every server reports CURRENT
- `api`: list the console API's operations, or call any of them
- JSON output, stable error codes and exit codes, `describe` for agents, secrets redacted, `--yes` and `--dry-run` guards
