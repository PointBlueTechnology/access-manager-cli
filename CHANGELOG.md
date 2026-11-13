# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0

First release.

- Read Identity Server clusters, authentication classes, methods, contracts and user stores, by display name or ID
- Create, update and delete classes, methods and contracts; properties merge into what's there
- `apply`: create or update a whole configuration from a JSON file, idempotently, with `${env:NAME}` for secrets; `--delete` removes it
- `update`: the console's Update, optionally waiting until every server reports CURRENT
- `api`: list the console API's operations, or call any of them
- JSON output, stable error codes and exit codes, `describe` for agents, secrets redacted, `--yes` and `--dry-run` guards
