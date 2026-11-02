<!-- The PR title becomes the squash commit subject: use Conventional Commits, e.g. `feat: add ...`. -->

### Why

<!-- The goal, the trigger, or the bug this PR addresses. Link issues with `Closes #123`. -->

### What changes

<!-- The fix in a short paragraph; breaking changes and migration steps on their own line. -->

### Checklist

- [ ] `npm run lint` passes
- [ ] `make check` passes
- [ ] Tried in GNOME Shell (`scripts/sandbox.sh`, the headless recipe in AGENTS.md, or a real session), for user-visible changes
- [ ] `CHANGELOG.md` is left to release-please; README and the spec in `docs/specs/` are updated when the user-visible contract changes
