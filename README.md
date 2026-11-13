# amcli: OpenText Access Manager from the command line

A command-line client for the OpenText Access Manager (NAM) Administration Console API. It reads and changes Identity Server authentication classes, methods and contracts, applies whole configurations from a file, and runs the console's Update, so test setups and deployments can be scripted. It's made to be driven by scripts and AI agents: every result is JSON, errors have stable codes, secrets are hidden, and anything destructive needs `--yes`.

> **Not an OpenText product.** This is an independent project by PointBlue Technology. It isn't made, endorsed or supported by OpenText, so please don't contact OpenText support about it; use this repository's [issues](https://github.com/PointBlueTechnology/access-manager-cli/issues) instead. It uses the REST API that Access Manager's Administration Console publishes.

> **Implementation and support services** are available from [Idenhaus Consulting](https://idenhaus.com).

> **Early release.** Tested against Access Manager 5.1.3 with one Identity Server cluster. Try it on a test system first.

## Contents

- [Requirements](#requirements)
- [Installing](#installing)
- [Connecting](#connecting)
- [Commands](#commands)
- [Configuration files](#configuration-files)
- [For scripts and agents](#for-scripts-and-agents)
- [Status](#status)
- [Developing](#developing)

## Requirements

- Node.js 20.12 or later
- An Access Manager Administration Console (tested with 5.1.3) and a console administrator account

## Installing

```bash
npm install -g github:PointBlueTechnology/access-manager-cli
```

Or run it without installing: `npx github:PointBlueTechnology/access-manager-cli describe`.

## Connecting

Settings come from environment variables, or from an env file given with `--env-file` or `AMCLI_ENV_FILE`:

| Variable | Meaning |
|---|---|
| `AMCLI_URL` | The Administration Console, for example `https://ac.example.com:8443` (`/nps` is added) |
| `AMCLI_USER` | Console administrator (default `admin`) |
| `AMCLI_PASSWORD` or `AMCLI_PASSWORD_FILE` | Its password, or a file holding it. `--password-stdin` reads it from stdin. It's never accepted as a flag, where it would show in process lists and shell history |
| `AMCLI_CA_FILE` | PEM file of the CA that signed the console's certificate |
| `AMCLI_INSECURE=1` | Skip certificate checks. For test systems only |
| `AMCLI_CLUSTER` | The Identity Server cluster, by name or ID. Not needed when there's only one |
| `AMCLI_TIMEOUT_MS` | Per-request timeout (default 60000) |

```bash
export AMCLI_URL=https://ac.example.com:8443 AMCLI_PASSWORD_FILE=~/.amcli-password AMCLI_CA_FILE=~/ac-ca.pem
amcli ping
```

## Commands

Run `amcli help` for the list, `amcli help <command>` for one command, and `amcli describe` for all of it as JSON.

| Command | Does |
|---|---|
| `ping` | Checks the URL and credentials |
| `clusters`, `status` | Identity Server clusters; the cluster's update and health status, and what an Update would apply |
| `update --yes [--wait]` | Applies saved changes to the Identity Servers, as the console's **Update** does. `--wait` waits until every server reports `CURRENT` |
| `class`, `method`, `contract` `list` / `get` / `create` / `update` / `delete` | Authentication classes, methods and contracts, by display name or ID |
| `userstore list` / `get` | User stores |
| `apply -f <file>` | Creates or updates everything in a configuration file; `--delete` removes it |
| `api ops`, `api <METHOD> <path>` | Lists the console API's operations, or calls any of them |

Changes to classes, methods and contracts are saved in the console but reach the Identity Servers only when you run `amcli update --yes`, as in the console.

```bash
amcli method get PasskeyLogin
amcli method update PasskeyLogin --prop ACCOUNT_CHECK=verify-rights --dry-run
amcli method update PasskeyLogin --prop ACCOUNT_CHECK=verify-rights
amcli update --yes --wait
```

Properties given with `--prop NAME=VALUE` or `--props-file` are merged into what's there. `--unset NAME` removes one, and `--replace-props` replaces them all.

## Configuration files

`apply` takes a JSON file of the classes, methods and contracts that should exist, by display name. Methods name their class and user stores, and contracts name their methods, so the file never holds console IDs. See [examples/passkey-login.json](examples/passkey-login.json).

```json
{
  "methods": [
    { "name": "PasskeyLogin", "class": "Passkey1", "userStores": ["eDirectory"], "properties": { "MODE": "LOGIN" } }
  ],
  "contracts": [
    { "name": "PasskeyLogin", "uri": "/passkey/login", "methods": ["PasskeyLogin"], "cardId": "PasskeyLogin" }
  ]
}
```

- **Idempotent:** what exists and matches is left alone, so running it again changes nothing. `--dry-run` shows the plan first.
- **Merged properties:** properties the file doesn't mention are kept. Set `"replaceProperties": true` to replace them.
- **Secrets stay out of the file:** a value written `${env:NAME}` is read from the environment.
- **Teardown:** `apply -f <file> --delete --yes` removes what the file lists, contracts first, then methods, then classes.

This suits test setups: apply a file, run `amcli update --yes --wait`, test, then apply it again with `--delete` and update.

Contract fields: `name`, `uri`, `methods`, `cardId` (default: the name), `cardText`, `image` (default `AAFIDOU2F`), `timeout` (minutes, default 60), `trustLevel`, `allowProxying` and `properties`. Method fields: `name`, `class`, `userStores`, `identifiesUser` (default true), `overwriteRealUser`, `overwriteTempUser` and `properties`. Class fields: `name`, `javaClass`, `typeId` and `properties`.

## For scripts and agents

- **One JSON document on stdout** for every result; progress messages go to stderr (`--quiet` stops them).
- **Errors** are `{"error": {"code": ..., "message": ...}}` on stderr, with an exit code to match: 2 usage, 3 not found, 4 authentication, 5 rejected by the console, 6 connection, 7 timeout, 8 needs `--yes`.
- **Self-describing:** `amcli describe` lists every command, option, setting and exit code as JSON.
- **Secrets hidden:** passwords, keys, tokens and values such as a recovery pepper print as `<redacted>`, including in `api` output and dry-run plans. `--reveal-secrets` turns this off.
- **Guarded:** deletes, `update` and raw `api` calls other than GET need `--yes`; every write takes `--dry-run`.

[AGENTS.md](AGENTS.md) is a short guide for coding agents, and [skills/amcli/SKILL.md](skills/amcli/SKILL.md) is a Claude skill with the same guidance.

## Status

| Area | |
|---|---|
| Tested on Access Manager 5.1.3 | Reading clusters, classes, methods, contracts and user stores; `apply` creating and deleting methods and contracts; `update --wait`; redaction of the Passkey class's recovery pepper |
| **Not yet** | Uploading files through the Advanced File Configurator (for deploying custom classes and JSPs); creating user stores; Access Gateway clusters; clusters with more than one Identity Server; Access Manager 26.x |

## Developing

Needs Node.js 22.18 or later, which runs the TypeScript sources directly.

```bash
npm install
npm run check          # type-check
npm test               # unit tests, against an in-memory console
npm run amcli -- describe
npm run build          # compiles to dist/ for the npm package
```

## License

[MIT](LICENSE)
