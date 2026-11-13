# Using amcli from an agent

`amcli` drives an OpenText Access Manager Administration Console. These rules keep automated use safe and predictable.

## Start here

1. `amcli describe` gives every command, option, setting and exit code as JSON. Read it instead of guessing flags.
2. `amcli ping` confirms the URL and credentials. The credentials come from the environment (`AMCLI_URL`, `AMCLI_USER`, `AMCLI_PASSWORD` or `AMCLI_PASSWORD_FILE`) or an env file (`--env-file`). Never put a password on the command line, and never print or log one.
3. `amcli status` shows whether an Update is already pending before you change anything.

## Reading output

- stdout holds one JSON document. stderr holds progress lines and, on failure, `{"error": {"code", "message", ...}}`.
- Exit codes: 0 ok, 2 usage, 3 not found, 4 authentication, 5 rejected by the console, 6 connection, 7 timeout, 8 needs `--yes`.
- On exit 3, `error.details.available` lists the names that do exist.
- `<redacted>` marks a secret. Don't try to recover it with `--reveal-secrets` unless the user asks.

## Changing configuration

- Run every write with `--dry-run` first and check the plan.
- Prefer `amcli apply -f <file>` for anything with more than one object. It's idempotent and refers to things by name.
- `--prop` merges into existing properties; it never drops the ones you didn't mention. Use `--unset` to remove one.
- Changes only reach the Identity Servers after `amcli update --yes --wait`. An Update can interrupt service on the servers it touches, so run it only when the user has agreed to that for this system.
- Deletes need `--yes`. Confirm with the user before deleting anything you didn't create yourself.
- For a test setup, keep the file you applied and remove it afterwards with `amcli apply -f <file> --delete --yes`, then `amcli update --yes --wait`.

## Files on the servers

- `amcli afc fetch <path> -o <file>` gets a file as the server has it; edit it, then `amcli afc upload <file> --dir <folder> --send --wait --yes` posts it back to every server.
- Upload single files, never folders.
- `afc remove` deletes files you added from every server, and puts product files back to the original. `afc untrack` only makes AFC forget a file. Confirm with the user before either.

## Anything else

`amcli api ops --search <text>` finds console API operations, and `amcli api GET <path>` reads any of them. Raw writes (`amcli api POST|PUT|DELETE`) need `--yes`; prefer the dedicated commands, which check names and keep properties you didn't mention.
