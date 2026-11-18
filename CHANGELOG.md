# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.6.1

- `--settings <file>` loads the settings file. Use it instead of `--env-file`: Node.js reads any `--env-file` on the command line itself (nodejs/node#54237) and exits with code 9 if the file is missing, before amcli starts, which looks like `backup --exit-code` finding something. `--env-file` still works as an alias, and `AMCLI_ENV_FILE` is unaffected
- The examples, `.env.example`, AGENTS.md and the skill use `--settings`

## 0.6.0

- `amcli backup <folder>`: an export made for a schedule. Each run exports into a new folder named for the time, compares it with the previous backup, lists certificates expired or expiring within `--expiring` days (default 30), writes the what-uses-what report, and removes the oldest so `--keep` remain (default 30). `--exit-code` exits 9 when the configuration changed or a certificate needs attention; `--ignore-cert` leaves out ones nothing uses. A failed run leaves nothing behind, and only folders `backup` named are ever removed
- [examples/backup](examples/backup): a systemd service and nightly timer
- `diff` leaves out the `_backup/` folder that `backup` writes beside each export
- `--version` and `help` work after global options, as in `amcli --env-file x --version`
- `describe` lists exit code 9

## 0.5.0

- `amcli diff`: compares two exports, or an export with the console now (`--live`). Lists are paired by ID or name, each console's address is normalized, and timestamps, pending-Update and health status and the generated parts of signed SAML metadata don't count. `--exit-code` exits 9 when they differ
- `amcli report`: what uses what. Contracts with their methods and what uses them (SAML providers, identity providers' cards, Access Gateway protected resources), methods with their class and user stores, and what nothing refers to. `--ag` reads protected resources' contracts and policies from a Code Promotion export, which it deletes from the console afterwards. `--markdown` writes the tables to a file
- `amcli saml`: list, get (with contracts by name), metadata, create-sp from metadata, delete, attribute-maps
- `amcli certs`: list with days left and `--expired`, `--expiring`, `--trusted-roots` and `--fail`; get, with a trusted root's PEM. Read-only: the APIs can't list keystores or create trusted roots
- `export` records answers that are a web page rather than data (as when a protocol is off) as skipped
- Reads password-protected (ZipCrypto) zips and the console's XML without dependencies

## 0.4.0

- `amcli export --out <folder>`: saves every configuration read the console's APIs offer, for backup and reference. It reads both the current API (/nps) and the older one (/amsvc/v1), which adds Access Gateway reverse proxies, proxy services and protected resources, policies, SAML providers and attribute maps, and certificates. Both describe themselves, so every read operation is found automatically, with IDs taken from the matching lists. Reads that change something, reach outside the console, return personal data or are binary are never made; runtime state only with `--runtime`. Also writes an `apply` file of each Identity Server cluster's classes, methods and contracts, and with `--afc-files` the files the Advanced File Configurator keeps. `manifest.json` lists every call, skip and failure. Secrets are blanked unless `--reveal-secrets`, which writes the folder readable by you alone and makes the apply files restorable
- The older /amsvc/v1 API signs in with the administrator's DN: `AMCLI_LEGACY_USER`, by default `AMCLI_USER` if it's a DN, otherwise `cn=<AMCLI_USER>,o=novell`
- Redaction no longer hides settings that only describe a secret, such as `tokenEndpoint`, `nidsTokenIssuer` or a password's minimum length

## 0.3.1

- `afc send --update` and `afc upload --send --update` run the Update that makes the servers apply AFC files, restarting them for files marked `--restart` (such as a custom class's jar), and wait for it. Without it, `afc send` says when that Update is waiting
- Tested deploying a custom class's jar: `--restart`, then `update --type afc`, restarted the Identity Server onto it. `afc send --restart` alone doesn't restart
- `--env-file` (or `AMCLI_ENV_FILE`) is loaded before an apply file is read, so `${env:NAME}` in the file can use values from it
- SECURITY.md; npm metadata (homepage, issues, keywords)

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
