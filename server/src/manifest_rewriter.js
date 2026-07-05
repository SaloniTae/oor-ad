/**
 * HLS (.m3u8) manifest rewriter.
 *
 * Signs every URI in the playlist with the SAME sessionId. The rewriter is
 * the ONE piece of code that is format-aware — every other component sees
 * URLs as opaque strings. Even here, "aware" means "recognise which lines
 * in a text file are URLs" — the signing itself is untouched.
 *
 * Handles both master playlists (VARIANT URIs) and media playlists (segment
 * URIs, plus EXT-X-KEY URI="..." and EXT-X-MAP URI="..." attributes).
 *
 * DASH: because MPD is XML we return raw manifest text and let the app
 * proxy layer decide whether to sign segment templates or fall back to
 * edge token-auth. Bunny/nginx origins do NOT go through this rewriter —
 * they enforce at their own edge (Part 4c of spec).
 */
const { signUrl } = require('./sign');

/** Resolve URI against a base URL; leave absolute URIs untouched. */
function resolveUri(uri, baseUrl) {
  try { return new URL(uri, baseUrl).toString(); }
  catch { return uri; }
}

/**
 * Rewrite a media/master HLS playlist so every referenced URI (variant,
 * segment, key, map) carries our HMAC signature.
 *
 * @param {string} manifestText   Raw playlist body.
 * @param {string} baseUrl        Absolute URL of the manifest (used to resolve
 *                                 relative URIs). If callers want to keep
 *                                 relative URIs, they may pass '' — but then
 *                                 signing runs on the raw string.
 * @param {string} sessionId      Session id to bind every URI to.
 * @param {string} hmacSecret     Server-side HMAC secret.
 * @param {number} segmentTtl     TTL for segment URIs (spec: 60-90s).
 */
function rewriteHlsManifest(manifestText, baseUrl, sessionId, hmacSecret, segmentTtl = 60) {
  if (typeof manifestText !== 'string') throw new TypeError('rewriteHlsManifest: manifestText required');
  const lines = manifestText.split(/\r?\n/);
  const out = new Array(lines.length);

  const attrRegex = /URI="([^"]+)"/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) { out[i] = line; continue; }

    if (line.startsWith('#')) {
      // Sign URI="..." attributes inside tag lines (EXT-X-KEY, EXT-X-MAP,
      // EXT-X-SESSION-KEY, EXT-X-MEDIA, ...).
      if (line.includes('URI="')) {
        out[i] = line.replace(attrRegex, (_m, uri) => {
          const absolute = baseUrl ? resolveUri(uri, baseUrl) : uri;
          return `URI="${signUrl(absolute, sessionId, hmacSecret, segmentTtl)}"`;
        });
      } else {
        out[i] = line;
      }
      continue;
    }

    // Plain URI line (variant or segment).
    const absolute = baseUrl ? resolveUri(line.trim(), baseUrl) : line.trim();
    out[i] = signUrl(absolute, sessionId, hmacSecret, segmentTtl);
  }

  return out.join('\n');
}

module.exports = { rewriteHlsManifest, resolveUri };
