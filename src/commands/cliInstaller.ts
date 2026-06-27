import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';

/**
 * Auto-installer for the vibeflow CLI binary. Fetches the latest release
 * asset from GitHub, extracts the binary into the extension's
 * globalStorageUri, chmods it, and writes the absolute path into
 * `vibeflow.cli.binaryPath` so `resolveBinary()` picks it up on the
 * next launch.
 *
 * Per-machine scope by design: globalStorageUri is owned by the
 * extension and survives extension updates but not full uninstall.
 * We never write into PATH directories or mutate shell rc files.
 *
 * Wire trust: HTTPS-only fetch with a hostname allowlist
 * (api.github.com + *.github.com + objects.githubusercontent.com for
 * the redirect target). 100MB content-length cap. Optional SHA-256
 * verification when the release publishes a `checksums.txt`; we skip
 * silently when not present rather than fail-closed (matches the
 * docs-published install flow today which has no checksum check at all).
 */

const GITHUB_OWNER = 'axiom-studio';
const GITHUB_REPO = 'vibeflow-cli';
const RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB sanity cap

/**
 * Hostname allowlist for the GitHub release flow:
 * - api.github.com hosts the manifest call
 * - github.com hosts the release page redirects
 * - GitHub's content CDN lives under *.githubusercontent.com — the
 *   specific subdomain has rotated over time (`objects.`, `codeload.`,
 *   and as of 2025 release assets redirect via `release-assets.`).
 *   We allow any `.githubusercontent.com` host rather than chase
 *   subdomain churn, while still rejecting impostors like
 *   `evil-githubusercontent.com.attacker.tld` (suffix match against
 *   the actual `.githubusercontent.com` parent, not substring).
 */
const EXACT_HOSTS = new Set([
  'api.github.com',
  'github.com',
]);

function isAllowedHost(hostname: string): boolean {
  if (EXACT_HOSTS.has(hostname)) { return true; }
  return hostname === 'githubusercontent.com' || hostname.endsWith('.githubusercontent.com');
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface ReleaseManifest {
  tag_name: string;
  name: string;
  assets: ReleaseAsset[];
}

/**
 * Map process.platform + process.arch to the platform/arch tokens
 * used in vibeflow-cli release asset filenames. We don't hard-code the
 * full filename — the regex match in pickAsset() does fuzzy matching
 * against goreleaser's defaults (e.g. `vibeflow_darwin_arm64.tar.gz`,
 * `vibeflow-cli_Darwin_arm64.tar.gz`, etc.).
 */
function platformTokens(): { os: RegExp; arch: RegExp; ext: RegExp } {
  const os = process.platform === 'win32'
    ? /windows/i
    : process.platform === 'darwin'
      ? /darwin|mac(os)?/i
      : /linux/i;
  const arch = process.arch === 'arm64'
    ? /arm64|aarch64/i
    : process.arch === 'x64'
      ? /amd64|x86_64|x64/i
      : new RegExp(process.arch, 'i');
  // Tarball on macOS/Linux, zip on Windows — both are extractable via
  // the bundled `tar` on Windows 10+, so we accept either form.
  const ext = /\.(tar\.gz|tgz|zip)$/i;
  return { os, arch, ext };
}

function pickAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  const { os, arch, ext } = platformTokens();
  return assets.find(a => os.test(a.name) && arch.test(a.name) && ext.test(a.name));
}

