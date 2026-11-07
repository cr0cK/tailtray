# Specs

The specs of this repository, one file per spec code, follow the **spec delivery process** of the
`sdp` Claude Code plugin: `sdp:spec` designs a spec and its plans, `sdp:approve` gates them and
arbitrates the outbox, and `sdp:exec` implements the approved plans as stacked PRs. Each spec's
delivery is recorded as stamps in its tracking issue.

## Project settings

- **Owner**: `cr0cK`, with no other collaborator whose PR comments count as the owner's.
- **Releases**: release-please opens the release PR and tags `vX.Y.Z`; each spec ships in one
  minor version, and its `version` is that series, `vX.Y`.
- **Commits and PR titles**: Conventional Commits, squash-merged, so the PR title is the commit
  release-please reads. A spec PR is `docs:`, a plan PR is usually `feat:`.
- **Checks**: `npm run lint` and `make check` must pass. A user-visible change is verified in a
  headless GNOME Shell 49 driven by the agent, as AGENTS.md describes (`scripts/verify.sh
  2>/dev/null` runs the scenarios against `scripts/fake-tailscale`), with screenshots looked
  at; README screenshots live in `docs/screenshots/`.
- **Reviewers**: Codex read-only (`codex exec --sandbox read-only ... < /dev/null`), then Gemini
  through `agy` in plan mode with `--sandbox`, then a fresh-context agent.

## Specs

- `TRY`: the Tailtray panel menu: connection state, this device, accounts, exit nodes,
  Tailscale settings, other devices, and notifications. Tracking: #1.
- `SRV`: what this device shares with Tailscale Serve and Funnel, shown in the menu, with copy
  and stop. Builds on `TRY`. Tracking: #16.
