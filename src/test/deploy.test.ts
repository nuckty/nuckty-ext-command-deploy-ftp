import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Writable } from 'node:stream';
import type { AccessOptions } from 'basic-ftp';
import type { CommandArgs } from 'nuckty';
import { deployFtp } from '../index.js';
import { ftpDeploy, loadAuthConfig, type FtpTransport, type Manifest } from '../ftp.js';

const auth = { host: 'fixture.invalid', user: 'fixture', password: 'fixture', port: 21,
    remotePath: '/site', secure: true, passive: true, progress: false };

class Server {
    files = new Map<string, Buffer>();
    dirs = new Set(['/site']);
    calls: string[] = [];
    clients: Client[] = [];
    failList = '';
    failDownload = '';
    failUpload = '';
    failRemove = false;
    ignoreRemove = false;
    failAccess = false;
    reconnect = false;
    createClient = (): Client => {
        const client = new Client(this);

        this.clients.push(client);
        return client;
    };
    manifest(entries: Manifest): void {
        this.files.set('/site/manifest.json', Buffer.from(JSON.stringify(entries)));
    }
}

class Client implements FtpTransport {
    cwd = '/';
    closed = false;
    options?: AccessOptions;
    constructor(readonly server: Server) {}
    async access(options: AccessOptions): Promise<void> {
        this.server.calls.push('access');
        this.options = options;
        if (this.server.failAccess) {
            throw new Error('TLS certificate invalid');
        }
    }
    async cd(dir: string): Promise<void> {
        this.cwd = path.posix.resolve(this.cwd, dir);
    }
    async pwd(): Promise<string> { return this.cwd; }
    close(): void { this.closed = true; }
    async list(dir: string): Promise<Array<{ name: string; size: number; isDirectory: boolean }>> {
        this.server.calls.push(`list:${dir}`);
        if (dir === this.server.failList) {
            throw new Error('550 permission denied');
        }
        const root = path.posix.resolve(this.cwd, dir);
        const files = [...this.server.files.entries()]
            .filter(([name]) => path.posix.dirname(name) === root)
            .map(([name, data]) => ({ name: path.posix.basename(name), size: data.length, isDirectory: false }));
        const dirs = [...this.server.dirs].filter((name) => name !== root && path.posix.dirname(name) === root)
            .map((name) => ({ name: path.posix.basename(name), size: 0, isDirectory: true }));

        return [...files, ...dirs];
    }
    async ensureDir(dir: string): Promise<void> {
        for (const segment of dir.split('/')) {
            this.cwd = path.posix.resolve(this.cwd, segment);
            this.server.dirs.add(this.cwd);
        }
        this.server.calls.push(`ensure:${this.cwd}`);
    }
    async downloadTo(sink: Writable, remote: string): Promise<void> {
        this.server.calls.push(`download:${remote}`);
        if (this.server.failDownload) {
            throw new Error(this.server.failDownload);
        }
        const data = this.server.files.get(path.posix.resolve(this.cwd, remote));

        if (!data) {
            throw new Error('550 not found');
        }
        sink.write(data);
    }
    async uploadFrom(local: string, remote: string): Promise<void> {
        this.server.calls.push(`upload:${remote}`);
        if (remote === this.server.failUpload) {
            throw new Error('550 upload denied');
        }
        if (this.server.reconnect && this === this.server.clients[0]) {
            throw new Error('ECONNRESET');
        }
        const destination = path.posix.resolve(this.cwd, remote);

        if (!this.server.dirs.has(path.posix.dirname(destination))) {
            throw new Error('550 parent absent');
        }
        this.server.files.set(destination, await readFile(local));
    }
    async send(): Promise<void> {
        if (this.server.reconnect && this === this.server.clients[0]) {
            throw new Error('connection closed');
        }
    }
    async remove(remote: string): Promise<void> {
        this.server.calls.push(`remove:${remote}`);
        if (this.server.failRemove) {
            throw new Error('550 remove denied');
        }
        if (!this.server.ignoreRemove) {
            this.server.files.delete(path.posix.resolve(this.cwd, remote));
        }
    }
}

