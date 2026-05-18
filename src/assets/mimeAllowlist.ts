/**
 * MIME allowlist for chat attachments (#1670).
 *
 * The axiomcloud `/assets/upload` endpoint itself is permissive — it
 * accepts any content_type in the multipart header (defaults to
 * `application/octet-stream`). This file is the EXTENSION-SIDE policy:
 * which MIMEs we allow the user to drop / paste / pick. Defense in
 * depth on top of axiomcloud's 32MB-per-file cap.
 *
 * Generous on purpose — the postmortem doc explicitly asks for
 * "support every document type" (images, PDFs, Office, code, archives,
 * text). The categorization here also drives how MessageBubble renders
 * the attachment chip (image → inline `<img>`, anything else → file
 * card with the right icon).
 */

/**
 * Categories drive rendering. Adding a category here means MessageBubble
 * picks up a new icon + open-action policy (see chatTokens.tsx).
 */
export type AttachmentCategory =
  | 'image'
  | 'pdf'
  | 'archive'
  | 'document'  // Office formats (docx, xlsx, pptx, etc.)
  | 'text'      // Plain text / source code / JSON / YAML / Markdown
  | 'audio'
  | 'video'
  | 'other';    // On the allowlist but doesn't match a richer category

interface AllowEntry {
  /** Regex that matches the MIME string. */
  pattern: RegExp;
  category: AttachmentCategory;
}

/**
 * Ordered by category specificity. First match wins, so place narrower
 * patterns before broader ones (e.g. `application/json` before `text/*`).
 */
const ALLOW_TABLE: AllowEntry[] = [
  // Images
  { pattern: /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|tiff?|avif|heic|heif)$/i, category: 'image' },
  // PDFs
  { pattern: /^application\/pdf$/i, category: 'pdf' },
  // Office documents (modern + legacy)
  { pattern: /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/i, category: 'document' },
  { pattern: /^application\/msword$/i, category: 'document' },
  { pattern: /^application\/vnd\.ms-(word|excel|powerpoint)$/i, category: 'document' },
  { pattern: /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)$/i, category: 'document' },
  { pattern: /^application\/rtf$/i, category: 'document' },
  // Structured text — narrower than text/*
  { pattern: /^application\/(json|xml|x-yaml|yaml|toml)$/i, category: 'text' },
  // Archives
  { pattern: /^application\/(zip|x-tar|gzip|x-gzip|x-7z-compressed|x-rar-compressed|x-bzip2)$/i, category: 'archive' },
  // Any other text type — markdown, plain, csv, source code, html, css, etc.
  { pattern: /^text\/.+$/i, category: 'text' },
  // Audio + video — relatively safe to embed; we don't actually inline
  // them in chat (file card only), but the upload is allowed.
  { pattern: /^audio\/(mpeg|mp3|wav|x-wav|m4a|mp4|ogg|webm|flac)$/i, category: 'audio' },
  { pattern: /^video\/(mp4|webm|x-matroska|quicktime|ogg)$/i, category: 'video' },
];

/** Size cap mirrors axiomcloud's ParseMultipartForm: 32MB. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/**
 * Resolve a MIME string to its rendering category. Returns `undefined`
 * for MIMEs not on the allowlist. Case-insensitive — some clients
 * uppercase the type field.
 */
export function categorize(mime: string): AttachmentCategory | undefined {
  if (!mime) { return undefined; }
  for (const entry of ALLOW_TABLE) {
    if (entry.pattern.test(mime)) { return entry.category; }
  }
  return undefined;
}

export function isAllowedMime(mime: string): boolean {
  return categorize(mime) !== undefined;
}

/**
 * Magic-byte sniffer. Returns the canonical MIME based on file content
 * when the first few bytes match a known signature; `undefined` when
 * no signature matches (caller decides whether to fall back to the
 * declared MIME).
 *
 * This is defense-in-depth: a webview could send `{ mimeType: 'image/png' }`
 * for a `.exe` payload to bypass the rendering branch. We re-sniff
 * the actual bytes host-side and reject mismatches. Office formats
 * (docx/xlsx/pptx) all sniff as ZIP because that's what they are —
 * for those we trust the declared MIME (see `verifyDeclaredMime`).
 */