function assertAllowedHost(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to download over non-HTTPS URL: ${url}`);
  }
  if (!isAllowedHost(parsed.hostname)) {
    throw new Error(`Refusing to download from non-allowlisted host: ${parsed.hostname}`);
  }
  return parsed;
}

async function fetchJson<T>(url: string): Promise<T> {
  assertAllowedHost(url);
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'vscode-vibeflow' },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  return await res.json() as T;
}

/**
 * The latest published CLI release tag (e.g. "v1.0.10") from GitHub, or
 * undefined when the lookup fails (offline / rate-limited). Reuses the same
 * release endpoint installCli downloads from.
 */
export async function fetchLatestCliTag(): Promise<string | undefined> {
  try {
    const manifest = await fetchJson<ReleaseManifest>(RELEASE_API);
    return manifest.tag_name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stream-download to a temp file with a size cap. We don't buffer the
 * whole binary in memory — it's ~30MB and Node's Buffer per-request
 * cap is fine for that, but streaming is cheaper and lets the cap
 * trip mid-transfer if a malicious mirror tries to balloon the payload.
 */
async function downloadToFile(url: string, destPath: string, onProgress?: (received: number, total: number) => void): Promise<void> {
  assertAllowedHost(url);
  const res = await fetch(url, {
    headers: { 'Accept': 'application/octet-stream', 'User-Agent': 'vscode-vibeflow' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText})`);
  }
  // GitHub redirects to objects.githubusercontent.com — verify the
  // final URL still lands inside the allowlist.
  if (res.url) { assertAllowedHost(res.url); }

  const contentLengthHeader = res.headers.get('content-length');
  const total = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : 0;
  if (total > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Asset too large (${total} bytes; cap is ${MAX_DOWNLOAD_BYTES})`);
  }
  if (!res.body) { throw new Error('Empty response body'); }

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);
  let received = 0;

  const reader = res.body.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) { break; }
      if (!value) { continue; }
      received += value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
      }
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>(resolve => out.once('drain', resolve));
      }
      if (onProgress) { onProgress(received, total); }
    }
  } finally {
    await new Promise<void>(resolve => out.end(() => resolve()));
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Best-effort SHA-256 verification. Looks for a `checksums.txt` asset
 * (goreleaser default) and matches the asset filename inside it.
 * Returns null when no checksum is published — caller decides whether
 * to fail closed; today we proceed because the docs-published install
 * flow has no checksum step either, so adding a hard requirement
 * would be stricter than the path it replaces.
 */
async function tryVerifyChecksum(
  manifest: ReleaseManifest,
  assetName: string,
  downloadedPath: string,
): Promise<{ verified: true } | { verified: false; reason: string } | null> {
  const checksumAsset = manifest.assets.find(a => /checksums(\.txt)?$/i.test(a.name));
  if (!checksumAsset) { return null; }
  try {
    assertAllowedHost(checksumAsset.browser_download_url);
    const res = await fetch(checksumAsset.browser_download_url, {
      headers: { 'User-Agent': 'vscode-vibeflow' },
      redirect: 'follow',
    });
    if (!res.ok) { return null; }
    if (res.url) { assertAllowedHost(res.url); }
    const text = await res.text();
    const line = text.split(/\r?\n/).find(l => l.includes(assetName));
    if (!line) { return null; }
    const expected = line.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) { return null; }
    const actual = (await sha256OfFile(downloadedPath)).toLowerCase();
    if (expected === actual) { return { verified: true }; }
    return { verified: false, reason: `SHA-256 mismatch (expected ${expected}, got ${actual})` };
  } catch {
    return null;
  }
}

/**
 * Extract the downloaded archive (tar.gz / tgz / zip) into `destDir`
 * using the platform-bundled `tar` CLI. Windows 10 1803+ ships tar.exe
 * with zip support, so the same command handles both formats on every
 * platform we care about.
 */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const args = ['-xf', archivePath, '-C', destDir];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', buf => { stderr += String(buf); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`tar exit ${code}: ${stderr.trim()}`)); }
    });
  });
}

/**
 * Locate the `vibeflow` (or `vibeflow.exe`) executable inside the
 * extracted tree. The release archive may either drop the binary at
 * the root or under a versioned subdirectory; walk one level deep so
 * either layout works.
 */
async function findExtractedBinary(rootDir: string): Promise<string | undefined> {
  const target = process.platform === 'win32' ? 'vibeflow.exe' : 'vibeflow';
  const directHit = path.join(rootDir, target);
  if (fs.existsSync(directHit)) { return directHit; }
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) { continue; }
    const nested = path.join(rootDir, entry.name, target);
    if (fs.existsSync(nested)) { return nested; }
  }
  return undefined;
}

/**
 * The public entry point. Drives the install with a VSCode progress
 * notification so the user sees what's happening; on success, sets
 * `vibeflow.cli.binaryPath` to the absolute install path. Returns the
 * installed binary path on success, or undefined when the user cancels
 * or the platform isn't supported.
 *
 * Throws on hard errors so callers can surface them as toasts.
 */
export async function installCli(context: vscode.ExtensionContext): Promise<string | undefined> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Installing VibeFlow CLI',
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Fetching latest release…' });
      const manifest = await fetchJson<ReleaseManifest>(RELEASE_API);
      if (token.isCancellationRequested) { return undefined; }

      const asset = pickAsset(manifest.assets);
      if (!asset) {
        throw new Error(
          `No prebuilt asset matching ${process.platform}/${process.arch} found in ${manifest.tag_name}. ` +
          `Available: ${manifest.assets.map(a => a.name).join(', ') || '(none)'}`,
        );
      }

      // Stage download under globalStorageUri/cli-binaries/.staging
      // and atomically swap into place on success — avoids leaving a
      // half-written binary if extraction or chmod fails midway.
      const cliRoot = path.join(context.globalStorageUri.fsPath, 'cli-binaries');
      const stageDir = path.join(cliRoot, '.staging');
      await fsp.rm(stageDir, { recursive: true, force: true });
      await fsp.mkdir(stageDir, { recursive: true });
      const archivePath = path.join(stageDir, asset.name);

      progress.report({ message: `Downloading ${asset.name}…` });
      let lastPctReported = -1;
      await downloadToFile(asset.browser_download_url, archivePath, (received, total) => {
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPctReported && pct % 5 === 0) {
            progress.report({ message: `Downloading ${asset.name}… ${pct}%` });
            lastPctReported = pct;
          }
        }
      });
      if (token.isCancellationRequested) {
        await fsp.rm(stageDir, { recursive: true, force: true });
        return undefined;
      }

      progress.report({ message: 'Verifying checksum…' });
      const verification = await tryVerifyChecksum(manifest, asset.name, archivePath);
      if (verification && verification.verified === false) {
        await fsp.rm(stageDir, { recursive: true, force: true });
        throw new Error(verification.reason);
      }

      progress.report({ message: 'Extracting…' });
      const extractDir = path.join(stageDir, 'extracted');
      await extractArchive(archivePath, extractDir);

      const extractedBinary = await findExtractedBinary(extractDir);
      if (!extractedBinary) {
        await fsp.rm(stageDir, { recursive: true, force: true });
        throw new Error('Extracted archive did not contain a vibeflow executable.');
      }

      progress.report({ message: 'Installing…' });
      const finalDir = path.join(cliRoot, manifest.tag_name);
      await fsp.rm(finalDir, { recursive: true, force: true });
      await fsp.mkdir(finalDir, { recursive: true });
      const finalBinary = path.join(
        finalDir,
        process.platform === 'win32' ? 'vibeflow.exe' : 'vibeflow',
      );
      await fsp.copyFile(extractedBinary, finalBinary);

      if (process.platform !== 'win32') {
        try { await fsp.chmod(finalBinary, 0o755); } catch { /* best-effort */ }
      }
      await fsp.rm(stageDir, { recursive: true, force: true });

      // Wire the binary path into config so resolveBinary() picks it up
      // next time the user opens the CLI. We persist at Global scope so
      // the install travels with the user across workspaces.
      await vscode.workspace.getConfiguration('vibeflow').update(
        'cli.binaryPath',
        finalBinary,
        vscode.ConfigurationTarget.Global,
      );

      const tag = manifest.tag_name || '(latest)';
      vscode.window.showInformationMessage(
        `VibeFlow CLI ${tag} installed → ${finalBinary}`,
      );
      return finalBinary;
    },
  );
}
