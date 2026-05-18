import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import type { VibeFlowClient } from '../api/client.js';

/**
 * Local binary cache for chat attachments (#1670). Lives in
 * `context.globalStorageUri/asset-cache/`. The host owns it because
 * the webview can't read disk; the webview gets `asWebviewUri()` views
 * of these files for rendering.
 *
 * Architecture (per postmortem 2026-05-18):
 *
 *   webview                                  host                          axiomcloud
 *   -------                                  ----                          ----------
 *   paste/drag/pick file                ──▶  chatUploadAsset (base64)
 *                                            validate + sniff MIME
 *                                            POST /assets/upload ──────▶   stores
 *                                                                   ◀─── { id }
 *                                            POST /attachments link
 *                                            (project_id, asset_id)
 *                                            ───────────────────────▶
 *                                                                   ◀─── created
 *                                            write bytes to cache
 *                                            (we already have them in
 *                                             memory from the upload)
 *   ◀────── { asset metadata }
 *
 *   render <AssetCard id=N>             ───▶ chatGetAssetUri { id }
 *                                            ensure cached on disk
 *                                            (fetch via downloadAsset
 *                                             if missing — uses x-api-key
 *                                             which never leaves host)
 *                                            asWebviewUri(file)
 *   ◀──── { uri: "vscode-cdn://..." }
 *   <img src={uri} />
 *
 * Cache filenames are just `<asset_id>` (no extension). Webviews don't
 * care about file extensions — we hand back the URI directly and
 * MessageBubble already knows the MIME from the asset metadata. Keeps
 * filename sanitization trivial.
 */
export class AssetCache {
  /** In-flight downloads keyed by asset id, so concurrent get()s
   *  for the same id share one network fetch. */
  private inFlight = new Map<number, Promise<vscode.Uri>>();
  /**
   * Generation counter — bumped on `clearAll`. Downloads capture the
   * value at start and bail out (deleting any partial they wrote) if
   * the generation moved while they were in flight. Closes the
   * logout-during-download race: clearAll wouldn't otherwise be able
   * to evict bytes mid-write, potentially leaking the previous user's
   * data into the next session.
   */
  private generation = 0;

  constructor(
    private readonly client: VibeFlowClient,
    /** Root of the cache, e.g. `context.globalStorageUri/asset-cache`. */
    private readonly cacheRoot: vscode.Uri,
  ) {}

  /**
   * The directory the webview's `localResourceRoots` should include so
   * `webview.asWebviewUri(localUri)` works for cached binaries. Callers
   * register this once when constructing the panel.
   */
  get localResourceRoot(): vscode.Uri {
    return this.cacheRoot;
  }

  /**
   * Return the on-disk Uri for an asset, downloading + caching if not
   * already present. Concurrent calls for the same id share the fetch.
   *
   * `name` is the original filename — used so the on-disk path retains
   * the file extension (`<id>/<safeName>`). Without the extension,
   * VSCode's webview asset server can't pick a Content-Type, and
   * Chromium's `<img>` content-sniffer fails for SVG (refusing to
   * render text-shaped image bytes without an explicit type).
   *
   * The caller turns the returned Uri into a webview-safe URL via
   * `webview.asWebviewUri(uri)`.
   */
  async getLocalUri(assetId: number, name: string): Promise<vscode.Uri> {
    if (!Number.isInteger(assetId) || assetId <= 0) {
      throw new Error(`Invalid asset id: ${assetId}`);
    }
    const safeName = safePathSegment(name);
    if (!safeName) { throw new Error(`Invalid asset name: ${name}`); }
    const target = this.pathFor(assetId, safeName);
    if (fs.existsSync(target.fsPath)) {
      // Touch mtime so a future LRU eviction sees a fresh access time.
      try { await fsp.utimes(target.fsPath, new Date(), new Date()); } catch { /* best-effort */ }
      return target;
    }
    const existing = this.inFlight.get(assetId);
    if (existing) { return existing; }
    const promise = this.downloadAndStore(assetId, safeName, target);
    this.inFlight.set(assetId, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(assetId);
    }
  }