export function sniffMagicBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) { return undefined; }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
    && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38 (37|39) 61  → "GIF87a" / "GIF89a"
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  // WEBP: RIFF????WEBP
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  // PDF: %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  // ZIP local file header: 50 4B 03 04 (used by docx/xlsx/pptx too)
  if (bytes[0] === 0x50 && bytes[1] === 0x4B && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return 'application/zip';
  }
  // GZIP: 1F 8B
  if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
    return 'application/gzip';
  }
  // Bzip2: BZh
  if (bytes[0] === 0x42 && bytes[1] === 0x5A && bytes[2] === 0x68) {
    return 'application/x-bzip2';
  }
  // 7z: 37 7A BC AF 27 1C
  if (bytes.length >= 6
    && bytes[0] === 0x37 && bytes[1] === 0x7A && bytes[2] === 0xBC && bytes[3] === 0xAF
    && bytes[4] === 0x27 && bytes[5] === 0x1C) {
    return 'application/x-7z-compressed';
  }
  // RAR: 52 61 72 21 1A 07 (00|01)
  if (bytes.length >= 7
    && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21
    && bytes[4] === 0x1A && bytes[5] === 0x07) {
    return 'application/x-rar-compressed';
  }
  // ---- Executables (NOT on the allowlist) ----
  // PE (Windows .exe/.dll): MZ — 4D 5A
  if (bytes[0] === 0x4D && bytes[1] === 0x5A) {
    return 'application/x-executable';
  }
  // ELF (Linux): 7F 45 4C 46
  if (bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46) {
    return 'application/x-executable';
  }
  // Mach-O (macOS): CE FA ED FE / CF FA ED FE (LE) or FE ED FA CE / FE ED FA CF (BE)
  if ((bytes[0] === 0xCE || bytes[0] === 0xCF) && bytes[1] === 0xFA && bytes[2] === 0xED && bytes[3] === 0xFE) {
    return 'application/x-executable';
  }
  if (bytes[0] === 0xFE && bytes[1] === 0xED && bytes[2] === 0xFA && (bytes[3] === 0xCE || bytes[3] === 0xCF)) {
    return 'application/x-executable';
  }
  // Java class file: CA FE BA BE
  if (bytes[0] === 0xCA && bytes[1] === 0xFE && bytes[2] === 0xBA && bytes[3] === 0xBE) {
    return 'application/x-executable';
  }
  // No binary signature matched — caller's policy applies.
  return undefined;
}

/**
 * Verify a declared MIME against the actual bytes. Defense-in-depth
 * for the "exe declared as image/png" attack — a compromised webview
 * could send a malicious payload claiming a safe MIME.
 *
 * Policy:
 *  - sniff returns `application/x-executable` → REJECT unconditionally
 *    (we don't allow executables on the allowlist regardless of what
 *    declared says).
 *  - sniff exactly matches declared → accept.
 *  - sniff is `application/zip` and declared is one of the legit
 *    zip-container formats (OOXML, OpenDocument, EPUB, JAR) → accept.
 *  - sniff is undefined → accept whatever was declared (most formats
 *    in our allowlist — RTF, TIFF, BMP, AVIF, MP3, MP4, etc. — have no
 *    cheap magic-byte signature in this module yet, but `isAllowedMime`
 *    has already gated upstream so they're not a free-for-all). The
 *    only way to weaponize this branch would require an attacker to
 *    forge an executable that doesn't trip the explicit exe sniffs
 *    above — meaningfully harder than the "no sniff at all" baseline.
 *  - sniff says one type but declared says another → REJECT (the
 *    canonical anti-spoof case).
 */
export function verifyDeclaredMime(bytes: Uint8Array, declared: string): boolean {
  const declaredLc = declared.toLowerCase();
  const sniffed = sniffMagicBytes(bytes);

  if (sniffed === 'application/x-executable') { return false; }

  if (sniffed) {
    if (sniffed === declaredLc) { return true; }
    if (sniffed === 'application/zip') {
      return /openxmlformats-officedocument|opendocument|epub\+zip|java-archive|x-android-package|vnd\.android\.package-archive/.test(declaredLc);
    }
    return false;
  }

  // No magic match — trust the upstream `isAllowedMime` filter.
  return true;
}
