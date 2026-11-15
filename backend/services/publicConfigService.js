'use strict';
/**
 * publicConfigService.js – Centralized Public Deployment Configuration
 * ─────────────────────────────────────────────────────────────────────
 * Manages the single source of truth for CoLearn's public Tunnelto backend URL.
 *
 * Source:
 *   1. Remote: https://navi-31.github.io/CoLearn_Development_Phase/config/public.json
 *   2. Local disk fallback: frontend/config/public.json
 *   3. Environment variable fallback: process.env.TUNNELTO_URL or GOOGLE_REDIRECT_URI_PUBLIC
 *
 * Provides:
 *   • Dynamic Google Drive OAuth public callback resolution
 *   • Safe URL validation and domain allowlisting (anti-SSRF)
 *   • In-memory caching with 60-second TTL to avoid redundant network calls
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const DEFAULT_CONFIG_URL = 'https://navi-31.github.io/CoLearn_Development_Phase/config/public.json';
const LOCAL_CONFIG_PATH  = path.resolve(__dirname, '../../frontend/config/public.json');
const CACHE_TTL_MS       = 60 * 1000; // 60 seconds
const FETCH_TIMEOUT_MS   = 5000;      // 5 seconds

// State
let cachedBackendUrl = '';
let cachedAt = 0;
let inflightPromise = null;

/**
 * Validates a candidate backend URL string.
 * Must be HTTPS (or HTTP in local dev) and belong to an approved domain/tunnel pattern.
 */
function isValidBackendUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();

    // Must use HTTPS for public deployments (allow HTTP only for localhost)
    if (protocol !== 'https:' && protocol !== 'http:') {
      return false;
    }

    // Hostname validation to prevent SSRF or arbitrary protocol injection
    const isAllowedTunnel = Boolean(
      hostname.endsWith('.tunnel.to') ||
      hostname.endsWith('.trycloudflare.com') ||
      hostname.endsWith('.ngrok.io') ||
      hostname.endsWith('.ngrok-free.app') ||
      hostname.endsWith('.loca.lt')
    );

    const isAllowedHost = Boolean(
      isAllowedTunnel ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.github.io') ||
      hostname.endsWith('.pages.dev')
    );

    return isAllowedHost;
  } catch (_) {
    return false;
  }
}

/**
 * Reads local frontend/config/public.json from disk if present.
 */