  /**
   * Store bytes we already have in memory under the canonical cache
   * path for an asset. Called by the upload handler after a successful
   * upload — the bytes are still in memory, no point re-downloading
   * what we just sent.
   *
   * If a `clearAll` fires after we entered this function but before we
   * commit, we delete the file we just wrote so the previous-user
   * bytes don't survive into the next session.
   */
  async storeKnownBytes(assetId: number, name: string, bytes: Uint8Array): Promise<vscode.Uri> {
    if (!Number.isInteger(assetId) || assetId <= 0) {
      throw new Error(`Invalid asset id: ${assetId}`);
    }
    const safeName = safePathSegment(name);
    if (!safeName) { throw new Error(`Invalid asset name: ${name}`); }
    const genStart = this.generation;
    await this.ensureAssetDir(assetId);
    const target = this.pathFor(assetId, safeName);
    await fsp.writeFile(target.fsPath, bytes);
    if (this.generation !== genStart) {
      // Logout / project-switch fired mid-write — drop what we just
      // wrote rather than serve another user's bytes from the cache.
      try { await fsp.rm(target.fsPath, { force: true }); } catch { /* best-effort */ }
      throw new Error('Cache cleared during write — aborting.');
    }
    return target;
  }

  /**
   * Wipe the entire cache. Wired to logout / project switch — the
   * cached binaries are tied to the authenticated identity. Also bumps
   * the generation counter so any in-flight downloads bail before
   * committing their bytes.
   */
  async clearAll(): Promise<void> {
    this.generation++;
    try {
      await fsp.rm(this.cacheRoot.fsPath, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  /**
   * Asset live under `<cacheRoot>/<id>/<safeName>` (subdir per id) so:
   *   1. The URL the webview sees ends with the original filename →
   *      extension preserved → Content-Type sniffing works for SVG and
   *      other text-shaped image formats.
   *   2. Two assets that happen to share a filename never collide.
   */
  private pathFor(assetId: number, safeName: string): vscode.Uri {
    return vscode.Uri.joinPath(this.cacheRoot, String(assetId), safeName);
  }

  private async ensureRoot(): Promise<void> {
    await fsp.mkdir(this.cacheRoot.fsPath, { recursive: true });
  }

  private async ensureAssetDir(assetId: number): Promise<void> {
    await fsp.mkdir(vscode.Uri.joinPath(this.cacheRoot, String(assetId)).fsPath, { recursive: true });
  }

  private async downloadAndStore(assetId: number, safeName: string, target: vscode.Uri): Promise<vscode.Uri> {
    const genStart = this.generation;
    await this.ensureAssetDir(assetId);
    const bytes = await this.client.downloadAsset(assetId);
    if (this.generation !== genStart) {
      throw new Error('Cache cleared during download — aborting.');
    }
    // Atomic-ish write: stage to a `.partial` sibling and rename. If
    // the generation moved between rename and the post-check, we
    // delete the file we just committed (best-effort) and bail.
    const partial = vscode.Uri.joinPath(this.cacheRoot, String(assetId), `${safeName}.partial`);
    await fsp.writeFile(partial.fsPath, bytes);
    await fsp.rename(partial.fsPath, target.fsPath);
    if (this.generation !== genStart) {
      try { await fsp.rm(target.fsPath, { force: true }); } catch { /* best-effort */ }
      throw new Error('Cache cleared during download — aborting.');
    }
    return target;
  }
}

/**
 * Cache-segment sanitization. Stripped to a path-safe shape:
 * basename only, no control bytes, no leading dots, capped at 200.
 * Falls back to `file` when input collapses to empty so we always
 * produce a usable filename.
 */
function safePathSegment(raw: string): string {
  if (typeof raw !== 'string') { return ''; }
  const noSeparators = raw.replace(/^.*[\\/]/, '').trim();
  const cleaned = noSeparators
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 200);
  return cleaned || 'file';
}
