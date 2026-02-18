const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// ── Data helpers ──────────────────────────────────────────────────────────────

function getDataPath() {
  return path.join(app.getPath('userData'), 'tracks.json');
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadTracks() {
  try {
    return JSON.parse(fs.readFileSync(getDataPath(), 'utf8'));
  } catch {
    return [];
  }
}

function saveTracks(tracks) {
  fs.writeFileSync(getDataPath(), JSON.stringify(tracks, null, 2));
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 720,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111111',
    title: 'Swing DJ Companion',
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-tracks', () => loadTracks());

ipcMain.handle('get-credentials', () => {
  const cfg = loadConfig();
  return { clientId: cfg.clientId || '', clientSecret: cfg.clientSecret || '' };
});

ipcMain.handle('save-credentials', (_, { clientId, clientSecret }) => {
  const cfg = loadConfig();
  cfg.clientId = clientId;
  cfg.clientSecret = clientSecret;
  saveConfig(cfg);
  return { success: true };
});

ipcMain.handle('save-track', async (_, rawUri) => {
  const uri = (rawUri || '').trim();

  // Parse track ID from spotify:track:ID or https://open.spotify.com/track/ID
  let trackId = null;
  if (uri.startsWith('spotify:track:')) {
    trackId = uri.split(':')[2];
  } else {
    const m = uri.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
    if (m) trackId = m[1];
  }

  if (!trackId) return { error: 'Not a valid Spotify track link or URI.' };

  // Check for duplicate
  const tracks = loadTracks();
  if (tracks.find(t => t.id === trackId)) {
    return { duplicate: true, trackId };
  }

  const cfg = loadConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    return { error: 'No Spotify credentials saved. Open Settings first.' };
  }

  try {
    const token = await getToken(cfg.clientId, cfg.clientSecret);
    const [trackData, features] = await Promise.all([
      spotifyGet(token, `/v1/tracks/${trackId}`),
      spotifyGet(token, `/v1/audio-features/${trackId}`).catch(() => null),
    ]);

    const track = {
      id: trackId,
      name: trackData.name,
      artist: trackData.artists.map(a => a.name).join(', '),
      album: trackData.album.name,
      duration: Math.round(trackData.duration_ms / 1000),
      bpm: features && features.tempo ? Math.round(features.tempo) : null,
      energy: features ? features.energy : null,
      spotifyUri: `spotify:track:${trackId}`,
      addedAt: new Date().toISOString(),
      notes: '',
    };

    tracks.push(track);
    saveTracks(tracks);
    return { success: true, track };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('delete-track', (_, trackId) => {
  const tracks = loadTracks().filter(t => t.id !== trackId);
  saveTracks(tracks);
  return { success: true };
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('update-track', (_, { trackId, field, value }) => {
  const tracks = loadTracks();
  const t = tracks.find(t => t.id === trackId);
  if (t) {
    t[field] = value;
    saveTracks(tracks);
  }
  return { success: true };
});

// ── OAuth / Auth handlers ─────────────────────────────────────────────────────

const REDIRECT_URI = 'http://127.0.0.1:5173/callback';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-library-read',
].join(' ');

ipcMain.handle('spotify-oauth', () => {
  const cfg = loadConfig();
  if (!cfg.clientId) return { error: 'No Client ID configured. Open Settings first.' };

  const authUrl =
    `https://accounts.spotify.com/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(cfg.clientId)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  return new Promise(resolve => {
    let done = false;

    const win = new BrowserWindow({
      width: 480,
      height: 660,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      title: 'Login to Spotify',
    });

    const capture = (_, url) => {
      if (!url || !url.startsWith(REDIRECT_URI) || done) return;
      done = true;
      try {
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        win.destroy();
        resolve(code ? { code } : { error: error || 'Access denied' });
      } catch (e) {
        resolve({ error: e.message });
      }
    };

    win.webContents.on('will-redirect', capture);
    win.webContents.on('will-navigate', capture);
    win.on('closed', () => { if (!done) { done = true; resolve({ error: 'Login window closed' }); } });
    win.loadURL(authUrl);
  });
});

ipcMain.handle('exchange-code', async (_, code) => {
  const cfg = loadConfig();
  const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const result = await httpsPost({
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (result.access_token) {
    cfg.accessToken = result.access_token;
    cfg.refreshToken = result.refresh_token;
    cfg.tokenExpiry = Date.now() + result.expires_in * 1000;
    saveConfig(cfg);
    return { accessToken: result.access_token, tokenExpiry: cfg.tokenExpiry };
  }
  return { error: result.error_description || 'Token exchange failed' };
});

ipcMain.handle('refresh-token', async () => {
  const cfg = loadConfig();
  if (!cfg.refreshToken) return { error: 'No refresh token stored' };

  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(cfg.refreshToken)}`;
  const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const result = await httpsPost({
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (result.access_token) {
    cfg.accessToken = result.access_token;
    cfg.tokenExpiry = Date.now() + result.expires_in * 1000;
    if (result.refresh_token) cfg.refreshToken = result.refresh_token;
    saveConfig(cfg);
    return { accessToken: result.access_token, tokenExpiry: cfg.tokenExpiry };
  }
  return { error: result.error_description || 'Refresh failed' };
});

ipcMain.handle('get-auth', () => {
  const cfg = loadConfig();
  return {
    accessToken: cfg.accessToken || null,
    tokenExpiry: cfg.tokenExpiry || null,
    hasRefreshToken: !!cfg.refreshToken,
  };
});

ipcMain.handle('logout', () => {
  const cfg = loadConfig();
  delete cfg.accessToken;
  delete cfg.refreshToken;
  delete cfg.tokenExpiry;
  saveConfig(cfg);
  return { success: true };
});

// ── Spotify API helpers ───────────────────────────────────────────────────────

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data || 'No response'}`));
            return;
          }
          // Trim and handle empty/malformed responses
          const trimmed = (data || '').trim();
          if (!trimmed) {
            reject(new Error('Empty response from server'));
            return;
          }
          resolve(JSON.parse(trimmed));
        } catch (e) {
          console.error('JSON parse error. Raw data:', data.substring(0, 100));
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data || 'No response'}`));
            return;
          }
          // Trim and handle empty/malformed responses
          const trimmed = (data || '').trim();
          if (!trimmed) {
            reject(new Error('Empty response from server'));
            return;
          }
          const parsed = JSON.parse(trimmed);
          if (parsed.error) reject(new Error(parsed.error.message || 'Spotify API error'));
          else resolve(parsed);
        } catch (e) {
          console.error('JSON parse error. Raw data:', data.substring(0, 100));
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getToken(clientId, clientSecret) {
  const body = 'grant_type=client_credentials';
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const result = await httpsPost(
    {
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );
  if (!result.access_token) throw new Error(result.error_description || 'Could not get Spotify token');
  return result.access_token;
}

function spotifyGet(token, path) {
  return httpsGet({
    hostname: 'api.spotify.com',
    path,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}
