---
name: amcli
description: Read and change an OpenText Access Manager (NAM) Identity Server's configuration with the amcli command-line tool - authentication classes, methods, contracts, user stores, and the console's Update. Use when asked to inspect or script Access Manager / NAM / NetIQ Access Manager Admin Console settings, set up or tear down test contracts, deploy an authentication configuration, or apply changes to Identity Servers.
---

# amcli

`amcli` is a JSON-first CLI for the Access Manager Administration Console API.

## Before anything else

- Run `amcli describe` to see every command and option. Don't guess flags.
- Run `amcli ping` to check the connection. Settings come from `AMCLI_URL`, `AMCLI_USER`, `AMCLI_PASSWORD` or `AMCLI_PASSWORD_FILE`, `AMCLI_CA_FILE` and `AMCLI_CLUSTER`, or from a settings file (`--settings <file>` or `AMCLI_ENV_FILE`; not `--env-file`, which Node.js intercepts). Never pass or print a password.
- Run `amcli status` to see if an Update is already pending.

## Reading

```bash
amcli contract list
amcli method get PasskeyLogin        # names resolve to console IDs for you
amcli class get Passkey1             # secrets show as <redacted>
```

## Changing

1. Dry run first: `amcli method update PasskeyLogin --prop ACCOUNT_CHECK=verify-rights --dry-run`
2. Then the same without `--dry-run`. Properties merge; `--unset NAME` removes one.
3. For several objects, write a JSON file and use `amcli apply -f file.json --dry-run`, then `amcli apply -f file.json`. Files use display names, and `${env:NAME}` for secrets.
4. Nothing reaches the Identity Servers until `amcli update --yes --wait`. It can interrupt service, so make sure the user agreed to an Update on this system.

## Files on the servers

- `amcli afc list` shows the files the Advanced File Configurator keeps.
- To change a server file: `amcli afc fetch <path> -o <file>`, edit, then `amcli afc upload <file> --dir <folder> --send --wait --yes`.
- One file at a time; never folders.
- A jar needs `--restart`, then `--send --update --yes`: that restarts the Identity Servers, so ask first.
- `amcli afc remove <path> --yes` deletes added files from the servers and restores product files; `afc untrack` only stops tracking. Ask first.

## Backups

`amcli export --out <new folder>` saves everything both console APIs can read (secrets blanked), with `manifest.json` listing skips and failures. `--reveal-secrets` only if the user asks; the folder then holds secrets.

If the amcli MCP server is connected (tools such as `class_get` and `report`), use its tools rather than the shell: they take the same inputs as the flags here (`yes: true`, `dry-run: true`).

For regular backups use `amcli backup <folder> --exit-code`: a dated export, what changed since the last backup, expiring certificates, and the oldest removed beyond `--keep`. Exit 9 means something changed or a certificate needs attention; read `changes` and `certificates` in the result. It removes only the dated folders it made.

## Reports

- Before changing or deleting a contract, method or class: `amcli report --markdown <file>` shows what uses it (`--ag` adds Access Gateway resources).
- `amcli diff <export> --live --summary` shows what changed since a backup.
- `amcli certs list --expiring 30`; `amcli saml list` / `get` / `metadata`.

## Cleaning up

`amcli apply -f file.json --delete --yes` removes what a file lists (contracts, then methods, then classes); then `amcli update --yes --wait`. Ask before deleting anything you didn't create.

## Errors

Failures print `{"error": {"code", "message"}}` on stderr. Exit codes: 2 usage, 3 not found (see `error.details.available`), 4 authentication, 5 rejected by the console, 6 connection, 7 timeout, 8 needs `--yes`. Exit 9 isn't an error: `diff --exit-code`, `certs list --fail` or `backup --exit-code` found something.
