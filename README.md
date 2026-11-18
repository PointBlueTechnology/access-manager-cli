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
- [Exporting the configuration](#exporting-the-configuration)
- [Scheduled backups](#scheduled-backups)
- [Comparing configurations](#comparing-configurations)
- [What uses what](#what-uses-what)
- [SAML providers](#saml-providers)
- [Certificates](#certificates)
- [For scripts and agents](#for-scripts-and-agents)
- [AI agents over MCP](#ai-agents-over-mcp)
- [Status](#status)
- [Developing](#developing)
- [Security](#security)

## Requirements

- Node.js 20.12 or later
- An Access Manager Administration Console (tested with 5.1.3) and a console administrator account

## Installing

```bash
npm install -g github:PointBlueTechnology/access-manager-cli
```

Or run it without installing: `npx github:PointBlueTechnology/access-manager-cli describe`.

## Connecting

Settings come from environment variables, or from a file of them given with `--settings <file>` or `AMCLI_ENV_FILE`. Variables already set win over the file. In the file, relative paths for `AMCLI_CA_FILE` and `AMCLI_PASSWORD_FILE` are relative to the file itself, so it works from any folder. [.env.example](.env.example) lists them all; copy it to `.env`, which git ignores:

| Variable | Meaning |
|---|---|
| `AMCLI_URL` | The Administration Console, for example `https://ac.example.com:8443` (`/nps` is added) |
| `AMCLI_USER` | Console administrator (default `admin`) |
| `AMCLI_LEGACY_USER` | Its DN, for the older `/amsvc/v1` API that `export` also reads (default: `AMCLI_USER` if it's a DN, otherwise `cn=<AMCLI_USER>,o=novell`) |
| `AMCLI_PASSWORD` or `AMCLI_PASSWORD_FILE` | Its password, or a file holding it. `--password-stdin` reads it from stdin. It's never accepted as a flag, where it would show in process lists and shell history |
| `AMCLI_CA_FILE` | PEM file of the CA that signed the console's certificate |
| `AMCLI_TLS_SERVERNAME` | The name on the console's certificate, when `AMCLI_URL` uses an address |
| `AMCLI_INSECURE=1` | Skip certificate checks. For test systems only |
| `AMCLI_CLUSTER` | The Identity Server cluster, by name or ID. Not needed when there's only one |
| `AMCLI_TIMEOUT_MS` | Per-request timeout (default 60000) |

```bash
export AMCLI_URL=https://ac.example.com:8443 AMCLI_PASSWORD_FILE=~/.amcli-password AMCLI_CA_FILE=~/ac-ca.pem
amcli ping
```

`--env-file` also works, but avoid it. Node.js reads any `--env-file` on the command line itself, even after the program's name ([nodejs/node#54237](https://github.com/nodejs/node/pull/54237)), and exits with code 9 if the file is missing, before amcli starts. That looks like the "found something" exit code that `backup`, `diff` and `certs` use.

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
| `export --out <folder>` | Saves all the configuration the console's APIs can read, for backup and reference; see [Exporting the configuration](#exporting-the-configuration) |
| `backup <folder>` | For a schedule: a dated export, what changed since the last one, expiring certificates, and the oldest removed; see [Scheduled backups](#scheduled-backups) |
| `diff <export> [<export>]` | Compares two exports, or an export with the console now (`--live`); see [Comparing configurations](#comparing-configurations) |
| `report [<export>]` | What uses what: SAML providers and Access Gateway resources → contracts → methods → classes and user stores, and what nothing refers to; see [What uses what](#what-uses-what) |
| `saml list` / `get` / `metadata` / `create-sp` / `delete` / `attribute-maps` | SAML 2 service and identity providers; see [SAML providers](#saml-providers) |
| `certs list` / `get` | Certificates and trusted roots, with the days each has left; see [Certificates](#certificates) |
| `afc list` / `upload` / `send` / `fetch` / `get` / `remove` / `untrack` | Files on the servers, through the Advanced File Configurator; see [Files on the servers](#files-on-the-servers) |
| `mcp [--read-only]` | Runs amcli as an MCP server for AI agents, with every command as a tool; see [AI agents over MCP](#ai-agents-over-mcp) |
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
- **Merged properties:** properties the file doesn't mention are kept. On any object, `"unsetProperties": ["NAME"]` removes some and `"replaceProperties": true` replaces them all (or set it for the whole file).
- **Removing:** a `"remove": {"contracts": [...], "methods": [...], "classes": [...]}` section deletes those, after everything else, with `--yes`. `apply -f <file> --delete --yes` instead deletes everything the file lists, contracts first, then methods, then classes.
- **Values from elsewhere:** in any string, `${env:NAME}` reads the environment (`${env:NAME:-default}` with a fallback) and `${file:path}` reads a file, relative to the apply file. Secrets and long values such as certificates stay out of it.
- **Undo:** `--backup <file>` writes an apply file that reverses the run exactly: settings it changed go back to their old values, settings it added are removed, objects it created are deleted and objects it deleted come back. It only records what the run touched, but that can include secrets, so it's written readable by you alone, and an existing one is never overwritten.

This suits test setups:

```bash
amcli apply -f setup.json --backup restore.json && amcli update --yes --wait
# ...test...
amcli apply -f restore.json --yes && amcli update --yes --wait && rm restore.json
```

Contract fields: `name`, `uri`, `methods`, `cardId` (default: the name), `cardText`, `image` (default `AAFIDOU2F`), `timeout` (minutes, default 60), `trustLevel`, `allowProxying` and `properties`. Method fields: `name`, `class`, `userStores`, `identifiesUser` (default true), `overwriteRealUser`, `overwriteTempUser` and `properties`. Class fields: `name`, `javaClass`, `typeId` and `properties`.

## Files on the servers

The `afc` commands work with the console's Advanced File Configurator (AFC), which keeps copies of files such as a custom authentication class's jar and JSPs, and sends them to every Identity Server in the cluster, including servers added later.

| Command | Does | Console equivalent |
|---|---|---|
| `afc list` | The files AFC keeps for the cluster, and whether each reached every server | The file table |
| `afc upload <file> --dir <folder>` | Saves a file in the console; replacing one keeps its description and settings unless you give new ones. `--send --yes` also sends it | Upload |
| `afc send <path>... --yes [--wait] [--update]` | Copies saved files to the cluster's servers. `--update` then runs the Update that makes the servers apply them, restarting for files that need it | Send Configurations to Servers |
| `afc fetch <path> [-o file]` | Gets any file as a server has it now, tracked or not, to edit and post back with `afc upload`. `--version first` or `last` gets the copy AFC kept before it first or last changed the file | Download Configurations to Edit Offline |
| `afc get <path> [-o file]` | Gets AFC's own saved copy | Downloading a saved file |
| `afc remove <path>... --yes [--wait]` | Deletes files you added from every server; files that came with the product go back to their original version | Remove Configuration |
| `afc untrack <path>... --yes` | AFC stops managing the files, and the servers keep their copies | Untrack Configurations |

To change a file that came with Access Manager:

```bash
amcli afc fetch /opt/novell/nids/lib/webapp/jsp/nidp_latest.jsp -o nidp_latest.jsp
# edit nidp_latest.jsp
amcli afc upload nidp_latest.jsp --dir /opt/novell/nids/lib/webapp/jsp --send --wait --yes
```

To deploy a custom class, upload its jar and each JSP the same way, one file at a time. A jar only loads after the Identity Server restarts, so mark it with `--restart`. Sending copies it to the servers, and the console then shows an Update waiting; that Update restarts them. `--update` runs it and waits:

```bash
amcli afc upload my-class.jar --dir /opt/novell/nids/lib/webapp/WEB-INF/lib --restart --send --update --yes
```

Without `--update`, run `amcli update --type afc --yes --wait` when it suits you. Sending with `--restart` alone (the console's "restart straight away") didn't restart anything in testing; the Update did.

**One file at a time.** AFC can also upload whole folders, but several bugs have been reported with folder uploads, so `amcli` only uploads single files.

## Exporting the configuration

```bash
amcli export --out backup-2026-11-13
```

`export` reads everything the console's APIs will give and saves it in a new folder. It uses both APIs: the current one (`/nps`), and the older one (`/amsvc/v1`), which adds Access Gateway reverse proxies, proxy services and protected resources, policies, SAML providers and attribute maps, and certificates. Both describe themselves, so `export` finds every read operation and fills in the IDs from the matching lists: each class from the class list, each protected resource from its proxy service, and so on.

| In the folder | |
|---|---|
| `nps/…`, `amsvc/…` | One JSON file per read, laid out by its API path |
| `apply/<cluster>.json` | Each Identity Server cluster's classes, methods and contracts, as a file `amcli apply` takes |
| `afc/<cluster>/…` | With `--afc-files`: the files the Advanced File Configurator keeps |
| `manifest.json` | Every call, and every read skipped or failed, with the reason |

- **Never read:** operations that change something (a health refresh, a cache refresh), reach outside the console (update checks), return personal data (sessions, mobile users, LDAP groups) or return binaries.
- **Runtime state:** health, alerts, statistics and command logs only with `--runtime`.
- **Secrets:** blanked, as everywhere in amcli, so the folder is safe to share or keep in version control. The apply files then leave secrets out and merge, so applying one can't wipe a secret. `--reveal-secrets` keeps them, writes the folder readable by you alone, and makes the apply files restore everything exactly.
- **Not in use:** features the console isn't licensed or set up for (API management, Account Management) are listed as skipped, not failed.
- **Sign-in:** the older API wants the administrator's DN. amcli uses `AMCLI_USER` if it's a DN, otherwise `cn=<AMCLI_USER>,o=novell`; set `AMCLI_LEGACY_USER` if yours is elsewhere.

A full export of a test console with one Identity Server cluster took about 30 seconds and saved about 390 files.

## Scheduled backups

```bash
amcli backup /var/backups/amcli --keep 30 --exit-code
```

`backup` is `export` made for a schedule. Each run:

1. exports the console into a new folder named for the time, such as `2026-11-16T03-00-00Z`;
2. compares it with the previous backup, as `diff` does;
3. lists certificates that have expired or expire within `--expiring` days (default 30);
4. removes the oldest backups so that `--keep` remain (default 30).

The result says what changed and which certificates need attention. With `--exit-code` it exits 9 when either is the case, so a scheduler can alert on it. Beside each export, `_backup/` holds what the run worked out: `changes.json` (the full comparison), `certs.json`, `report.md` (what uses what, as `amcli report` writes it) and `backup.json` (the result). `diff` leaves `_backup/` out, so backups compare with each other and with other exports.

- **A failed run leaves nothing behind.** The export is written to `<name>.partial` and renamed when complete, and only complete backups count as the previous one or are ever removed. `backup` removes only folders it named, never anything else in the folder.
- **Expired certificates nothing uses** would alert every night. `--ignore-cert <name>` (repeatable) leaves them out.
- **Secrets** are blanked unless `--reveal-secrets`, as with `export`. Either way, a backup folder `backup` creates is readable by its owner alone, since it describes the whole setup.
- **What to alert on:** a configuration change, an expiring certificate, or the run failing (any other non-zero exit). Reads the console itself fails, listed in `manifest.json`, are counted in `failedReads` but don't alert, since some console versions always fail a few.

With cron, which mails a job's output, this mails the result only when something changed or the run failed:

```bash
0 3 * * * amcli --settings /etc/amcli/amcli.env -q backup /var/backups/amcli --exit-code > /var/log/amcli-backup.json 2>&1 || cat /var/log/amcli-backup.json
```

For systemd, [examples/backup](examples/backup) has a service and a nightly timer; exit 9 marks the run failed, so `OnFailure=` can send the alert. A run against a test console took about 40 seconds.

## Comparing configurations

```bash
amcli diff backup-monday backup-friday          # two exports
amcli diff backup-monday --live --exit-code     # an export and the console now; exit 9 if they differ
amcli diff test-export prod-export --only apply # two consoles' authentication setups, by name
```

`diff` pairs list items by their ID or name, so a reordered list isn't a change, and replaces each console's own address, so exports of different consoles compare. It leaves out what changes without anyone configuring anything: timestamps, whether an Update is waiting and server health (`--include-status` keeps those), and the document IDs and signatures the console puts in its own SAML metadata each time it's fetched. `--ignore <key>` leaves out more, `--summary` gives only counts and file names, and `--live --save <folder>` keeps the fresh export.

The console gives objects new IDs in each environment, so between different consoles compare the `apply` files (`--only apply`), which use names.

## What uses what

```bash
amcli report --ag --markdown usage.md
```

`report` shows, for each Identity Server cluster:

- each contract's methods, in order, and what uses it: SAML service providers, identity providers offered as a card in it, and Access Gateway protected resources;
- each method's class and user stores, and the contracts it's in; each class's methods;
- each SAML provider's contracts;
- each protected resource's proxy service, URL paths, contract and policies (with `--ag`);
- what nothing refers to: classes with no methods, methods in no contract, and contracts no provider or resource uses. A contract can still be used directly by its URL or card ID, which no report can see.

It works from an export folder (`amcli report <folder>`) or, without one, from a fresh export it deletes afterwards. Neither console API gives a protected resource's contract or policies, so `--ag` reads them from a Code Promotion export of the Access Gateway: the console makes it, amcli reads it and deletes it from the console straight away. `--markdown` also writes the tables to a file.

## SAML providers

| Command | Does |
|---|---|
| `saml list` | The SAML 2 service providers and identity providers the cluster trusts |
| `saml get <name\|id\|entityID>` | One provider's settings, with the contracts it uses by name |
| `saml metadata <provider> [-o file]` | Its metadata, as XML |
| `saml create-sp --name <name> --metadata <file>` | Trusts a new service provider from its metadata (or `--metadata-url`) |
| `saml delete <provider>... --yes` | Stops trusting providers |
| `saml attribute-maps` | The shared attribute maps |

Providers can be named by display name, console ID or entity ID. Changes reach the Identity Servers after `amcli update --yes`.

## Certificates

```bash
amcli certs list --expiring 30 --fail   # for monitoring: exit 9 if any expire within 30 days
amcli certs get my-trusted-root -o root.pem
```

`certs list` shows the console's keystore certificates and trusted roots, soonest to expire first, with the days each has left. `--expired`, `--expiring <days>` and `--trusted-roots` narrow it. `certs get` shows one, and saves a trusted root's PEM.

The console's APIs can't list keystores or create trusted roots, so `certs` reads only. Importing and deleting certificates are left to the console for now.

## For scripts and agents

- **One JSON document on stdout** for every result; progress messages go to stderr (`--quiet` stops them).
- **Errors** are `{"error": {"code": ..., "message": ...}}` on stderr, with an exit code to match: 2 usage, 3 not found, 4 authentication, 5 rejected by the console, 6 connection, 7 timeout, 8 needs `--yes`. Exit code 9 isn't an error: `diff --exit-code`, `certs list --fail` and `backup --exit-code` use it to say something was found.
- **Self-describing:** `amcli describe` lists every command, option, setting and exit code as JSON.
- **Secrets hidden:** passwords, keys, tokens and values such as a recovery pepper print as `<redacted>`, including in `api` output and dry-run plans. `--reveal-secrets` turns this off.
- **Guarded:** deletes, `update` and raw `api` calls other than GET need `--yes`; every write takes `--dry-run`.

[AGENTS.md](AGENTS.md) is a short guide for coding agents, and [skills/amcli/SKILL.md](skills/amcli/SKILL.md) is a Claude skill with the same guidance.

## AI agents over MCP

```bash
amcli --settings ~/.config/amcli/amcli.env mcp --read-only
```

`amcli mcp` runs amcli as a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so an AI agent can call it directly instead of running commands and reading their output. Every command is a tool, with its arguments and options as typed inputs. The tools are built from the same table as `amcli help`, so they always match the CLI.

To add it to Claude Code:

```bash
claude mcp add amcli -- amcli --settings /path/to/amcli.env mcp --read-only
```

Other MCP clients take the same command in their configuration:

```json
{
  "mcpServers": {
    "amcli": { "command": "amcli", "args": ["--settings", "/path/to/amcli.env", "mcp", "--read-only"] }
  }
}
```

- **Start with `--read-only`.** It offers only the tools that don't change the console: 25 of the 43. Leave it off only when the agent should make changes. `report` with `ag` still creates a Code Promotion export on the console to read, then deletes it.
- **The CLI's safety still applies.** Secrets are redacted. Deleting and `update` need `yes: true`, and every tool that changes the console takes `dry-run: true`. Each tool is marked read-only or destructive, so clients can ask you before calling one. `amcli mcp --reveal-secrets` turns off redaction for every call; avoid it.
- **Tools and inputs:** a tool is named after its command, with underscores (`saml_get`, `class_delete`). Arguments are named after the help text: `name`, `names` for several, `export` and `export2` for `diff`. Errors are tool results with the same `code` and `message` as on the command line.
- **Settings** are read on the first tool call. Put the password in `AMCLI_PASSWORD_FILE`; `--password-stdin` can't work, because stdin carries the protocol.
- **Calls run one at a time,** in the order they arrive.

Tested with the official MCP TypeScript SDK's client against Access Manager 5.1.3.

## Status

| Area | |
|---|---|
| Tested on Access Manager 5.1.3 | Reading clusters, classes, methods, contracts and user stores; `apply` creating and deleting methods and contracts; `update --wait`; redaction of the Passkey class's recovery pepper; with a file added to an Identity Server: `afc upload --send --wait`, replacing it, `afc fetch`, editing and posting it back, `afc get`, `afc untrack` and `afc remove`; with a product JSP: editing it, sending it, and `afc remove` putting the original back; deploying a custom class's jar with `--restart` and `update --type afc`, which restarted the Identity Server onto it; `export` of both APIs, with secrets blanked and with `--reveal-secrets`; `diff` of an export with the console, before and after a change; `report` with the Access Gateway; `saml` creating, reading and deleting a service provider; `certs` listing, expiry and a trusted root's PEM |
| **Not yet** | Access Gateway and Administration Console files; creating user stores; clusters with more than one Identity Server; Access Manager 26.x |

## Developing

Needs Node.js 22.18 or later, which runs the TypeScript sources directly.

```bash
npm install
npm run check          # type-check
npm test               # unit tests, against an in-memory console
npm run amcli -- describe
npm run build          # compiles to dist/ for the npm package
```

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
