import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { releasePlan, archiveInfo, verifyMetadata, compareVersions } from './npm-release.mjs';

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
