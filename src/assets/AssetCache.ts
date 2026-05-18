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
   * The caller turns this Uri into a webview-safe URL via
   * `webview.asWebviewUri(uri)`.
   */
  async getLocalUri(assetId: number): Promise<vscode.Uri> {
    if (!Number.isInteger(assetId) || assetId <= 0) {
      throw new Error(`Invalid asset id: ${assetId}`);
    }
    const target = this.pathFor(assetId);
    if (fs.existsSync(target.fsPath)) {
      // Touch mtime so a future LRU eviction sees a fresh access time.
      try { await fsp.utimes(target.fsPath, new Date(), new Date()); } catch { /* best-effort */ }
      return target;
    }
    const existing = this.inFlight.get(assetId);
    if (existing) { return existing; }
    const promise = this.downloadAndStore(assetId, target);
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
   */
  async storeKnownBytes(assetId: number, bytes: Uint8Array): Promise<vscode.Uri> {
    if (!Number.isInteger(assetId) || assetId <= 0) {
      throw new Error(`Invalid asset id: ${assetId}`);
    }
    await this.ensureRoot();
    const target = this.pathFor(assetId);
    await fsp.writeFile(target.fsPath, bytes);
    return target;
  }

  /**
   * Wipe the entire cache. Wired to logout / project switch — the
   * cached binaries are tied to the authenticated identity.
   */
  async clearAll(): Promise<void> {
    try {
      await fsp.rm(this.cacheRoot.fsPath, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  private pathFor(assetId: number): vscode.Uri {
    // assetId is a server-issued positive integer; safe to use directly.
    return vscode.Uri.joinPath(this.cacheRoot, String(assetId));
  }

  private async ensureRoot(): Promise<void> {
    await fsp.mkdir(this.cacheRoot.fsPath, { recursive: true });
  }

  private async downloadAndStore(assetId: number, target: vscode.Uri): Promise<vscode.Uri> {
    await this.ensureRoot();
    const bytes = await this.client.downloadAsset(assetId);
    // Atomic-ish write: stage under .partial and rename so a partial
    // write doesn't leave a half-file on disk that a concurrent reader
    // would mistake for a complete cache hit.
    const partial = vscode.Uri.joinPath(this.cacheRoot, `${assetId}.partial`);
    await fsp.writeFile(partial.fsPath, bytes);
    await fsp.rename(partial.fsPath, target.fsPath);
    return target;
  }
}
