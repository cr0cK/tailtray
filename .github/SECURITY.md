# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
<https://github.com/cr0cK/tailtray/security/advisories/new>. Do not open a public issue.

Include the Tailtray version, the GNOME Shell and `tailscale` versions, the steps to reproduce, and
the impact you observed. You can expect an acknowledgement within a week.

## Scope

Tailtray runs inside GNOME Shell and calls the `tailscale` command line; it stores no
credential and never elevates privileges. In scope: anything in this repository that could run unintended commands,
open unintended URLs, leak data from `tailscale`, or crash GNOME Shell. Vulnerabilities in GNOME Shell
or the Tailscale client themselves belong to their upstream projects.
