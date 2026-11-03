# Contributing

Thanks for helping improve Tailtray. By participating, you agree to follow the
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Development setup

You need GNOME Shell 49 or 50, the Tailscale CLI (`tailscale`, only for a real run), GLib schema tools, Node.js 24, and
[pre-commit](https://pre-commit.com). Node.js is only used for development; the extension does
not need it at runtime.

~~~sh
npm ci                                # ESLint and its plugins
pre-commit install --install-hooks    # pre-commit and commit-msg hooks
~~~

## Layout

Everything that ships lives in `src/`; `make check` packs it into the extension zip. Unit
tests are in `tests/`, development scripts in `scripts/`, and product contracts in `docs/specs/`.

## Checks

~~~sh
npm run lint    # ESLint
make check      # GSettings schema, module parsing, unit tests, extension bundle in dist/
~~~

The hooks run ESLint, the unit tests, schema validation, gitleaks, typos, and file hygiene on
each commit, and check the commit message format. CI runs the same checks on every pull request.
Do not commit `dist/`.

## Trying a change

Tests and headless runs never touch your tailnet: `scripts/fake-tailscale` stands in for the CLI
(see its header for the files that control its replies). To run the current checkout without
touching your desktop session, use the windowed GNOME Shell sandbox (it requires `mutter-devel`
for the devkit):

~~~sh
scripts/sandbox.sh                # rebuilds, then opens the sandbox window with the real CLI
scripts/sandbox.sh --fake         # same, with the fake CLI; its replies are in ~/.cache/tailtray-sandbox/fake
scripts/sandbox.sh --reset        # same, from fresh settings
~~~

The sandbox keeps its extensions and settings in ~/.cache/tailtray-sandbox (override with
TAILTRAY_SANDBOX) on a private D-Bus session. The devkit window starts with a 1280x800 screen
and can take about 30 seconds to appear the first time. Close the window and run the script
again after a code change.

A user-visible change is also checked in a headless GNOME Shell:

~~~sh
scripts/verify.sh 2>/dev/null     # scenarios against the fake CLI; screenshots in dist/verify-shots
scripts/screenshots.sh            # rewrites docs/screenshots/*.png (needs ImageMagick)
~~~

The README shows the menu screenshots side by side at the same width; keep any new menu capture
in `crop_menus` of `scripts/screenshots.sh`.

## Code and documentation style

- Follow .editorconfig and the ESLint rules, which match the GNOME Shell code style.
- Keep source comments, documentation, metadata, and user-facing strings in English.
- Use GNOME Shell ES modules and GSettings for extension preferences.
- Keep subprocess calls as argument arrays; do not pass user or repository data through a shell.
- Never run `tailscale login`, `up` with a flag, `sudo`, or `pkexec`; Tailtray stores no credential.
- Update README.md and the relevant spec in docs/specs/ when a change affects the user-visible
  contract.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with an English
summary:

~~~text
<type>(<scope>): <summary>
~~~

Types are feat, fix, docs, style, refactor, perf, test, build, ci, chore, and revert; the scope
is optional. Pull requests are squash-merged, so the PR title becomes the commit subject and must
follow the same format.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Every merge to `main` updates a release pull request that bumps `package.json`, the
`version-name` in `src/metadata.json`, and CHANGELOG.md from the commit history: `feat` bumps the
minor version, `fix` the patch, and breaking changes the major version. `perf`, `refactor`,
and `revert` also release a patch; `docs`, `test`, `build`, `ci`, `chore`, and `style` never
trigger a release. Do not edit CHANGELOG.md by hand. Merging the release pull request tags
`vX.Y.Z`, publishes a GitHub Release, and attaches the installable extension zip. The integer
`version` field of src/metadata.json is left to extensions.gnome.org.

release-please opens the release pull request as a GitHub App, so its checks run without manual
approval. The App needs read and write access to Contents and Pull requests on this repository.
Its client ID goes in the `RELEASE_APP_CLIENT_ID` Actions variable and a private key in the
`RELEASE_APP_PRIVATE_KEY` Actions secret.
