/**
 * Tests for the deploy-ftp command-extension's pure helpers (openspec
 * `ext-command-deploy-ftp`): `compareWithServer` (manifest diff: new/changed/
 * deleted against actual server LIST sizes, hash only when sizes match) and
 * `shouldSafetyAbort` (mass-delete > 30% guard). Plus `loadAuthConfig` (env vars
 * preferred over `config/auth-ftp.json`). These are non-trivial: a deploy that
 * over-uploads wastes bandwidth; one that over-deletes wipes a site. The diff
 * uses ACTUAL server file sizes (not the remote manifest) so orphans left by an
 * interrupted deploy are still cleaned; the manifest file itself is skipped.
 *
 * @module test/ftp
 */

import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    compareWithServer,
    shouldSafetyAbort,
    SAFETY_DELETE_THRESHOLD,
    loadAuthConfig,
    loadLocalManifest,
    getAllFiles,
    ftpDeploy,
    type Manifest,
    type FtpTransport,
} from '../ftp.js';

// ---- compareWithServer (manifest diff) -------------------------------------

function manifest(entries: Record<string, [number, string]>): Manifest {
    const out: Manifest = {};
    for (const [p, [size, hash]] of Object.entries(entries)) out[p] = { size, hash };
    return out;
}

function testAuth() {
    return {
        host: 'ftp.example.test', port: 21, user: 'user', password: 'password',
        remotePath: '/', secure: false, passive: true, progress: false,
    };
}

function unusedTransport(): FtpTransport {
    const unexpected = async (): Promise<never> => { throw new Error('transport must not be used'); };

    return {
        access: unexpected,
        cd: unexpected,
        pwd: unexpected,
        close: () => undefined,
        list: unexpected,
        ensureDir: unexpected,
        downloadTo: unexpected,
        uploadFrom: unexpected,
        send: unexpected,
        remove: unexpected,
    };
}

test('compareWithServer: a file absent from the server is "new"', () => {
    const local = manifest({ 'a.txt': [10, 'ha'], 'new.txt': [20, 'hn'] });
    const serverSizes: Record<string, number> = { 'a.txt': 10 };
    const result = compareWithServer(local, manifest({ 'a.txt': [10, 'ha'] }), serverSizes);
    assert.equal(result.totalToUpload, 1);
    assert.equal(result.toUpload[0]!.path, 'new.txt');
    assert.equal(result.toUpload[0]!.reason, 'new');
});

test('compareWithServer: a file whose actual size differs is "changed"', () => {
    // Size differs (local 20 vs server 25) → changed WITHOUT hashing.
    const local = manifest({ 'a.txt': [20, 'ha'] });
    const serverSizes: Record<string, number> = { 'a.txt': 25 };
    const result = compareWithServer(local, manifest({ 'a.txt': [20, 'ha'] }), serverSizes);
    assert.equal(result.totalToUpload, 1);
    assert.equal(result.toUpload[0]!.reason, 'changed');
});

test('compareWithServer: same size but different hash is "changed"', () => {
    // Sizes match (20) → only then compare hashes; differing hash → changed.
    const local = manifest({ 'a.txt': [20, 'new'] });
    const serverSizes: Record<string, number> = { 'a.txt': 20 };
    const result = compareWithServer(local, manifest({ 'a.txt': [20, 'old'] }), serverSizes);
    assert.equal(result.totalToUpload, 1);
    assert.equal(result.toUpload[0]!.reason, 'changed');
});

test('compareWithServer: same size and hash is "unchanged" (skipped)', () => {
    const local = manifest({ 'a.txt': [20, 'same'] });
    const serverSizes: Record<string, number> = { 'a.txt': 20 };
    const result = compareWithServer(local, manifest({ 'a.txt': [20, 'same'] }), serverSizes);
    assert.equal(result.totalToUpload, 0);
    assert.equal(result.totalUnchanged, 1);
    assert.deepEqual(result.unchanged, ['a.txt']);
});

test('compareWithServer: a server file missing from the local manifest is "deleted" (orphan)', () => {
    // Orphans are detected against the ACTUAL server listing, so a file left
    // over from an interrupted deploy (whose manifest upload never ran) is
    // still cleaned up.
    const local = manifest({ 'a.txt': [10, 'ha'] });
    const serverSizes: Record<string, number> = { 'a.txt': 10, 'orphan.txt': 5 };
    const result = compareWithServer(local, {}, serverSizes);
    assert.equal(result.totalToDelete, 1);
    assert.deepEqual(result.toDelete, ['orphan.txt']);
});

