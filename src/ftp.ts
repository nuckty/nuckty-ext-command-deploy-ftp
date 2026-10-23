import { promises as fs, constants, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as ftp from 'basic-ftp';

const MANIFEST_FILE = 'manifest.json';

/** Transport operations used by the deploy, injectable without opening sockets. */
export interface FtpTransport {
    access(options: ftp.AccessOptions): Promise<unknown>;
    cd(dir: string): Promise<unknown>;
    pwd(): Promise<string>;
    close(): void;
    list(dir: string): Promise<Array<{ name: string; size: number; isDirectory: boolean }>>;
    ensureDir(dir: string): Promise<unknown>;
    downloadTo(destination: Writable, remote: string): Promise<unknown>;
    uploadFrom(local: string, remote: string): Promise<unknown>;
    send(command: string): Promise<unknown>;
    remove(remote: string): Promise<unknown>;
}

export interface DeployDependencies {
    createClient?: () => FtpTransport;
    retryDelayMs?: number;
}

/** One manifest entry — size + MD5 hash (16 hex chars). */
export interface ManifestEntry {
    size: number;
    hash: string;
}

/** Manifest = relative path → { size, hash }. */
export type Manifest = Record<string, ManifestEntry>;

/** One item to upload: the relative path and why it is being uploaded. */
export interface UploadItem {
    path: string;
    reason: 'new' | 'changed' | 'force';
}

/** Result of comparing a local manifest against the remote state. */
export interface Comparison {
    toUpload: UploadItem[];
    toDelete: string[];
    unchanged: string[];
    totalToUpload: number;
    totalToDelete: number;
    totalUnchanged: number;
}

/** FTP auth config — fields of `config/auth-ftp.json` (or the env equivalent). */
export interface FtpAuthConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    /** Remote root directory to deploy into (FTP `CD` target). */
    remotePath: string;
    /** Require explicit FTPS with certificate verification when true. */
    secure: boolean;
    /** Passive mode (always true — mirrors reference). */
    passive: boolean;
    /** Print progress to stdout. */
    progress: boolean;
}

/** Options for `ftpDeploy`. */
export interface DeployOpts {
    /** Built site output directory (the local root to upload from). */
    outDir: string;
    /**
     * FTP auth config. If omitted, loaded from `config/auth-ftp.json` (relative
     * to `cwd`) or `FTP_HOST`/`FTP_USER`/`FTP_PASSWORD`/`FTP_PATH`[/`FTP_PORT`]
     * env vars.
     */
    auth?: FtpAuthConfig;
    /** Consumer root — where `config/auth-ftp.json` is resolved from. */
    cwd?: string;
    /** Re-upload every file regardless of the diff. */
    force?: boolean;
    /** Read remote state and print the diff without uploads, deletions or directory creation. */
    dryRun?: boolean;
    /** Print progress to stdout. Defaults to `auth.progress`. */
    progress?: boolean;
}

/** Deploy outcome summary. */
export interface DeployStats {
    uploaded: number;
    deleted: number;
    errors: number;
    zipUploaded: number;
    totalSize: number;
    startTime: Date | null;
    endTime: Date | null;
}

export interface DeployResult {
    stats: DeployStats;
    comparison: Comparison;
}

/** Threshold (fraction of server files) above which a mass-delete aborts. */
export const SAFETY_DELETE_THRESHOLD = 0.3;

/**
 * Compare using actual server file sizes from LIST, not manifest metadata.
 * Hash comparison is only checked when actual sizes match. Ports
 * `Manifest.compareWithServer` 1:1.
 *
 * Orphans are detected against the ACTUAL server listing (`serverFileSizes`),
 * not the remote manifest: a file that exists on the server but is missing from
 * the manifest — e.g. left over from an interrupted deploy where the manifest
 * upload never ran — would otherwise never be cleaned up. The manifest file
 * itself is always skipped (it lives on the server but is excluded from the
 * local manifest, and is uploaded separately as the last step of the deploy).
 */
