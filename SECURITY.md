# Security policy

amcli signs in to an Access Manager Administration Console as an administrator and can change how its Identity Servers sign users in, so we take reports seriously.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through GitHub instead: on this repository, go to **Security > Report a vulnerability**. Include the amcli version, your Access Manager version, what you found, and how to reproduce it.

We'll acknowledge the report within a few working days, keep you informed, and credit you in the release notes if you'd like.

Examples of what we want to hear about: a password, key or other secret reaching amcli's output, an error, a log or a file it writes without `--reveal-secrets`; a change made without the `--yes` a command documents; certificate checks being skipped without `AMCLI_INSECURE`.

## Supported versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Anything older | No: please upgrade first |

## Scope

In scope: this repository's code, its documentation and the files `apply --backup` writes. Out of scope: Access Manager itself, its Administration Console and its API. Report problems in those to OpenText. This project isn't an OpenText product, so OpenText can't take reports about it.
