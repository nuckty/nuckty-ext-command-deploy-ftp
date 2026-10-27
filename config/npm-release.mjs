import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const registry = 'https://registry.npmjs.org';

export function releasePlan(manifest, event, repository, sha, runs) {
    const expectedName = repository === 'nuckty/nuckty' ? '@nuckty/core' : `@nuckty/${repository.slice('nuckty/nuckty-'.length)}`;
    const version = manifest.version;

    assert.match(repository, /^nuckty\/nuckty(?:-ext-(?:block-(?:gallery|grid|root)|command-(?:content-external|convert-images|deploy-ftp|serve|validate-vnu)|markdown-(?:typography-ru|video)))?$/);
    assert.equal(manifest.name, expectedName, 'Package name must match the release repository.');
    versionParts(version);
    assert.equal(event.action, 'published');
    assert.equal(event.release.draft, false);
    assert.equal(event.release.tag_name, `v${version}`, 'Release tag must match package.json.');
    assert.equal(event.release.prerelease, version.includes('-'), 'GitHub prerelease status must match the version.');
    assert.ok(runs.some((run) => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success'), 'Release commit must have successful push CI on main.');

    return { name: manifest.name, version, channel: event.release.prerelease ? 'beta' : 'latest', sha };
}

function versionParts(version) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);

    assert.ok(match, 'Expected an exact semantic version without build metadata.');
    const prerelease = match[4]?.split('.') ?? [];

    assert.ok(prerelease.every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')), 'Numeric prerelease identifiers cannot have leading zeroes.');

    return { core: match.slice(1, 4).map(Number), prerelease };
}

export function compareVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);

    for (let index = 0; index < 3; index += 1) {
        if (a.core[index] !== b.core[index]) {
            return a.core[index] < b.core[index] ? -1 : 1;
        }
    }
    if (a.prerelease.length === 0 || b.prerelease.length === 0) {
        return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
    }
    for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
        const x = a.prerelease[index];
        const y = b.prerelease[index];

        if (x === y) {
            continue;
        }
        if (x === undefined || y === undefined) {
            return x === undefined ? -1 : 1;
        }
        const numericX = /^\d+$/.test(x);
        const numericY = /^\d+$/.test(y);

        if (numericX !== numericY) {
            return numericX ? -1 : 1;
        }

        return numericX ? (Number(x) < Number(y) ? -1 : 1) : (x < y ? -1 : 1);
    }

    return 0;
}

export function packArchive(directory = process.cwd()) {
    return JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: directory, encoding: 'utf8' }));
}

export function publishArguments(info, directory = process.cwd()) {
    assert.equal(info.filename, path.basename(info.filename));

    return ['publish', path.resolve(directory, 'release', info.filename), '--ignore-scripts', '--access', 'public', '--tag', info.channel, `--registry=${registry}`];
}

export function archiveInfo(plan, packs, bytes) {
    assert.equal(packs.length, 1);
    const pack = packs[0];

    assert.equal(pack.name, plan.name);
    assert.equal(pack.version, plan.version);
    assert.equal(pack.filename, path.basename(pack.filename));
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

    assert.equal(pack.integrity, integrity, 'Packed archive integrity mismatch.');

    return { ...plan, filename: pack.filename, integrity };
}

export function verifyMetadata(info, metadata, bytes) {
    assert.equal(metadata.name, info.name);
    assert.equal(metadata.version, info.version);
    assert.equal(metadata.dist.integrity, info.integrity, 'Published version differs from the tested archive.');
    const url = new URL(metadata.dist.tarball);

    assert.equal(url.origin, registry);
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, info.integrity, 'Public archive integrity mismatch.');
}

async function metadata(info, retryUnavailable = false) {
    const response = await fetch(`${registry}/${encodeURIComponent(info.name)}/${info.version}`, { headers: { 'cache-control': 'no-cache' } });

    if (response.status === 404 || (retryUnavailable && response.status === 503)) {
        return null;
    }
    assert.ok(response.ok, `Registry metadata returned ${response.status}.`);

    return response.json();
}

export async function verifyPublished(info) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const value = await metadata(info, true);

        if (value) {
            const url = new URL(value.dist.tarball);

            assert.equal(url.origin, registry);
            const response = await fetch(url);

            if (response.ok) {
                verifyMetadata(info, value, Buffer.from(await response.arrayBuffer()));

                return;
            }
            assert.ok(response.status === 404 || response.status === 503, `Registry archive returned ${response.status}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    throw new Error('Published version was not publicly available within ten minutes.');
}

async function main() {
    const mode = process.argv[2];

    if (mode === 'plan') {
        const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
        const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const runs = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`], { encoding: 'utf8' })).workflow_runs;

        execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
        const plan = releasePlan(manifest, event, process.env.GITHUB_REPOSITORY, sha, runs);

        writeFileSync('release.json', `${JSON.stringify(plan, null, 2)}\n`);
        appendFileSync(process.env.GITHUB_OUTPUT, `channel=${plan.channel}\n`);
    } else if (mode === 'pack') {
        const plan = JSON.parse(readFileSync('release.json', 'utf8'));
        const packs = packArchive();
        const info = archiveInfo(plan, packs, readFileSync(packs[0].filename));

        writeFileSync('release.json', `${JSON.stringify(info, null, 2)}\n`);
    } else if (mode === 'publish') {
        const info = JSON.parse(readFileSync('release/release.json', 'utf8'));
        assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), info.sha, 'Release tag changed after archive verification.');
        const bytes = readFileSync(path.join('release', info.filename));

        assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, info.integrity);
        const existing = await metadata(info);

        if (existing) {
            assert.equal(existing.dist.integrity, info.integrity, 'Cannot replace an existing version.');
        } else {
            const response = await fetch(`${registry}/${encodeURIComponent(info.name)}/${info.channel}`, { headers: { 'cache-control': 'no-cache' } });

            assert.ok(response.ok || response.status === 404, `Registry channel returned ${response.status}.`);
            if (response.ok) {
                const current = await response.json();

                assert.ok(compareVersions(info.version, current.version) > 0, 'Release must not move its distribution tag backwards.');
            }
            execFileSync('npm', publishArguments(info), { stdio: 'inherit' });
        }
        await verifyPublished(info);
    } else {
        throw new Error('Expected plan, pack, or publish.');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main();
}