test('compareWithServer: the manifest file itself is never deleted', () => {
    // `manifest.json` lives on the server but is excluded from the local
    // manifest (uploaded separately as the last step); it must not be treated
    // as an orphan.
    const local = manifest({ 'a.txt': [10, 'ha'] });
    const serverSizes: Record<string, number> = { 'a.txt': 10, 'manifest.json': 100 };
    const result = compareWithServer(local, {}, serverSizes);
    assert.equal(result.totalToDelete, 0);
    assert.ok(!result.toDelete.includes('manifest.json'));
});

test('compareWithServer: toUpload and toDelete are sorted by path', () => {
    const local = manifest({ 'z.txt': [1, 'h'], 'a.txt': [2, 'h'], 'm.txt': [3, 'h'] });
    const serverSizes: Record<string, number> = { 'old1.txt': 1, 'old2.txt': 2 };
    const result = compareWithServer(local, {}, serverSizes);
    assert.deepEqual(result.toUpload.map((u) => u.path), ['a.txt', 'm.txt', 'z.txt']);
    assert.deepEqual(result.toDelete, ['old1.txt', 'old2.txt']);
});

// ---- shouldSafetyAbort (mass-delete guard) ----------------------------------

test('shouldSafetyAbort: deleting above the threshold aborts', () => {
    // 31 deletions out of 100 server files (> 0.3) → abort.
    assert.equal(shouldSafetyAbort(31, 100), true);
});

test('shouldSafetyAbort: deleting at exactly the threshold does NOT abort', () => {
    // 30/100 is `> 0.3`? 30 > 30 is false → does not abort (strict greater-than).
    assert.equal(shouldSafetyAbort(30, 100), false);
});

test('shouldSafetyAbort: a small absolute delete can still abort if it is a large share', () => {
    // 4 deletions out of 10 (40% > 30%) → abort: the guard is a SHARE, not a count.
    assert.equal(shouldSafetyAbort(4, 10), true);
});

test('shouldSafetyAbort: a zero server file count never aborts', () => {
    // No files on the server → nothing to protect; a first deploy is never blocked.
    assert.equal(shouldSafetyAbort(100, 0), false);
});

test('shouldSafetyAbort: a custom threshold is honored', () => {
    assert.equal(shouldSafetyAbort(51, 100, 0.5), true);
    assert.equal(shouldSafetyAbort(50, 100, 0.5), false);
});

test('SAFETY_DELETE_THRESHOLD is 0.3 (30%)', () => {
    assert.equal(SAFETY_DELETE_THRESHOLD, 0.3);
});

// ---- loadAuthConfig (env preferred over file) -------------------------------

function clearFtpEnv(): void {
    for (const k of ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD', 'FTP_PASS', 'FTP_PATH', 'FTP_PORT']) {
        delete process.env[k];
    }
}

test('loadAuthConfig: env vars win over auth-ftp.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        await mkdir(path.join(dir, 'config'), { recursive: true });
        await writeFile(
            path.join(dir, 'config', 'auth-ftp.json'),
            JSON.stringify({ host: 'file-host', user: 'fu', password: 'fp', remote_path: '/f' }),
        );
        clearFtpEnv();
        process.env.FTP_HOST = 'env-host';
        process.env.FTP_USER = 'eu';
        process.env.FTP_PASSWORD = 'ep';
        process.env.FTP_PATH = '/e';
        const cfg = loadAuthConfig(dir);
        assert.equal(cfg.host, 'env-host');
        assert.equal(cfg.user, 'eu');
        assert.equal(cfg.password, 'ep');
        assert.equal(cfg.remotePath, '/e');
        assert.equal(cfg.port, 21);
        assert.equal(cfg.secure, false);
    } finally {
        clearFtpEnv();
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadAuthConfig: FTP_PASSWORD preferred over legacy FTP_PASS', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        clearFtpEnv();
        process.env.FTP_HOST = 'h';
        process.env.FTP_USER = 'u';
        process.env.FTP_PASSWORD = 'new-pass';
        process.env.FTP_PASS = 'old-pass';
        process.env.FTP_PATH = '/p';
        const cfg = loadAuthConfig(dir);
        assert.equal(cfg.password, 'new-pass');
    } finally {
        clearFtpEnv();
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadAuthConfig: FTP_PORT overrides the default 21', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        clearFtpEnv();
        process.env.FTP_HOST = 'h';
        process.env.FTP_USER = 'u';
        process.env.FTP_PASSWORD = 'p';
        process.env.FTP_PATH = '/p';
        process.env.FTP_PORT = '990';
        const cfg = loadAuthConfig(dir);
        assert.equal(cfg.port, 990);
    } finally {
        clearFtpEnv();
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadAuthConfig: falls back to auth-ftp.json with defaults for port/secure/progress', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        await mkdir(path.join(dir, 'config'), { recursive: true });
        await writeFile(
            path.join(dir, 'config', 'auth-ftp.json'),
            JSON.stringify({ host: 'h', user: 'u', password: 'p', remote_path: '/r' }),
        );
        clearFtpEnv();
        const cfg = loadAuthConfig(dir);
        assert.equal(cfg.host, 'h');
        assert.equal(cfg.remotePath, '/r');
        assert.equal(cfg.port, 21);
        assert.equal(cfg.secure, false);
        assert.equal(cfg.progress, true);
    } finally {
        clearFtpEnv();
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadAuthConfig: missing both env and file throws a clear error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        clearFtpEnv();
        assert.throws(
            () => loadAuthConfig(dir),
            /no auth-ftp\.json .* FTP_HOST\/FTP_USER\/FTP_PASSWORD\/FTP_PATH env not set/,
        );
    } finally {
        clearFtpEnv();
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadAuthConfig: malformed JSON does not echo password fragments from parser context', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    const sentinel = 'P@ss';
    try {
        await mkdir(path.join(dir, 'config'), { recursive: true });
        await writeFile(
            path.join(dir, 'config', 'auth-ftp.json'),
            `{"host":"h","user":"u","password":${sentinel},"remote_path":"/"}`,
        );

        let thrown: unknown;
        try {
            loadAuthConfig(dir);
        } catch (err) {
            thrown = err;
        }
        assert.ok(thrown instanceof Error);
        assert.match(thrown.message, /auth-ftp\.json is not valid JSON/);
        assert.ok(!thrown.message.includes(sentinel), 'config error must not expose parser context');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadAuthConfig: auth-ftp.json missing a required field throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        await mkdir(path.join(dir, 'config'), { recursive: true });
        await writeFile(
            path.join(dir, 'config', 'auth-ftp.json'),
            JSON.stringify({ host: 'h', user: 'u' }), // missing password + remote_path
        );
        clearFtpEnv();
        assert.throws(() => loadAuthConfig(dir), /Missing required field 'password'/);
    } finally {
        clearFtpEnv();
        await rm(dir, { recursive: true, force: true });
    }
});

