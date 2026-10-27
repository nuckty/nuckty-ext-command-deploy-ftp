# @nuckty/ext-command-deploy-ftp

> **Publish a built artifact over FTP/FTPS — the `deploy-ftp` command.**

A command extension for [nuckty](https://github.com/nuckty/nuckty). It publishes `outDir` using `manifest.json`: new and changed files are uploaded, and remote orphans are deleted. FTP or FTPS is required; SSH, rsync, and Git on the server are not.

## What it adds

One CLI command, registered through `env.commands`:

```
nuckty deploy-ftp [target] [--force] [--dry-run]
```

- `target` — selects a target from `config/config-nuckty.ts`; no argument selects the first declared target, and unknown names fail before connecting.
- `--force` — uploads every local file and bypasses the mass-deletion guard; orphan deletion remains enabled.
- `--dry-run` — reads the server and reports the plan without changing local or remote files.

## How it works

1. Validates the local manifest, relative paths, file containment, sizes and MD5 hashes before connecting.
2. Lists every remote directory; any failed listing aborts the deployment.
3. Without `--force`, downloads a manifest when the complete listing contains it; a failed download or invalid manifest aborts. Absence is determined by the listing, not an FTP error code. `--force` skips the download and uploads every local file.
4. Computes uploads and deletions, applies the mass-deletion guard, creates upload directories and transfers content. Failed uploads stop the deployment before deletions.
5. Deletes orphans, verifies the complete listing and retries missing or mismatched uploads. Upload, deletion or verification failures prevent publication of the manifest.
6. Uploads `manifest.json` last; a failed manifest transfer fails the command. This is not an atomic publication of the entire site: files already transferred remain on the server if a later operation fails.

### Mass-deletion guard

If the share of files to delete exceeds a threshold (default 30%), the command stops and points to `--force` — to protect against an accidental wipe.

## Credentials

Credentials come from `config/auth-ftp.json` (keep it out of version control) or `FTP_HOST`, `FTP_USER`, `FTP_PASSWORD`, `FTP_PATH`, optional `FTP_PORT` and `FTP_SECURE`. A complete environment configuration takes precedence over the file.

Plain passive FTP remains the default. Set JSON `secure: true` or `FTP_SECURE=true` for explicit FTPS with normal certificate and hostname verification. `false` selects plain FTP; other values are rejected. A TLS failure fails the connection and never falls back to plain FTP. For a private CA, configure Node's trusted CA certificates rather than disabling certificate verification.

The core does not depend on `basic-ftp`; the extension does, and the import is lazy — `register(env)` does not load it.

## How to load

This example extends the quickstart with the standard `@nuckty/ext-block-root` document handler. Add the new extension to `ext` in the global `config/config-nuckty.ts`, retaining the other entries. If you use a custom document handler, keep its registration instead of `@nuckty/ext-block-root`.

```ts
import { defineNucktyConfig } from '@nuckty/core';

export default defineNucktyConfig({
    targets: { main: { configDir: 'config/', outDir: 'site/' } },
    ext: ['@nuckty/ext-block-root', '@nuckty/ext-command-deploy-ftp'],
});
```

## Contract

`register(env: NucktyEnv)` registers the command through `env.commands.add` and declares `force` and `dry-run` as boolean flags.

## Spec

Behavior is fixed by the openspec `ext-command-deploy-ftp` spec (`openspec/specs/ext-command-deploy-ftp/spec.md`): deploy command, manifest-driven diff and minimal operations, mass-deletion guard, passive FTP and explicit FTPS.


Before connecting, the command verifies every local file size and MD5 against the manifest. It repeats verification before the final manifest transfer and rejects a changed artifact. Remote verification uses LIST and size; it does not independently verify remote content hashes. Do not modify an artifact during deployment.

## License

MIT.