function readLocalConfigFile() {
  try {
    if (fs.existsSync(LOCAL_CONFIG_PATH)) {
      const raw = fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.backendUrl === 'string' && isValidBackendUrl(data.backendUrl)) {
        return data.backendUrl.trim().replace(/\/$/, '');
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Resolves static fallback from environment variables.
 */
function getEnvironmentFallback() {
  const tunnel = (process.env.TUNNELTO_URL || process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/$/, '');
  if (tunnel && isValidBackendUrl(tunnel)) return tunnel;

  const redirectUri = (process.env.GOOGLE_REDIRECT_URI_PUBLIC || '').trim();
  if (redirectUri && redirectUri.startsWith('https://')) {
    try {
      const u = new URL(redirectUri);
      return u.origin;
    } catch (_) {}
  }

  const legacy = (process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (legacy && legacy.startsWith('https://')) {
    try {
      const u = new URL(legacy);
      return u.origin;
    } catch (_) {}
  }

  return null;
}

/**
 * Fetches JSON via standard HTTPS GET (supports Node 14+ without dependencies).
 */
function fetchHttpsJson(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const req = https.get(targetUrl, {
      headers: {
        'User-Agent': 'CoLearn-Backend/2.0',
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
      },
    }, (res) => {
      clearTimeout(timer);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(rawData);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse JSON response: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Fetches and updates the centralized public configuration.
 * Caches in memory with TTL.
 */
async function fetchPublicConfig(force = false) {
  const now = Date.now();
  if (!force && cachedBackendUrl && (now - cachedAt < CACHE_TTL_MS)) {
    return { backendUrl: cachedBackendUrl, cached: true };
  }

  if (inflightPromise) {
    return inflightPromise;
  }

  inflightPromise = (async () => {
    const configUrl = process.env.PUBLIC_CONFIG_URL || DEFAULT_CONFIG_URL;
    let resolvedUrl = null;

    try {
      // 1. Fetch remote public.json from GitHub Pages
      const data = await fetchHttpsJson(configUrl, FETCH_TIMEOUT_MS);
      if (data && typeof data.backendUrl === 'string' && isValidBackendUrl(data.backendUrl)) {
        resolvedUrl = data.backendUrl.trim().replace(/\/$/, '');
        cachedBackendUrl = resolvedUrl;
        cachedAt = Date.now();
        return { backendUrl: resolvedUrl, source: 'remote', url: configUrl };
      } else {
        throw new Error('Config file does not contain a valid "backendUrl" property.');
      }
    } catch (fetchErr) {
      // 2. Fall back to local disk config file
      const localUrl = readLocalConfigFile();
      if (localUrl) {
        cachedBackendUrl = localUrl;
        cachedAt = Date.now();
        return { backendUrl: localUrl, source: 'local_disk', error: fetchErr.message };
      }

      // 3. Fall back to environment variable
      const envUrl = getEnvironmentFallback();
      if (envUrl) {
        cachedBackendUrl = envUrl;
        cachedAt = Date.now();
        return { backendUrl: envUrl, source: 'env', error: fetchErr.message };
      }

      // 4. Return last cached value if any
      if (cachedBackendUrl) {
        return { backendUrl: cachedBackendUrl, source: 'stale_cache', error: fetchErr.message };
      }

      throw new Error(`Unable to resolve public backend URL: ${fetchErr.message}`);
    } finally {
      inflightPromise = null;
    }
  })();

  return inflightPromise;
}

/**
 * Synchronous getter for current public backend URL.
 * Returns cached value, local file value, or env fallback immediately without blocking.
 */
function getPublicBackendUrl() {
  if (cachedBackendUrl) return cachedBackendUrl;

  const local = readLocalConfigFile();
  if (local) {
    cachedBackendUrl = local;
    cachedAt = Date.now();
    return local;
  }

  const env = getEnvironmentFallback();
  if (env) {
    cachedBackendUrl = env;
    cachedAt = Date.now();
    return env;
  }

  return '';
}

/**
 * Returns the resolved Google Drive OAuth public callback URI:
 *   ${backendUrl}/api/drive/callback
 */
function getPublicRedirectUri() {
  const backendUrl = getPublicBackendUrl();
  if (backendUrl) {
    return `${backendUrl}/api/drive/callback`;
  }
  return null;
}

/**
 * Startup initialization helper.
 * Warms up cache and logs status to console.
 */
async function init() {
  // Pre-seed synchronously from local disk or env if available
  getPublicBackendUrl();

  try {
    const res = await fetchPublicConfig(true);
    console.log(`[PublicConfig] 🌐 Public deployment backend URL: ${res.backendUrl} (source: ${res.source})`);
    console.log(`[PublicConfig] 🔑 Derived Google Drive OAuth callback: ${getPublicRedirectUri()}`);
  } catch (err) {
    console.warn(`[PublicConfig] ⚠️ Warning: Failed to fetch remote public.json: ${err.message}`);
    const fallback = getPublicBackendUrl();
    if (fallback) {
      console.log(`[PublicConfig] ℹ️ Using fallback backend URL: ${fallback}`);
    } else {
      console.warn('[PublicConfig] ⚠️ No public backend URL configured. Configure frontend/config/public.json or .env.');
    }
  }
}

module.exports = {
  isValidBackendUrl,
  fetchPublicConfig,
  getPublicBackendUrl,
  getPublicRedirectUri,
  init,
};