export function compareWithServer(
    localManifest: Manifest,
    serverManifest: Manifest,
    serverFileSizes: Record<string, number>,
): Comparison {
    const toUpload: UploadItem[] = [];
    const toDelete: string[] = [];
    const unchanged: string[] = [];

    for (const [filePath, local] of Object.entries(localManifest)) {
        const actualSize = Object.hasOwn(serverFileSizes, filePath) ? serverFileSizes[filePath] : undefined;
        if (actualSize === undefined) {
            toUpload.push({ path: filePath, reason: 'new' });
        } else if (actualSize !== local.size) {
            toUpload.push({ path: filePath, reason: 'changed' });
        } else {
            const server = Object.hasOwn(serverManifest, filePath) ? serverManifest[filePath] : undefined;
            if (!server || server.hash !== local.hash) {
                toUpload.push({ path: filePath, reason: 'changed' });
            } else {
                unchanged.push(filePath);
            }
        }
    }

    for (const filePath of Object.keys(serverFileSizes)) {
        if (!Object.hasOwn(localManifest, filePath) && filePath !== MANIFEST_FILE) {
            toDelete.push(filePath);
        }
    }

    return {
        toUpload: toUpload.sort((a, b) => a.path.localeCompare(b.path)),
        toDelete: toDelete.sort(),
        unchanged,
        totalToUpload: toUpload.length,
        totalToDelete: toDelete.length,
        totalUnchanged: unchanged.length,
    };
}

/**
 * Safety guard: abort when a deploy would delete more than 30% of the files on
 * the server. The threshold is computed against the ACTUAL server file count
 * (`serverFileCount`, from LIST), since orphan detection uses that listing.
 * Returns `true` when the deploy should be aborted.
 */
export function shouldSafetyAbort(
    totalToDelete: number,
    serverFileCount: number,
    threshold: number = SAFETY_DELETE_THRESHOLD,
): boolean {
    if (serverFileCount <= 0) return false;
    return totalToDelete > serverFileCount * threshold;
}

/** Validate manifest entries and reject unsafe relative paths. */
function parseManifest(raw: string): Manifest {
    const parsed: unknown = JSON.parse(raw);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
    }
    const manifest: Manifest = Object.create(null);

    for (const [name, entry] of Object.entries(parsed)) {
        if (name === MANIFEST_FILE || !name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)
            || path.posix.isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
            throw new Error(`unsafe manifest path: ${JSON.stringify(name)}`);
        }
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
            || !('size' in entry) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0
            || !('hash' in entry) || typeof entry.hash !== 'string' || !entry.hash.trim()) {
            throw new Error(`invalid manifest entry: ${name}`);
        }
        manifest[name] = { size: entry.size, hash: entry.hash };
    }
    return manifest;
}

/** Read the local manifest; absence returns {}, while malformed data or an
 *  unsafe artifact file fails rather than silently disabling manifest diffing. */
export async function loadLocalManifest(siteDir: string): Promise<Manifest> {
    let raw: string;
    let root: string;

    try {
        root = await fs.realpath(siteDir);
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return {};
        }
        throw err;
    }
    const manifestEntryPath = path.join(root, MANIFEST_FILE);
    let manifestEntry;

    try {
        manifestEntry = await fs.lstat(manifestEntryPath);
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return {};
        }
        throw err;
    }
    if (manifestEntry.isSymbolicLink()) {
        throw new Error(`Invalid local artifact file: ${MANIFEST_FILE} (outside artifact, not a file, or size mismatch)`);
    }
    const manifestPath = await preflightArtifactFile(root, MANIFEST_FILE, undefined, true);
    let manifestHandle: Awaited<ReturnType<typeof fs.open>>;

    try {
        manifestHandle = await fs.open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return {};
        }
        throw err;
    }
    try {
        const stat = await manifestHandle.stat();

        if (!stat.isFile()) {
            throw new Error(`Invalid local artifact file: ${MANIFEST_FILE} (outside artifact, not a file, or size mismatch)`);
        }
        raw = await manifestHandle.readFile('utf8');
    } finally {
        await manifestHandle.close();
    }
    try {
        return parseManifest(raw);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        throw new Error(`manifest.json is malformed (${msg}) — rerun \`nuckty build\` first`);
    }
}

/** Resolve a local artifact to its canonical path after checking its boundary and type. */
async function preflightArtifactFile(
    root: string,
    name: string,
    expectedSize?: number,
    rejectSymlink = false,
): Promise<string> {
    const local = path.resolve(root, name);
    const entry = await fs.lstat(local);
    const real = await fs.realpath(local);
    const stat = await fs.stat(real);

    if ((rejectSymlink && entry.isSymbolicLink())
        || !real.startsWith(root + path.sep)
        || !stat.isFile()
        || (expectedSize !== undefined && stat.size !== expectedSize)) {
        throw new Error(`Invalid local artifact file: ${name} (outside artifact, not a file, or size mismatch)`);
    }
    await fs.access(real, constants.R_OK);
    return real;
}

