/**
 * nuckty-ext-command-deploy-ftp — `nuckty deploy-ftp [target]` command-extension.
 *
 * Registers the `deploy-ftp` CLI command: manifest-driven FTP/FTPS deploy of
 * the selected target's outDir (basic-ftp, no SSH). FTP delivery belongs to
 * this extension; the core does not depend on basic-ftp.
 *
 * @module nuckty-ext-command-deploy-ftp
 */

import path from 'node:path';
import process from 'node:process';
import type { NucktyEnv, CommandArgs } from 'nuckty';
import type { DeployOpts, DeployResult } from './ftp.js';

export type FtpDeploy = (options: DeployOpts) => Promise<DeployResult>;

/** `nuckty deploy-ftp [target] [--force] [--dry-run]` — deploy the built site over FTP. */
export async function deployFtp(args: CommandArgs, inject?: { ftpDeploy?: FtpDeploy }): Promise<number> {
    // Lazy-import the ftp logic so `register(env)` does not pull `basic-ftp` —
    // only an actual `nuckty deploy-ftp` invocation pays that import cost (and
    // needs basic-ftp installed in the consumer, not the core).
    const target = args.positional[0];
    const unknownFlags = Object.keys(args.flags).filter((name) => !['force', 'dry-run'].includes(name));

    if (unknownFlags.length > 0) {
        process.stderr.write(`nuckty: deploy-ftp failed: unknown option(s): ${unknownFlags.map((name) => `--${name}`).join(', ')}\n`);

        return 1;
    }

    if (args.positional.length > 1) {
        process.stderr.write('nuckty: deploy-ftp failed: expected at most one target argument\n');

        return 1;
    }
    let force: boolean;
    let dryRun: boolean;

    try {
        force = readBooleanFlag(args.flags, 'force');
        dryRun = readBooleanFlag(args.flags, 'dry-run');
    } catch (error) {
        process.stderr.write(`nuckty: deploy-ftp failed: ${(error as Error).message}\n`);

        return 1;
    }
    // Resolve outDir BEFORE any plan: an unknown target name must fail before
    // basic-ftp is even imported — the acceptance is "unknown target does not
    // open an FTP connection".
    let outDir: string;
    try {
        outDir = resolveOutDir(args.config, target, args.cwd);
    } catch (e) {
        process.stderr.write(`nuckty: deploy-ftp failed: ${(e as Error).message}\n`);
        return 1;
    }
    try {
        const ftpDeploy = inject?.ftpDeploy ?? (await import('./ftp.js')).ftpDeploy;
        const result = await ftpDeploy({
            outDir,
            cwd: args.cwd,
            force,
            dryRun,
            progress: true,
        });
        process.stdout.write(
            `nuckty: deploy-ftp — ${result.stats.uploaded} uploaded, ${result.stats.deleted} deleted\n`,
        );
        return result.stats.errors === 0 ? 0 : 1;
    } catch (e) {
        process.stderr.write(`nuckty: deploy-ftp failed: ${(e as Error).message}\n`);
        return 1;
    }
}

function readBooleanFlag(flags: CommandArgs['flags'], name: 'force' | 'dry-run'): boolean {
    const value = flags[name];

    if (value === undefined) {
        return false;
    }
    if (value === true || value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error(`--${name} accepts only true or false`);
}

/**
 * Resolve the target's `outDir` from the loaded config. Contract (CMD-04):
 * no argument selects the first declared target; an
 * EXPLICIT unknown name is a hard error — a typo must never silently deploy
 * another target's artifact. There is no implicit `site/` fallback: consumers
 * declare their targets in `defineNucktyConfig`.
 */
export function resolveOutDir(
    config: CommandArgs['config'],
    target: string | undefined,
    cwd: string,
): string {
    const targets = config.targets ?? {};
    const names = Object.keys(targets);
    const name = target ?? names[0];
    if (name === undefined) {
        throw new Error('nuckty: no targets declared in the config — nothing to deploy');
    }
    const t = targets[name];
    if (!Object.hasOwn(targets, name) || !t) {
        throw new Error(
            `nuckty: unknown target "${target}". Known: ${names.join(', ')}`,
        );
    }
    if (typeof t.outDir !== 'string' || t.outDir.trim() === '') {
        throw new Error(`nuckty: target "${name}" must declare a nonempty outDir`);
    }

    return path.resolve(cwd, t.outDir);
}

export function register(env: NucktyEnv): void {
    env.commands.add(
        'deploy-ftp',
        'deploy the built site over FTP/FTPS',
        deployFtp,
        { booleanFlags: ['force', 'dry-run'] },
    );
}

export default register;

