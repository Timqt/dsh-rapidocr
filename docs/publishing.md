# Publishing `dsh-rapidocr` to npm

The package is not on npm yet. `npm publish` currently fails with:

```
npm error 403 403 Forbidden - PUT https://registry.npmjs.org/dsh-rapidocr
npm error Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

This is npm's account-level policy, not a problem with the package. npm now
requires **either** two-factor authentication on the account **or** a granular
access token with "Bypass 2FA" enabled for creating and publishing any package.

## Why it fails today

| Fact | Value |
|---|---|
| npm account | `timq` (`fly9318@qq.com`, email verified) |
| Account 2FA | **disabled** |
| Token in `~/.npmrc` | **expired** — `GET /-/whoami` returns `401` |
| Default profile registry | `https://registry.npmmirror.com` — a **read-only mirror**; publishing must target `registry.npmjs.org` |
| Package name `dsh-rapidocr` | free on npmjs.org |

## Recommended path: enable 2FA once, publish from CI without tokens

1. **Enable 2FA on the account.** Without this, neither interactive publishing
   nor a bypass token will be accepted.

   npm offers two second factors; pick one when the settings page asks:

   | Method | What you use | Good for |
   |---|---|---|
   | **Authenticator app (TOTP)** | a 6-digit code from 1Password / Authy / Google Authenticator / Microsoft Authenticator | CLI publishing, because `--otp` accepts the code directly |
   | **Security key (WebAuthn)** | Windows Hello (PIN / fingerprint / face), Touch ID, or a YubiKey | no shared secret to leak; the CLI opens a browser and you confirm there |

   Website flow: <https://www.npmjs.com/settings/timq/profile> →
   *Two-Factor Authentication* → **Enable 2FA** → confirm your password → choose
   the method → *Authorization and Writes* (not "authorization only": writes are
   what publishing needs).

   **Save the recovery codes** somewhere other than the 2FA device — they are the
   only way back in if the device is lost, and each works once. Be aware that
   *using* a recovery code to log in triggers a **72-hour security hold** during
   which publishing, token creation and settings changes are blocked, so keep the
   device reachable for the release you are about to do.

   The CLI can also do it (`npm profile enable-2fa auth-and-writes`), but it
   still needs a working login token first, and the token in `~/.npmrc` has
   expired, so the website is the shorter path here.

2. **Publish the current version by hand** so the package exists on npmjs.com. A
   Trusted Publisher can only be configured on a package that already exists.
   `packages/dsh-rapidocr/package.json` is at `0.1.1`, which has never been
   published to npm, so it is still free to use:

   ```powershell
   cd D:\feiniukexinhome\Code\DSH-rapidocr\packages\dsh-rapidocr
   npm publish --registry=https://registry.npmjs.org --access public
   ```

   With TOTP configured, append `--otp=<6-digit code>` (or let npm prompt you).
   With a security key, npm opens a browser tab where you confirm with Windows
   Hello — the `auth-type` in this profile is already `web`, which is what drives
   that flow.

3. **Add a Trusted Publisher** so later releases need no token at all:
   <https://www.npmjs.com/package/dsh-rapidocr/access> → *Trusted Publisher* →
   *GitHub Actions*, with:

   | Field | Value |
   |---|---|
   | Organization or user | `Timqt` |
   | Repository | `dsh-rapidocr` |
   | Workflow filename | `publish.yml` |
   | Allowed actions | allow `npm publish` (not just `npm stage publish`) |

4. **Release with a tag.** [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
   then publishes on any `v*` tag push, signed with OIDC and accompanied by a
   provenance attestation. Because `0.1.1` is the first npm release, the next
   CI-published release is `0.1.2`:

   ```powershell
   # bump packages/dsh-rapidocr/package.json to 0.1.2 first
   cd D:\feiniukexinhome\Code\DSH-rapidocr
   git tag -a v0.1.2 -m "dsh-rapidocr 0.1.2"
   git push origin v0.1.2
   ```

## Alternative: granular access token with bypass 2FA

Use this instead of step 2 if you would rather not do an interactive publish.
By the npm docs, the bypass checkbox is only meaningful once account 2FA exists,
so step 1 is still required.

1. <https://www.npmjs.com/settings/timq/tokens> → *Generate New Token* →
   **Granular Access Token**.
2. Name it e.g. `dsh-rapidocr-publish`.
3. **Check "Bypass two-factor authentication"** — this is the flag that makes
   non-interactive publishing possible.
4. *Packages and scopes*: **Read and write**, scoped to `dsh-rapidocr` (or all
   packages).
5. Set an expiration (90 days is a reasonable default).
6. Copy the token once — npm never shows it again.
7. Store it, then publish. Keep it out of shell history and out of this repo:

   ```powershell
   # writes the token to ~/.npmrc; do not paste tokens into chat or commit them
   npm config set //registry.npmjs.org/:_authToken=<token>
   npm publish --registry=https://registry.npmjs.org --access public
   ```

   For CI, put it in a GitHub secret named `NPM_TOKEN` instead and add
   `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the publish step. The checked-in
   `publish.yml` deliberately uses OIDC and needs no secret.

## Things to watch out for

* **Always pass `--registry=https://registry.npmjs.org`.** The profile's default
  registry is the npmmirror mirror, which cannot accept publishes; a plain
  `npm publish` would fail with a confusing error.
* **`npm login` also needs `--registry`.** Logging in against the mirror mints a
  token that npmjs.org rejects.
* **Local npm tokens expire.** The one stored in `~/.npmrc` died within days;
  re-run `npm login` when `npm whoami` starts returning 401.
* **The tag must equal `package.json`'s version.** `publish.yml` fails the job
  when they disagree, so bump the version before tagging.
* **Never republish a version.** npm rejects a version that already exists, so
  every release needs a fresh `version` in `packages/dsh-rapidocr/package.json`
  plus a matching `vX.Y.Z` tag. Git tags and npm versions are separate
  namespaces: the first npm release can be `0.1.1` even though `0.1.0` already
  exists as a git tag.

## After the first npm release

Reply on the market listing issue
(<https://github.com/polang233/dsh-plugin-index/issues/286>) saying the npm
package is live. The index follows npm's `latest` tag for npm-sourced plugins,
which means future releases no longer need a maintainer to re-check a pinned
commit.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
