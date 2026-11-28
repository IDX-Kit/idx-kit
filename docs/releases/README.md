# TypeScript client releases

Install `@idx-kit/client` with `npm install --save-exact` and the tarball URL in the
[release notes](https://github.com/IDX-Kit/idx-kit/releases).

Import `@idx-kit/client` from your website's server code and keep your engine key
in server configuration. To upgrade or roll back, replace the URL in
`package.json` with the desired version's tarball URL, run `npm install`, and
commit `package.json` and the updated lockfile.

## Recover a client release

- **Missing tarball.** Find the release tag's commit in GitHub Releases. In
  Actions, download and unzip the `client-release-*` artifact from the CI run
  for the push to `main` at that commit. Remove any empty
  `idx-kit-client-<version>.tgz` upload and attach that file from the artifact.
  Rerun the `release-client` job that reported the missing file.
- **Tag conflict.** Set a new version in `packages/client/package.json` and in
  the `@idx-kit/client` pins in `packages/engine/package.json` and
  `examples/demo-site/package.json`. Refresh the root lockfile with
  `npm install --package-lock-only --ignore-scripts`. Add
  `docs/releases/client-v<version>.md` using the
  [first release notes](client-v0.1.0.md) as a template. Update the tag
  (`client-v<version>`) and tarball filename (`idx-kit-client-<version>.tgz`) in
  the notes' install URL, then merge to `main`.