async function preflightFiles(outDir: string, manifest: Manifest): Promise<Map<string, string>> {
    const root = await fs.realpath(outDir);
    const files = new Map<string, string>();

    for (const [name, info] of Object.entries(manifest)) {
        const file = await preflightArtifactFile(root, name, info.size);
        const hash = createHash('md5');

        for await (const chunk of createReadStream(file)) {
            hash.update(chunk);
        }
        if (hash.digest('hex').slice(0, 16) !== info.hash) {
            throw new Error(`Invalid local artifact file: ${name} (manifest hash mismatch)`);
        }
        files.set(name, file);
    }
    files.set(MANIFEST_FILE, await preflightArtifactFile(root, MANIFEST_FILE, undefined, true));
    return files;
}

/** Walk a directory and return `{ local, remote }` pairs for every file. */
export function getAllFiles(dirPath: string, basePath = ''): Array<{ local: string; remote: string }> {
    const files: Array<{ local: string; remote: string }> = [];
    const items = readdirSync(dirPath);
    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const relativePath = path.join(basePath, item);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            files.push(...getAllFiles(fullPath, relativePath));
        } else {
            files.push({ local: fullPath, remote: relativePath.replace(/\\/g, '/') });
        }
    }
    return files;
}

/**
 * Load FTP auth config. Env vars take precedence: `FTP_HOST`, `FTP_USER`,
 * `FTP_PASSWORD` (or legacy `FTP_PASS`), `FTP_PATH`, optional `FTP_PORT`.
 * Falls back to `config/auth-ftp.json` under `cwd`.
 *
 * Note: the reference uses `FTP_PASS`; the spec names `FTP_PASSWORD`. Both are
 * accepted (PASSWORD preferred) so consumers can use either.
 */