// ---- loadLocalManifest + getAllFiles (filesystem helpers) -------------------

test('loadLocalManifest: returns {} when manifest.json is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        assert.deepEqual(await loadLocalManifest(dir), {});
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadLocalManifest: reads and parses manifest.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        await writeFile(
            path.join(dir, 'manifest.json'),
            JSON.stringify({ 'a.txt': { size: 10, hash: 'ha' } }),
        );
        const m = await loadLocalManifest(dir);
        assert.equal(m['a.txt']!.size, 10);
        assert.equal(m['a.txt']!.hash, 'ha');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('ftpDeploy: a manifest symlink outside the artifact fails before creating a client', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'nuckty-ftp-manifest-link-'));
    const dir = path.join(parent, 'out');
    let clientsCreated = 0;
    try {
        await mkdir(dir);
        await writeFile(path.join(parent, 'sentinel.json'), JSON.stringify({
            'secret.txt': { size: 6, hash: 'outside' },
        }));
        await writeFile(path.join(dir, 'secret.txt'), 'inside');
        await symlink(path.join(parent, 'sentinel.json'), path.join(dir, 'manifest.json'));

        await assert.rejects(
            () => ftpDeploy({ outDir: dir, auth: testAuth(), progress: false }, {
                createClient: () => {
                    clientsCreated++;
                    return unusedTransport();
                },
            }),
            /Invalid local artifact file: manifest\.json/,
        );
        assert.equal(clientsCreated, 0, 'invalid manifest must fail before network setup');
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test('ftpDeploy: valid regular manifest is uploaded after its content files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-ftp-manifest-regular-'));
    try {
        const content = Buffer.from('site');
        const rawManifest = JSON.stringify({ 'index.html': { size: content.length, hash: createHash('md5').update(content).digest('hex').slice(0, 16) } });
        await writeFile(path.join(dir, 'index.html'), content);
        await writeFile(path.join(dir, 'manifest.json'), rawManifest);

        const remote = new Map<string, number>();
        const uploaded: string[] = [];
        const transport: FtpTransport = {
            access: async () => undefined,
            cd: async () => undefined,
            pwd: async () => '/remote',
            close: () => undefined,
            list: async () => [...remote].map(([name, size]) => ({ name, size, isDirectory: false })),
            ensureDir: async () => undefined,
            downloadTo: async () => { throw new Error('remote manifest should not exist'); },
            uploadFrom: async (local, remotePath) => {
                const bytes = await readFile(local);
                remote.set(remotePath, bytes.length);
                uploaded.push(remotePath);
            },
            send: async () => undefined,
            remove: async () => undefined,
        };

        const result = await ftpDeploy({ outDir: dir, auth: testAuth(), progress: false }, {
            createClient: () => transport,
        });

        assert.deepEqual(uploaded, ['index.html', 'manifest.json']);
        assert.equal(result.stats.uploaded, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('getAllFiles: walks nested dirs and returns remote paths with forward slashes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-deploy-'));
    try {
        await mkdir(path.join(dir, 'css'), { recursive: true });
        await mkdir(path.join(dir, 'html', 'sub'), { recursive: true });
        await writeFile(path.join(dir, 'root.txt'), 'x');
        await writeFile(path.join(dir, 'css', 'a.css'), 'x');
        await writeFile(path.join(dir, 'html', 'sub', 'b.html'), 'x');
        const files = getAllFiles(dir);
        const remotes = files.map((f) => f.remote).sort();
        assert.deepEqual(remotes, ['css/a.css', 'html/sub/b.html', 'root.txt']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ---- CMD-02/03/06 regression pins --------------------------------------------

test('CMD-02 pin: --force keeps the delete plan (force bypasses the guard, not deletions)', async () => {
    // Independent expected outcome derived from the contract: local has only
    // a.txt; remote has a.txt + obsolete.txt + manifest.json. Under --force the
    // upload plan is ALL local files, and the delete plan still contains
    // obsolete.txt (previously force wiped toDelete to []).
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-ftp-force-'));
    try {
        // Post-build state: the local manifest lists only a.txt.
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
            'a.txt': { size: 3, hash: 'ha' },
        }));
        const local = await loadLocalManifest(dir);
        assert.equal(local['a.txt']!.size, 3);
        // The pure diff --force now uses: the server LIST drives BOTH the
        // upload plan (same size+no manifest → changed/new from empty remote
        // manifest would skip; force uploads everything) and the delete plan.
        // Here we pin the DELETE half: orphans from the actual LIST remain.
        const serverSizes: Record<string, number> = { 'a.txt': 3, 'obsolete.txt': 5 };
        const comparison = compareWithServer(local, {}, serverSizes);
        assert.ok(
            comparison.toDelete.includes('obsolete.txt'),
            'force diff must still plan orphan deletion',
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('CMD-06 pin: malformed local manifest is rejected before any network', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-ftp-badman-'));
    try {
        await writeFile(path.join(dir, 'manifest.json'), 'NOT JSON{{');
        await assert.rejects(() => loadLocalManifest(dir), /malformed/);
        // and a non-object (null/array) is equally rejected, not cast to Cache
        await writeFile(path.join(dir, 'manifest.json'), 'null');
        await assert.rejects(() => loadLocalManifest(dir), /not a JSON object/);
        await writeFile(path.join(dir, 'manifest.json'), '[]');
        await assert.rejects(() => loadLocalManifest(dir), /not a JSON object/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('CMD-06 pin: a valid local manifest still loads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-ftp-man-'));
    try {
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ 'a.txt': { size: 1, hash: 'h' } }));
        const m = await loadLocalManifest(dir);
        assert.equal(m['a.txt']!.hash, 'h');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ---- CMD-04: deploy target resolution ---------------------------------------

import { resolveOutDir } from '../index.js';

test('CMD-04 pin: no argument = first declared target; unknown explicit name fails', () => {
    const config = {
        targets: {
            a: { configDir: 'config-a/', outDir: 'dist/a/', lang: 'en', host: 'a.example' },
            b: { configDir: 'config-b/', outDir: 'dist/b/', lang: 'ru', host: 'b.example' },
        },
        ext: [],
    } as never;
    const cwd = '/proj';
    assert.equal(resolveOutDir(config, undefined, cwd), '/proj/dist/a');
    assert.equal(resolveOutDir(config, 'b', cwd), '/proj/dist/b');
    // A typo must fail — never silently fall back to another target.
    assert.throws(() => resolveOutDir(config, 'bt', cwd), /unknown target "bt".*a, b/);
});

test('CMD-04 pin: an empty config fails clearly (no implicit site/ fallback)', () => {
    assert.throws(() => resolveOutDir({ targets: {}, ext: [] } as never, undefined, '/p'), /no targets/);
});
for (const name of ['constructor', 'toString', '__proto__']) {
    test(`FTP diff handles ${name} as an own filename rather than a prototype entry`, () => {
        const local = Object.fromEntries([[name, { size: 1, hash: 'A' }]]);
        const sizes = Object.fromEntries([[name, 1]]);

        assert.deepEqual(compareWithServer({}, {}, sizes).toDelete, [name]);
        assert.deepEqual(compareWithServer(local, {}, {}).toUpload, [{ path: name, reason: 'new' }]);
        assert.deepEqual(compareWithServer(local, local, sizes).unchanged, [name]);
        const inherited = Object.create(local) as Manifest;

        assert.deepEqual(compareWithServer(inherited, {}, sizes).toDelete, [name]);
        assert.deepEqual(compareWithServer(local, inherited, sizes).toUpload, [{ path: name, reason: 'changed' }]);
    });
}

