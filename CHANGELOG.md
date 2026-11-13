# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.3.0

- `apply --backup <file>` writes an apply file that undoes the run: changed settings go back to their old values, added ones are unset, created objects are removed and deleted ones come back. It's written 0600, since it can hold secrets, and refused if it already exists
- Apply files: `unsetProperties` and `replaceProperties` on each object, a `remove` section (contracts, methods, classes), `${env:NAME:-default}`, and `${file:path}` for long values such as certificates (relative to the file)
- `apply` asks for `--yes` whenever it would delete something
- `AMCLI_TLS_SERVERNAME`: check the console's certificate against a name while connecting by address
- Installing from GitHub builds the package (`prepare`)

## 0.2.0

- `afc` commands for the Advanced File Configurator, on Identity Server clusters: `list`, `upload` (one file at a time; replacing keeps the file's description and settings), `send` with `--wait`, `fetch` (any file from a server, current or the first or last copy AFC kept), `get` (AFC's saved copy), `remove` (deletes added files from the servers, puts product files back to the original) and `untrack`
- `afc upload` asks the console whether a file came with the product and records it that way, and `afc remove` sends that, so product files are put back rather than deleted
- Requests under `/roma/` go to the console's older REST API, with the same credentials

## 0.1.0

First release.

- Read Identity Server clusters, authentication classes, methods, contracts and user stores, by display name or ID
- Create, update and delete classes, methods and contracts; properties merge into what's there
- `apply`: create or update a whole configuration from a JSON file, idempotently, with `${env:NAME}` for secrets; `--delete` removes it
- `update`: the console's Update, optionally waiting until every server reports CURRENT
- `api`: list the console API's operations, or call any of them
- JSON output, stable error codes and exit codes, `describe` for agents, secrets redacted, `--yes` and `--dry-run` guards