async function fixture(run: (dir: string, server: Server) => Promise<void>, entries: Manifest = { 'a.txt': { size: 3, hash: 'new' } }): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), 'nuckty-ftp-command-'));
    const server = new Server();

    try {
        const manifest: Manifest = {};

        for (const [name, entry] of Object.entries(entries)) {
            const bytes = Buffer.alloc(entry.size, 78);

            await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
            await writeFile(path.join(dir, name), bytes);
            manifest[name] = { size: bytes.length, hash: createHash('md5').update(bytes).digest('hex').slice(0, 16) };
        }
        await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        await run(dir, server);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function deploy(dir: string, server: Server, opts: { force?: boolean; dryRun?: boolean } = {}) {
    return ftpDeploy({ outDir: dir, auth, ...opts }, { createClient: server.createClient, retryDelayMs: 0 });
}

function mutations(server: Server): string[] {
    return server.calls.filter((call) => /^(upload|remove|ensure):/.test(call));
}

test('force uploads same-size changed bytes before manifest and preserves deletion plan', async () => {
    await fixture(async (dir, server) => {
        server.files.set('/site/a.txt', Buffer.from('OLD'));
        server.files.set('/site/orphan', Buffer.from('x'));
        server.manifest({ 'a.txt': { size: 3, hash: 'old' } });
        const result = await deploy(dir, server, { force: true });

        assert.deepEqual(mutations(server), ['upload:a.txt', 'remove:orphan', 'upload:manifest.json']);
        assert.equal(server.files.get('/site/a.txt')?.toString(), 'NNN');
        assert.equal(result.comparison.toUpload[0]?.reason, 'force');
        assert.ok(server.clients.every((client) => client.closed));
    });
});

test('a stale same-size artifact is rejected before connecting', async () => {
    await fixture(async (dir, server) => {
        await writeFile(path.join(dir, 'a.txt'), 'OLD');
        await assert.rejects(deploy(dir, server, { dryRun: true }), /manifest hash mismatch/);
        assert.equal(server.clients.length, 0);
    });
});

test('a file or manifest changed during transfer cannot commit a manifest', async () => {
    for (const changed of ['a.txt', 'manifest.json']) {
        await fixture(async (dir, server) => {
            const create = server.createClient;
            const createClient = (): FtpTransport => {
                const client = create();
                const upload = client.uploadFrom.bind(client);

                client.uploadFrom = async (local, remote) => {
                    await upload(local, remote);
                    await writeFile(path.join(dir, changed), changed === 'a.txt' ? 'OLD' : '{}');
                };

                return client;
            };

            await assert.rejects(ftpDeploy({ outDir: dir, auth }, { createClient }), /hash mismatch|manifest changed/);
            assert.ok(!server.calls.includes('upload:manifest.json'));
        });
    }
});

test('missing manifest obeys the same mass-deletion guard without force', async () => {
    await fixture(async (dir, server) => {
        server.files.set('/site/orphan', Buffer.from('x'));
        await assert.rejects(deploy(dir, server), /Safety abort/);
        assert.deepEqual(mutations(server), []);
        assert.ok(!server.calls.includes('download:manifest.json'));
    });
});

test('failed root or nested LIST aborts before mutations', async () => {
    for (const location of ['.', 'hidden']) {
        await fixture(async (dir, server) => {
            server.dirs.add('/site/hidden');
            server.failList = location;
            await assert.rejects(deploy(dir, server, { force: true }), /incomplete server snapshot/);
            assert.deepEqual(mutations(server), []);
        });
    }
});

test('listed manifest denial, missing-after-LIST, malformed JSON and invalid schema abort', async () => {
    for (const failure of ['550 permission denied', '550 not found', 'ECONNRESET', 'json', 'schema']) {
        await fixture(async (dir, server) => {
            server.manifest({ 'a.txt': { size: 3, hash: 'old' } });
            if (failure === 'json' || failure === 'schema') {
                server.files.set('/site/manifest.json', Buffer.from(failure === 'json' ? '{' : '{"a.txt":null}'));
            } else {
                server.failDownload = failure;
            }
            await assert.rejects(deploy(dir, server), /Cannot download/);
            assert.deepEqual(mutations(server), []);
        });
    }
});

test('local schema, paths, missing files and size mismatches fail before creating a client', async () => {
    const bad = [null, [], { 'a.txt': null }, { 'a.txt': { size: -1, hash: 'h' } },
        { 'a.txt': { size: 3, hash: '' } }, { '../a.txt': { size: 3, hash: 'h' } },
        { '/a.txt': { size: 3, hash: 'h' } }, { 'x\\a.txt': { size: 3, hash: 'h' } },
        { 'missing.txt': { size: 3, hash: 'h' } }, { 'a.txt': { size: 4, hash: 'h' } }];

    for (const manifest of bad) {
        await fixture(async (dir, server) => {
            await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
            await assert.rejects(deploy(dir, server));
            assert.equal(server.clients.length, 0);
        });
    }
});

test('local symlink outside artifact fails preflight', async () => {
    await fixture(async (dir, server) => {
        const outside = await mkdtemp(path.join(tmpdir(), 'nuckty-ftp-outside-'));

        try {
            await writeFile(path.join(outside, 'outside.txt'), 'OLD');
            await rm(path.join(dir, 'a.txt'));
            await symlink(path.join(outside, 'outside.txt'), path.join(dir, 'a.txt'));
            await assert.rejects(deploy(dir, server), /outside artifact/);
            assert.equal(server.clients.length, 0);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test('depth-two and sibling directories upload relative to saved root, including relative auth path', async () => {
    await fixture(async (dir, server) => {
        await ftpDeploy({ outDir: dir, auth: { ...auth, remotePath: 'site' } }, { createClient: server.createClient });
        assert.ok(server.files.has('/site/html/sub/a.txt'));
        assert.ok(server.files.has('/site/html/other/b.txt'));
        assert.ok(!server.dirs.has('/site/html/html'));
        assert.equal(mutations(server).at(-1), 'upload:manifest.json');
    }, { 'html/sub/a.txt': { size: 3, hash: 'h' }, 'html/other/b.txt': { size: 3, hash: 'h' } });
});

test('same-size upload failure leaves old manifest; a subsequent run retries the content', async () => {
    await fixture(async (dir, server) => {
        server.files.set('/site/a.txt', Buffer.from('OLD'));
        server.manifest({ 'a.txt': { size: 3, hash: 'old' } });
        const old = server.files.get('/site/manifest.json');

        server.failUpload = 'a.txt';
        await assert.rejects(deploy(dir, server), /Manifest not uploaded/);
        assert.equal(server.files.get('/site/manifest.json'), old);
        server.failUpload = '';
        server.calls = [];
        await deploy(dir, server);
        assert.deepEqual(mutations(server), ['upload:a.txt', 'upload:manifest.json']);
    });
});

test('delete errors and false delete acknowledgments do not publish manifest', async () => {
    for (const ignored of [false, true]) {
        await fixture(async (dir, server) => {
            server.files.set('/site/orphan', Buffer.from('x'));
            server.failRemove = !ignored;
            server.ignoreRemove = ignored;
            await assert.rejects(deploy(dir, server, { force: true }), /manifest not uploaded|Manifest not uploaded/);
            assert.ok(!server.calls.includes('upload:manifest.json'));
        });
    }
});

test('manifest transfer failure rejects instead of returning a successful result', async () => {
    await fixture(async (dir, server) => {
        server.failUpload = 'manifest.json';
        await assert.rejects(deploy(dir, server), /Manifest upload failed/);
    });
});

test('dry-run performs reads only and preserves an existing _server-manifest.json', async () => {
    await fixture(async (dir, server) => {
        await writeFile(path.join(dir, '_server-manifest.json'), 'sentinel');
        server.manifest({ 'a.txt': { size: 3, hash: 'old' } });
        const before = await readdir(dir);

        await deploy(dir, server, { dryRun: true });
        assert.deepEqual(mutations(server), []);
        assert.deepEqual(await readdir(dir), before);
        assert.equal(await readFile(path.join(dir, '_server-manifest.json'), 'utf8'), 'sentinel');
    });
});

test('reconnection closes replaced and failed clients without weakening TLS', async () => {
    await fixture(async (dir, server) => {
        server.reconnect = true;
        await deploy(dir, server);
        assert.equal(server.clients.length, 2);
        assert.ok(server.clients.every((client) => client.closed));
        assert.ok(server.clients.every((client) => client.options?.secure === true && client.options.secureOptions === undefined));
    });
    await fixture(async (dir, server) => {
        server.failAccess = true;
        await assert.rejects(deploy(dir, server), /TLS certificate invalid/);
        assert.equal(server.clients.length, 2);
        assert.ok(server.clients.every((client) => client.closed && client.options?.secure === true));
    });
});

test('FTP_SECURE enables verified TLS, accepts explicit plain FTP, rejects ambiguous values', () => {
    const names = ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD', 'FTP_PATH', 'FTP_SECURE'];
    const old = new Map(names.map((name) => [name, process.env[name]]));

    try {
        Object.assign(process.env, { FTP_HOST: 'fixture', FTP_USER: 'fixture', FTP_PASSWORD: 'fixture', FTP_PATH: '/site', FTP_SECURE: 'true' });
        assert.equal(loadAuthConfig('/unused').secure, true);
        process.env.FTP_SECURE = 'false';
        assert.equal(loadAuthConfig('/unused').secure, false);
        process.env.FTP_SECURE = 'maybe';
        assert.throws(() => loadAuthConfig('/unused'), /secure must be true or false/);
    } finally {
        for (const [name, value] of old) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    }
});

test('a verification LIST failure blocks manifest publication after successful content upload', async () => {
    await fixture(async (dir, server) => {
        const create = server.createClient;
        const createClient = (): FtpTransport => {
            const client = create();
            const upload = client.uploadFrom.bind(client);

            client.uploadFrom = async (local, remote) => {
                await upload(local, remote);
                server.failList = '.';
            };
            return client;
        };

        await assert.rejects(ftpDeploy({ outDir: dir, auth }, { createClient }), /incomplete server snapshot/);
        assert.deepEqual(mutations(server), ['upload:a.txt']);
    });
});

test('same-size remote content without a hash entry is uploaded rather than assumed unchanged', async () => {
    await fixture(async (dir, server) => {
        server.files.set('/site/a.txt', Buffer.from('OLD'));
        server.manifest({});
        await deploy(dir, server);
        assert.deepEqual(mutations(server), ['upload:a.txt', 'upload:manifest.json']);
    });
});

test('CLI parser and deploy handler preserve target order and reject unsafe boolean values', async (t) => {
    t.mock.method(process.stdout, 'write', () => true);
    t.mock.method(process.stderr, 'write', () => true);
    const parserPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../nuckty/src/bin/parse-args.ts');
    const { parseArgs } = await import(pathToFileURL(parserPath).href) as {
        parseArgs: (argv: string[], options: { booleanFlags: string[] }) => {
            positional: string[];
            flags: Record<string, string | boolean>;
        };
    };
    const calls: Array<{ outDir: string; dryRun?: boolean; force?: boolean }> = [];
    const config = {
        targets: {
            production: { configDir: 'config/', outDir: 'public/' },
            staging: { configDir: 'config/', outDir: 'preview/' },
        },
    } as CommandArgs['config'];
    const fakeFtpDeploy = async (options: { outDir: string; dryRun?: boolean; force?: boolean }) => {
        calls.push(options);
        return {
            stats: { uploaded: 0, deleted: 0, errors: 0, zipUploaded: 0, totalSize: 0, startTime: null, endTime: null },
            comparison: { toUpload: [], toDelete: [], unchanged: [], totalToUpload: 0, totalToDelete: 0, totalUnchanged: 0 },
        };
    };
    const invoke = async (tokens: string[]) => {
        const parsed = parseArgs(['deploy-ftp', ...tokens], { booleanFlags: ['dry-run', 'force'] });

        return deployFtp({
            positional: parsed.positional.slice(1),
            flags: parsed.flags,
            config,
            cwd: '/consumer',
        }, { ftpDeploy: fakeFtpDeploy });
    };

    assert.equal(await invoke(['staging', '--dry-run']), 0);
    assert.equal(await invoke(['--dry-run', 'staging']), 0);
    assert.equal(await invoke(['--dry-run=true', 'staging', '--force=false']), 0);
    assert.equal(await invoke(['staging', '--dry-run=false', '--force=true']), 0);
    assert.deepEqual(calls, [
        { outDir: path.resolve('/consumer', 'preview/'), cwd: '/consumer', force: false, dryRun: true, progress: true },
        { outDir: path.resolve('/consumer', 'preview/'), cwd: '/consumer', force: false, dryRun: true, progress: true },
        { outDir: path.resolve('/consumer', 'preview/'), cwd: '/consumer', force: false, dryRun: true, progress: true },
        { outDir: path.resolve('/consumer', 'preview/'), cwd: '/consumer', force: true, dryRun: false, progress: true },
    ]);

    calls.length = 0;
    assert.equal(await invoke(['staging', '--dry-run=maybe']), 1);
    assert.equal(await invoke(['staging', '--force=maybe']), 1);
    assert.equal(await invoke(['--dryrun', 'staging']), 1);
    assert.equal(await invoke(['missing-target', '--forcee']), 1);
    assert.equal(await invoke(['--dry-run', '--', 'staging', 'extra']), 1);
    assert.equal(await invoke(['staging', 'extra']), 1);
    assert.deepEqual(calls, [], 'invalid flags, targets, and extra positionals must fail before invoking FTP');
});
test('malformed target output never invokes FTP or falls back to site', async (t) => {
    t.mock.method(process.stderr, 'write', () => true);
    t.mock.method(process.stdout, 'write', () => true);

    for (const outDir of [undefined, null, 42, '', '   ']) {
        let calls = 0;
        const config = { targets: { main: { configDir: 'config', outDir } } } as unknown as CommandArgs['config'];
        const code = await deployFtp({ cwd: '/synthetic', config, positional: ['main'], flags: {} }, {
            ftpDeploy: async () => {
                calls++;

                throw new Error('FTP must not be invoked');
            },
        });

        assert.equal(code, 1);
        assert.equal(calls, 0);
    }
});