export function loadAuthConfig(cwd: string, configPath = 'config/auth-ftp.json'): FtpAuthConfig {
    const envConfig = loadAuthFromEnv();
    if (envConfig) return envConfig;

    const absConfigPath = path.join(cwd, configPath);
    if (!existsSync(absConfigPath)) {
        throw new Error(
            `Failed to load FTP config: no auth-ftp.json at ${absConfigPath} and ` +
                'FTP_HOST/FTP_USER/FTP_PASSWORD/FTP_PATH env not set',
        );
    }
    const raw = readFileSync(absConfigPath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(
            `Failed to load FTP config: ${absConfigPath} is not valid JSON`,
        );
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Failed to load FTP config: ${absConfigPath} is empty or not a JSON object`);
    }
    const cfg = parsed as Record<string, unknown>;

    const required = ['host', 'user', 'password', 'remote_path'] as const;
    for (const field of required) {
        if (!cfg[field]) {
            throw new Error(`Missing required field '${field}' in ${absConfigPath}`);
        }
    }

    const port = (cfg['port'] as number | undefined) ?? 21;
    const secure = parseSecure(cfg['secure']);
    const progress = (cfg['progress'] as boolean | undefined) ?? true;

    return {
        host: String(cfg['host']),
        port,
        user: String(cfg['user']),
        password: String(cfg['password']),
        remotePath: String(cfg['remote_path']),
        secure,
        passive: true,
        progress,
    };
}

/** Plain FTP remains the default; enabling TLS never disables certificate checks. */
function parseSecure(value: unknown): boolean {
    if (value === undefined || value === false || value === 'false') {
        return false;
    }
    if (value === true || value === 'true') {
        return true;
    }
    throw new Error('FTP secure must be true or false');
}

function loadAuthFromEnv(): FtpAuthConfig | null {
    const host = process.env.FTP_HOST;
    const user = process.env.FTP_USER;
    const password = process.env.FTP_PASSWORD ?? process.env.FTP_PASS;
    const remotePath = process.env.FTP_PATH;
    const port = process.env.FTP_PORT;

    if (host && user && password && remotePath) {
        return {
            host,
            user,
            password,
            remotePath,
            port: port ? parseInt(port, 10) : 21,
            secure: parseSecure(process.env.FTP_SECURE),
            passive: true,
            progress: true,
        };
    }
    return null;
}

/** Default stats object (zeroed, timers null). */
function emptyStats(): DeployStats {
    return {
        uploaded: 0,
        deleted: 0,
        errors: 0,
        zipUploaded: 0,
        totalSize: 0,
        startTime: null,
        endTime: null,
    };
}

/** Transient state passed through the deploy helpers. */
interface DeployState {
    client: FtpTransport | null;
    createClient: () => FtpTransport;
    retryDelayMs: number;
    stats: DeployStats;
    auth: FtpAuthConfig;
}

/**
 * Connect to the FTP server and `CD` into the remote root. Retries once on
 * connection failure (mirrors `initClient`). Passive mode always on; TLS when
 * `auth.secure` (NO SSH — FTPS only).
 */
async function initClient(state: DeployState): Promise<void> {
    const { auth } = state;
    const accessOpts: ftp.AccessOptions = {
        host: auth.host,
        port: auth.port,
        user: auth.user,
        password: auth.password,
        secure: auth.secure,
    };

    state.client?.close();
    state.client = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const client = state.createClient();

        try {
            await client.access(accessOpts);
            await client.cd(auth.remotePath);
            state.client = client;
            return;
        } catch (err) {
            client.close();
            if (attempt === 1) {
                const msg = err instanceof Error ? err.message : String(err);

                throw new Error(`Failed to connect to FTP server: ${msg}`);
            }
        }
    }
}

/**
 * Set the remote file's mtime via MFMT so the server reflects the source
 * mtime. Non-critical: silently ignored when the server does not support MFMT.
 */
async function fixRemoteTimestamp(
    client: FtpTransport,
    remotePath: string,
    localPath: string,
): Promise<void> {
    try {
        const stats = statSync(localPath);
        const ts = stats.mtime
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\..+/, '')
            .replace('T', '');
        await client.send(`MFMT ${ts} ${remotePath}`);
    } catch {
        // MFMT not supported or failed — non-critical.
    }
}

/** Retryable transient-error markers from the reference uploadFile. */
const RETRYABLE = ['425', 'Connection', 'timeout', 'canceled', 'aborted', 'ECONNRESET'];

/**
 * Upload one file with retry on transient errors. Sets mtime via MFMT after a
 * successful upload. Returns true on success, false on failure.
 */
async function uploadFile(
    state: DeployState,
    localPath: string,
    remotePath: string,
    progress: boolean,
    retryCount = 0,
): Promise<boolean> {
    const client = state.client;
    if (!client) return false;
    if (!existsSync(localPath)) {
        state.stats.errors++;
        return false;
    }

    const maxRetries = 2;
    const size = statSync(localPath).size;

    try {
        await client.uploadFrom(localPath, remotePath);
        await fixRemoteTimestamp(client, remotePath, localPath);
        state.stats.uploaded++;
        state.stats.totalSize += size;
        if (remotePath.endsWith('.zip')) state.stats.zipUploaded++;
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
            retryCount < maxRetries &&
            RETRYABLE.some((marker) => msg.includes(marker))
        ) {
            await new Promise((resolve) => setTimeout(resolve, state.retryDelayMs));
            try {
                await client.send('NOOP');
            } catch {
                await initClient(state);
            }
            return uploadFile(state, localPath, remotePath, progress, retryCount + 1);
        }
        if (progress) {
            console.error(`  Upload failed: ${remotePath} — ${msg}`);
        }
        state.stats.errors++;
        return false;
    }
}

/**
 * Recursively list files on the server. Returns a map of `path → size` (the
 * ground truth used for diffing and verification). Any failed LIST
 * is fatal (CMD-06): swallowing it produced a partial snapshot presented as
 * the full server state — every diff decision made from it is wrong.
 */
async function listServerFiles(client: FtpTransport): Promise<Record<string, number>> {
    const files: Record<string, number> = Object.create(null);
    const listDir = async (dirPath: string): Promise<void> => {
        let list: Awaited<ReturnType<FtpTransport['list']>>;

        try {
            list = await client.list(dirPath);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            throw new Error(`Cannot list remote directory ${dirPath} (${msg}) — incomplete server snapshot`);
        }
        for (const item of list) {
            if (item.name === '.' || item.name === '..') continue;
            if (!item.name || /[\\/\x00-\x1f\x7f]/.test(item.name) || !Number.isFinite(item.size) || item.size < 0) {
                throw new Error(`Invalid remote listing entry in ${dirPath}`);
            }
            const fullPath = dirPath === '.' ? item.name : `${dirPath}/${item.name}`;
            const isDir = item.isDirectory;
            if (isDir) {
                await listDir(fullPath);
            } else {
                files[fullPath] = item.size;
            }
        }
    };
    await listDir('.');
    return files;
}

/**
 * Ensure the remote parent directories of `remotePath` exist before an upload
 * (CMD-03): `uploadFrom` issues a bare `STOR` and does NOT create nested
 * parents, so the first deploy of `html/a.html` fails on servers that don't
 * auto-create directories. basic-ftp's `ensureDir` CHANGES cwd into the
 * created directory, so afterwards we `cd` back to the remote root — every
 * other operation uses root-relative paths.
 */
async function ensureRemoteDir(
    client: FtpTransport,
    remoteDir: string,
    ensuredDirs: Set<string>,
    remoteRoot: string,
): Promise<void> {
    if (!remoteDir || ensuredDirs.has(remoteDir)) return;
    await client.cd(remoteRoot);
    await client.ensureDir(remoteDir);
    await client.cd(remoteRoot);
    ensuredDirs.add(remoteDir);
}

/**
 * Download a manifest known to exist from the complete listing, without local writes.
 */
async function downloadServerManifest(client: FtpTransport): Promise<Manifest> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
            chunks.push(Buffer.from(chunk));
            done();
        },
    });

    try {
        await client.downloadTo(sink, MANIFEST_FILE);
        return parseManifest(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        throw new Error(`Cannot download the remote ${MANIFEST_FILE} (${msg}) — aborting`);
    } finally {
        sink.destroy();
    }
}

export async function ftpDeploy(opts: DeployOpts, dependencies: DeployDependencies = {}): Promise<DeployResult> {
    const cwd = opts.cwd ?? process.cwd();
    const auth = opts.auth ?? loadAuthConfig(cwd);
    const progress = opts.progress ?? auth.progress;
    const { force = false, dryRun = false } = opts;

    const state: DeployState = {
        client: null, stats: emptyStats(), auth,
        createClient: dependencies.createClient ?? (() => new ftp.Client()),
        retryDelayMs: dependencies.retryDelayMs ?? 1000,
    };
    state.stats.startTime = new Date();

    try {
        // CMD-06: validate the local artifact BEFORE opening the network —
        // a broken build must fail locally, not after connecting.
        let artifactRoot: string;
        try {
            artifactRoot = await fs.realpath(opts.outDir);
        } catch (err) {
            if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
                throw new Error('manifest.json is empty or missing. Run build first.');
            }
            throw err;
        }
        const localManifest = await loadLocalManifest(artifactRoot);
        const localFileCount = Object.keys(localManifest).length;
        if (localFileCount === 0) {
            throw new Error('manifest.json is empty or missing. Run build first.');
        }
        const fileMap = await preflightFiles(artifactRoot, localManifest);

        if (progress) console.log(`Local: ${localFileCount} files`);

        await initClient(state);
        const remoteRoot = await state.client!.pwd();

        if (progress) console.log(`Connected to FTP server: ${auth.host}`);

        // Ground-truth server sizes via LIST (always — even dry-run — so orphan
        // detection reflects the real server state). A denied/failed LIST used
        // to silently yield an EMPTY diff input — the deploy would then plan
        // every local file as "new" and, worse, treat every existing remote
        // file as untouched. Abort instead (CMD-06): a deploy must not plan
        // against a snapshot it knows is incomplete.
        if (progress) console.log('Scanning server files...');
        const serverFiles = await listServerFiles(state.client!);

        const noServerManifest = !Object.hasOwn(serverFiles, MANIFEST_FILE);
        const serverManifest = noServerManifest || force ? {} : await downloadServerManifest(state.client!);
        const comparison = compareWithServer(localManifest, serverManifest, serverFiles);

        if (force || noServerManifest) {
            comparison.toUpload = Object.keys(localManifest).sort().map((name) => ({
                path: name, reason: force ? 'force' : 'new',
            }));
            comparison.totalToUpload = comparison.toUpload.length;
            comparison.unchanged = [];
            comparison.totalUnchanged = 0;
        }
        if (!force && shouldSafetyAbort(comparison.totalToDelete, Object.keys(serverFiles).length)) {
            throw new Error(
                `Safety abort: would delete ${comparison.totalToDelete} of ${Object.keys(serverFiles).length} files (>30%). ` +
                'Run with --force to override.',
            );
        }

        if (progress) {
            if (comparison.totalToUpload > 0) {
                console.log(`Files to upload: ${comparison.totalToUpload}`);
            } else {
                console.log('All files up to date');
            }
            if (comparison.totalToDelete > 0) {
                console.log(`Files to delete: ${comparison.totalToDelete}`);
            }
        }

        // Upload changed/new files. First upload into each remote directory
        // creates it (CMD-03): `uploadFrom` does not create parents.
        const ensuredDirs = new Set<string>();
        for (const item of comparison.toUpload) {
            const localPath = fileMap.get(item.path);
            if (!localPath) {
                if (progress) console.error(`Error: File not found: ${item.path}`);
                state.stats.errors++;
                continue;
            }

            if (progress) {
                const isZip = item.path.endsWith('.zip');
                const size = statSync(localPath).size;
                const sizeStr = isZip
                    ? `${(size / 1024 / 1024).toFixed(1)}MB`
                    : `${(size / 1024).toFixed(1)}KB`;
                console.log(`[${item.reason.toUpperCase()}] ${item.path} ${sizeStr}`);
            }

            if (dryRun) {
                state.stats.uploaded++;
                state.stats.totalSize += statSync(localPath).size;
            } else {
                const parentDir = path.posix.dirname(item.path);
                if (parentDir !== '.' && !ensuredDirs.has(parentDir)) {
                    await ensureRemoteDir(state.client!, parentDir, ensuredDirs, remoteRoot);
                }
                await uploadFile(state, localPath, item.path, progress);
            }
        }

        if (!dryRun && state.stats.errors > 0) {
            throw new Error(`Manifest not uploaded: ${state.stats.errors} upload error(s) — rerun to retry`);
        }

        // Delete orphaned files (dry-run only prints the plan).
        if (comparison.totalToDelete > 0) {
            if (progress) {
                const action = dryRun ? 'Would delete' : 'Deleting';
                console.log(`\n${action} ${comparison.totalToDelete} orphaned files...`);
                for (const f of comparison.toDelete) console.log(`  ${f}`);
            }
            if (!dryRun) {
                const client = state.client!;
                for (const filePath of comparison.toDelete) {
                    try {
                        await client.remove(filePath);
                        state.stats.deleted++;
                        if (progress) process.stdout.write(`Deleted: ${filePath}\r`);
                    } catch (err) {
                        state.stats.errors++;
                        if (progress) {
                            const msg = err instanceof Error ? err.message : String(err);
                            console.error(`  Failed to delete ${filePath}: ${msg}`);
                        }
                    }
                }
            }
        }

        // Verify via LIST, retry failed uploads, then upload the manifest LAST.
        if (!dryRun) {
            if (progress) console.log('Verifying files on server...');
            const verifyFiles = await listServerFiles(state.client!);
            for (const deleted of comparison.toDelete) {
                if (Object.hasOwn(verifyFiles, deleted)) {
                    throw new Error(`Deletion verification failed: ${deleted} still exists; manifest not uploaded`);
                }
            }
            const failedFiles: Array<{ path: string; reason: string }> = [];
            for (const [filePath, info] of Object.entries(localManifest)) {
                const remoteSize = verifyFiles[filePath];
                if (remoteSize === undefined) {
                    failedFiles.push({ path: filePath, reason: 'missing' });
                    if (progress) console.error(`  VERIFY FAILED: ${filePath} not found on server`);
                } else if (remoteSize !== info.size) {
                    failedFiles.push({ path: filePath, reason: 'size mismatch' });
                    if (progress) {
                        console.error(
                            `  VERIFY FAILED: ${filePath} size mismatch ` +
                                `(expected ${info.size}, got ${remoteSize})`,
                        );
                    }
                } else if (progress) {
                    console.log(`  OK ${filePath} (${info.size} bytes)`);
                }
            }
            const ok = localFileCount - failedFiles.length;
            if (progress) console.log(`  Verified: ${ok}, Failed: ${failedFiles.length}`);

            if (failedFiles.length > 0) {
                if (progress) console.log(`Retrying ${failedFiles.length} failed files...`);
                for (const fail of failedFiles) {
                    const localPath = fileMap.get(fail.path);
                    if (!localPath) {
                        state.stats.errors++;
                        continue;
                    }
                    const parentDir = path.posix.dirname(fail.path);

                    if (parentDir !== '.') {
                        await ensureRemoteDir(state.client!, parentDir, ensuredDirs, remoteRoot);
                    }
                    await uploadFile(state, localPath, fail.path, progress);
                }

                if (progress) console.log('Re-verifying...');
                const reverifyFiles = await listServerFiles(state.client!);
                let stillMissing = 0;
                let stillMismatch = 0;
                for (const fail of failedFiles) {
                    const info = localManifest[fail.path];
                    const remoteSize = reverifyFiles[fail.path];
                    if (remoteSize === undefined) {
                        stillMissing++;
                        if (progress) console.error(`  STILL FAILED: ${fail.path} not found on server`);
                    } else if (info && remoteSize !== info.size) {
                        stillMismatch++;
                        if (progress) {
                            console.error(
                                `  STILL FAILED: ${fail.path} size mismatch ` +
                                    `(expected ${info.size}, got ${remoteSize})`,
                            );
                        }
                    } else if (progress) {
                        console.log(`  OK ${fail.path}`);
                    }
                }
                if (stillMissing > 0 || stillMismatch > 0) {
                    state.stats.errors += stillMissing + stillMismatch;
                    throw new Error(
                        `Verification failed after retry: ${stillMissing} missing, ` +
                            `${stillMismatch} size mismatch`,
                    );
                }
                if (progress) console.log(`All ${failedFiles.length} retried files verified`);
            } else if (progress) {
                console.log(`All ${localFileCount} files verified`);
            }

            // Commit rule (arch review, Wave A): the manifest is the record of
            // "these uploads are done". Uploading it despite upload/delete
            // errors would mark failed files as deployed — size-based
            // verification cannot catch a same-size failure, and the next run
            // would diff against the committed manifest and skip the retry.
            // Refuse to upload it when anything failed; the next deploy
            // re-diffs against the OLD remote manifest and re-uploads.
            if (state.stats.errors > 0) {
                throw new Error(
                    `Manifest not uploaded: ${state.stats.errors} error(s) during ` +
                        `upload/delete — server state is not fully synced; rerun to retry`,
                );
            }
            // Upload manifest last so it always reflects actual server state.
            if (JSON.stringify(await loadLocalManifest(artifactRoot)) !== JSON.stringify(localManifest)) {
                throw new Error('Local manifest changed during deployment; manifest not uploaded');
            }
            await preflightFiles(artifactRoot, localManifest);
            const localManifestPath = fileMap.get(MANIFEST_FILE);
            if (!localManifestPath) {
                throw new Error('Invalid local artifact file: manifest.json');
            }
            const finalManifestPath = await preflightArtifactFile(artifactRoot, MANIFEST_FILE, undefined, true);
            if (!(await uploadFile(state, finalManifestPath, MANIFEST_FILE, false))) {
                throw new Error('Manifest upload failed — deploy not committed');
            }
            if (progress) console.log('Manifest uploaded');
        }

        state.stats.endTime = new Date();
        if (progress) printSummary(state.stats, dryRun);

        return { stats: state.stats, comparison };
    } catch (err) {
        state.stats.errors++;
        state.stats.endTime = new Date();
        throw err;
    } finally {
        if (state.client) {
            try {
                state.client.close();
            } catch {
                // ignore
            }
        }
    }
}

/** Print the deployment summary (mirrors `printSummary`). */
export function printSummary(stats: DeployStats, dryRun = false): void {
    const duration =
        stats.startTime && stats.endTime ? stats.endTime.getTime() - stats.startTime.getTime() : 0;
    const sizeMB = (stats.totalSize / 1024 / 1024).toFixed(2);
    const speed =
        duration > 0 ? (stats.totalSize / 1024 / (duration / 1000)).toFixed(2) : '0';

    console.log('\nDeployment Summary');
    console.log('==================');
    console.log(`Uploaded: ${stats.uploaded} files`);
    if (stats.deleted > 0) console.log(`Deleted: ${stats.deleted} files`);
    if (stats.zipUploaded > 0) console.log(`  (ZIP files: ${stats.zipUploaded})`);
    if (stats.errors > 0) console.log(`Errors: ${stats.errors} files`);
    console.log(`Total size: ${sizeMB} MB`);
    console.log(`Duration: ${(duration / 1000).toFixed(2)} seconds`);
    if (stats.uploaded > 0) console.log(`Speed: ${speed} KB/s`);
    if (dryRun) console.log('\nDRY RUN - No files were actually uploaded');
}

