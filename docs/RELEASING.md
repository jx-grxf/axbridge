# Releasing

1. Add a `## X.Y.Z` section to `CHANGELOG.md`; it becomes the release notes.
2. Raise `version` in `mcp/package.json` and `VERSION` in `mcp/src/version.ts`.
3. Commit, then tag: `git tag -a vX.Y.Z -m "axbridge X.Y.Z" && git push origin vX.Y.Z`.
4. The Release workflow tests, publishes `axbridge-mcp` to npm through trusted publishing
   (GitHub OIDC, no token) and creates the GitHub release. The Swift package is the tag.

Trusted publishing was set up once with
`npm trust github axbridge-mcp --file release.yml --repo jx-grxf/axbridge --allow-publish`.
