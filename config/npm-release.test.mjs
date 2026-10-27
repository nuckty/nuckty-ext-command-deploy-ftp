import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { releasePlan, archiveInfo, verifyMetadata, compareVersions, packArchive, publishArguments } from './npm-release.mjs';

const manifest = { name: '@nuckty/core', version: '1.0.0-beta2' };
const event = { action: 'published', release: { draft: false, tag_name: 'v1.0.0-beta2', prerelease: true } };
const run = { head_sha: 'a'.repeat(40), head_branch: 'main', event: 'push', conclusion: 'success' };
const plan = () => releasePlan(manifest, event, 'nuckty/nuckty', run.head_sha, [run]);

test('release requires exact version tag and successful main push CI', () => {
    assert.equal(plan().channel, 'beta');
    assert.throws(() => releasePlan(manifest, { ...event, release: { ...event.release, tag_name: 'v1.0.0-beta1' } }, 'nuckty/nuckty', run.head_sha, [run]));
    assert.throws(() => releasePlan(manifest, event, 'nuckty/nuckty', run.head_sha, [{ ...run, conclusion: 'failure' }]));
    assert.throws(() => releasePlan(manifest, event, 'nuckty/nuckty', run.head_sha, [{ ...run, event: 'pull_request' }]));
    assert.throws(() => releasePlan(manifest, event, 'nuckty/nuckty', run.head_sha, [{ ...run, head_sha: 'b'.repeat(40) }]));
    assert.throws(() => releasePlan(manifest, event, 'other/nuckty', run.head_sha, [run]));
});

test('stable releases use latest and must not be marked prerelease', () => {
    const stable = { ...manifest, version: '1.0.0' };
    const release = { ...event, release: { ...event.release, tag_name: 'v1.0.0', prerelease: false } };

    assert.equal(releasePlan(stable, release, 'nuckty/nuckty', run.head_sha, [run]).channel, 'latest');
    assert.throws(() => releasePlan(stable, { ...release, release: { ...release.release, prerelease: true } }, 'nuckty/nuckty', run.head_sha, [run]));
});

test('extension identity is bound to its GitHub repository', () => {
    assert.equal(releasePlan({ ...manifest, name: '@nuckty/ext-block-root' }, event, 'nuckty/nuckty-ext-block-root', run.head_sha, [run]).name, '@nuckty/ext-block-root');
    assert.throws(() => releasePlan(manifest, event, 'nuckty/nuckty-ext-block-root', run.head_sha, [run]));
});

test('public registry metadata and bytes must match the packed archive', () => {
    const bytes = Buffer.from('tested archive');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const info = archiveInfo(plan(), [{ ...manifest, filename: 'core.tgz', integrity }], bytes);
    const metadata = { ...manifest, dist: { integrity, tarball: 'https://registry.npmjs.org/@nuckty/core/-/core.tgz' } };

    verifyMetadata(info, metadata, bytes);
    assert.throws(() => verifyMetadata(info, { ...metadata, version: '1.0.0-beta1' }, bytes));
    assert.throws(() => verifyMetadata(info, metadata, Buffer.from('different archive')));
    assert.throws(() => verifyMetadata(info, { ...metadata, dist: { ...metadata.dist, tarball: 'https://example.com/core.tgz' } }, bytes));
    assert.throws(() => archiveInfo(plan(), [{ ...manifest, filename: '../core.tgz', integrity }], bytes));
});

test('distribution tags cannot regress across prerelease and stable versions', () => {
    for (const [older, newer] of [['1.0.0-beta1', '1.0.0-beta2'], ['1.0.0-beta.2', '1.0.0-beta.10'], ['1.0.0-beta1', '1.0.0'], ['1.0.0', '1.0.1'], ['1.9.0', '1.10.0']]) {
        assert.equal(compareVersions(older, newer), -1);
        assert.equal(compareVersions(newer, older), 1);
    }
    assert.equal(compareVersions('1.0.0-beta1', '1.0.0-beta1'), 0);
});

test('invalid numeric prerelease and nonexact versions are rejected', () => {
    for (const version of ['1.0.0-beta.01', '1.0.0+build', '^1.0.0', '01.0.0']) {
        assert.throws(() => releasePlan({ ...manifest, version }, { ...event, release: { ...event.release, tag_name: `v${version}` } }, 'nuckty/nuckty', run.head_sha, [run]));
    }
    assert.equal(compareVersions('1.0.0-alpha-2', '1.0.0-alpha-3'), -1);
    assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('real npm pack isolates metadata from a noisy prepack lifecycle', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nuckty-release-pack-'));

    try {
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@nuckty/core', version: '1.0.0-beta2', files: ['index.js'], scripts: { prepack: 'node prepack.mjs' } }));
        writeFileSync(path.join(directory, 'index.js'), 'export const ready = true;\n');
        writeFileSync(path.join(directory, 'prepack.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('prepack-ran', 'bad'); console.log('\\u001b[34mCLI build noise');\n");
        const packs = packArchive(directory);
        const info = archiveInfo({ name: '@nuckty/core', version: '1.0.0-beta2' }, packs, readFileSync(path.join(directory, packs[0].filename)));

        assert.equal(info.name, '@nuckty/core');
        assert.equal(info.version, '1.0.0-beta2');
        assert.equal(existsSync(path.join(directory, 'prepack-ran')), false);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('npm publish resolves the release archive locally in a real dry run', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nuckty-release-publish-'));

    try {
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@nuckty/core', version: '1.0.0-beta2', files: ['index.js'] }));
        writeFileSync(path.join(directory, 'index.js'), 'export const ready = true;\n');
        const packs = packArchive(directory);
        const info = { filename: packs[0].filename, channel: 'beta' };

        assert.ok(path.isAbsolute(publishArguments(info)[1]));
        mkdirSync(path.join(directory, 'release'));
        renameSync(path.join(directory, info.filename), path.join(directory, 'release', info.filename));
        const output = execFileSync('npm', [...publishArguments(info, directory), '--dry-run', '--json'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const result = JSON.parse(output);

        assert.equal(result.name, '@nuckty/core');
        assert.equal(result.version, '1.0.0-beta2');
        assert.throws(() => publishArguments({ ...info, filename: '../core.tgz' }));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
