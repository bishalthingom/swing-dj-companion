// ── State ─────────────────────────────────────────────────────────────────────

let accessToken     = null;
let tokenExpiry     = null;
let spotifyPlayer   = null;
let sdkDeviceId     = null;
let progressTimer   = null;
let pollInterval    = null;
let userDisplayName = null;
let djTracks        = [];       // mirror of saved library (for BPM lookup)

// Polling sync state
let pollSyncPos  = 0;           // last known position from API (ms)
let pollSyncAt   = 0;           // Date.now() when we got pollSyncPos
let pollDuration = 0;

// Playback state
let lastTrackId = null;
let lastPaused  = true;
let playbackCommandPending = false;
let lastPlaybackCommandTime = 0;
let playTrackPending = false;
let lastPlayTrackTime = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(secs) {
  if (!secs) return '--:--';
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function fmtMs(ms) {
  return fmtDuration(Math.floor((ms || 0) / 1000));
}

function fmtMsRemaining(posMs, durMs) {
  if (!durMs) return '';
  const rem = Math.max(0, durMs - posMs);
  return `-${fmtMs(rem)}`;
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
  if (msg && type !== 'error') {
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3500);
  }
}

function extractSpotifyUri(text) {
  if (!text) return null;
  text = text.trim();
  if (/^spotify:track:[A-Za-z0-9]+$/.test(text)) return text;
  const m = text.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  if (m) return `spotify:track:${m[1]}`;
  return null;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Helper to determine if an error is transient/non-critical
function isTransientError(msg) {
  if (!msg) return false;
  const lowerMsg = msg.toLowerCase();
  return (
    lowerMsg.includes('not valid json') ||
    lowerMsg.includes('restriction violated') ||
    lowerMsg.includes('failed to parse') ||
    lowerMsg.includes('unexpected') && lowerMsg.includes('json') ||
    lowerMsg.includes('empty response')
  );
}

// Only show user-facing error messages for critical issues
function setStatusError(msg, forceShow = false) {
  if (isTransientError(msg) && !forceShow) {
    console.warn('Transient error (logged only):', msg);
    return;
  }
  setStatus(msg, 'error');
}

// ── Spotify API helpers ───────────────────────────────────────────────────────

async function getValidToken() {
  if (accessToken && tokenExpiry && tokenExpiry - Date.now() > 3 * 60 * 1000) return accessToken;
  const result = await window.api.refreshToken();
  if (result.accessToken) {
    accessToken = result.accessToken;
    tokenExpiry = result.tokenExpiry;
    return accessToken;
  }
  return null;
}

async function spotifyFetch(path, opts = {}) {
  const token = await getValidToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`https://api.spotify.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 204 || res.status === 202) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Spotify error ${res.status}`);
  return data;
}

async function getMe()                  { return spotifyFetch('/v1/me'); }
async function getDevices()             { const d = await spotifyFetch('/v1/me/player/devices'); return d?.devices || []; }
async function getSavedTracks(offset=0) { return spotifyFetch(`/v1/me/tracks?limit=50&offset=${offset}`); }
async function searchTracks(q)          { return spotifyFetch(`/v1/search?q=${encodeURIComponent(q)}&type=track&limit=30`); }

// ── Polling ───────────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollPlaybackState();                              // immediate first hit
  pollInterval = setInterval(pollPlaybackState, 2500);
}

function stopPolling() {
  clearInterval(pollInterval);
  clearInterval(progressTimer);
  pollInterval = null;
  progressTimer = null;
}

async function pollPlaybackState() {
  try {
    const state = await spotifyFetch('/v1/me/player');
    if (!state || !state.item) {
      // Nothing playing — leave bar as-is but stop progress animation
      clearInterval(progressTimer);
      return;
    }

    const track     = state.item;
    const isPlaying = state.is_playing;
    const posMs     = state.progress_ms || 0;
    const durMs     = track.duration_ms || 0;

    // Sync point for smooth interpolation
    pollSyncPos  = posMs;
    pollSyncAt   = Date.now();
    pollDuration = durMs;
    lastTrackId  = track.id;
    lastPaused   = !isPlaying;

    // Update card highlights
    document.querySelectorAll('.track-card').forEach(card => {
      card.classList.toggle('playing', card.dataset.id === track.id);
      const btn = card.querySelector('.play-btn');
      if (btn) btn.textContent = (isPlaying && card.dataset.id === track.id) ? '⏸' : '▶';
    });

    // Look up BPM from DJ library
    const libTrack = djTracks.find(t => t.id === track.id);
    const bpm      = libTrack?.bpm ?? null;

    updateBarNowPlaying(track, isPlaying, posMs, durMs, bpm);

    // Smooth progress between polls
    clearInterval(progressTimer);
    if (isPlaying) {
      progressTimer = setInterval(() => {
        const pos = pollSyncPos + (Date.now() - pollSyncAt);
        if (pos <= pollDuration) {
          updateProgressEl(pos, pollDuration);
        } else {
          clearInterval(progressTimer);
        }
      }, 250);
    }
  } catch (err) {
    if (!err.message.includes('Not authenticated')) {
      console.warn('Poll error:', err.message);
    }
  }
}

// ── Playback ──────────────────────────────────────────────────────────────────

async function getPlaybackDeviceId() {
  if (sdkDeviceId) return sdkDeviceId;
  try {
    const devices = await getDevices();
    const active  = devices.find(d => d.is_active) || devices[0];
    if (active) return active.id;
  } catch (e) { console.error('getDevices failed', e); }
  return null;
}

async function playTrack(trackId) {
  // Prevent rapid successive commands
  if (playTrackPending) return;
  const now = Date.now();
  if (now - lastPlayTrackTime < 500) return;

  playTrackPending = true;
  lastPlayTrackTime = now;
  
  const deviceId = await getPlaybackDeviceId();
  if (!deviceId) {
    setStatus('No active Spotify device found. Open the Spotify app first.', 'error');
    playTrackPending = false;
    return;
  }
  
  // Trigger poll immediately for responsive UI, then make request
  setTimeout(pollPlaybackState, 100);
  
  try {
    await spotifyFetch(`/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
    });
  } catch (err) {
    setStatusError(err.message || 'Playback failed');
  } finally {
    playTrackPending = false;
  }
}

async function togglePlayPause() {
  // Prevent rapid successive commands (Spotify throttles these)
  if (playbackCommandPending) return;
  const now = Date.now();
  if (now - lastPlaybackCommandTime < 500) return;  // Minimum 500ms between commands

  playbackCommandPending = true;
  const ppBtn = document.getElementById('playPauseBtn');
  const prevPaused = lastPaused;
  
  // Determine action BEFORE updating UI
  const shouldPlay = prevPaused;  // If currently paused, we want to play
  
  // Update UI optimistically, immediately
  lastPaused = !lastPaused;
  if (ppBtn) ppBtn.textContent = lastPaused ? '▶' : '⏸';
  if (lastPaused) clearInterval(progressTimer);

  try {
    if (spotifyPlayer && sdkDeviceId) {
      spotifyPlayer.togglePlay();
    } else {
      if (shouldPlay) {
        await spotifyFetch('/v1/me/player/play', { method: 'PUT' });
      } else {
        await spotifyFetch('/v1/me/player/pause', { method: 'PUT' });
      }
    }
    lastPlaybackCommandTime = now;
  } catch (err) {
    // Revert on error
    lastPaused = prevPaused;
    if (ppBtn) ppBtn.textContent = lastPaused ? '▶' : '⏸';
    setStatusError(err.message || 'Playback failed');
  } finally {
    playbackCommandPending = false;
  }
}

// ── SDK ───────────────────────────────────────────────────────────────────────

function initPlayer(token) {
  accessToken = token;
  const setup = () => {
    if (spotifyPlayer) { spotifyPlayer.disconnect(); spotifyPlayer = null; }
    spotifyPlayer = new window.Spotify.Player({
      name: 'Swing DJ Companion',
      getOAuthToken: async cb => { const t = await getValidToken(); if (t) cb(t); },
      volume: 0.8,
    });
    spotifyPlayer.addListener('ready',     ({ device_id }) => { sdkDeviceId = device_id; setStatus('In-app player ready', 'ok'); });
    spotifyPlayer.addListener('not_ready', ()              => { sdkDeviceId = null; });
    spotifyPlayer.addListener('player_state_changed', state => {
      // SDK events complement the poll, don't replace it
      if (state) { lastTrackId = state.track_window?.current_track?.id || null; lastPaused = state.paused; }
    });
    spotifyPlayer.addListener('initialization_error', ({ message }) => console.warn('SDK init:', message));
    spotifyPlayer.addListener('authentication_error', ({ message }) => console.warn('SDK auth:', message));
    spotifyPlayer.addListener('account_error',        ()            => console.warn('SDK: Premium required for in-app audio'));
    spotifyPlayer.connect();
  };
  if (window.Spotify) setup();
  else window.onSpotifyWebPlaybackSDKReady = setup;
}

// ── Playback bar ──────────────────────────────────────────────────────────────

function renderBarLoggedOut() {
  const bar = document.getElementById('playbackBar');
  bar.className = 'playback-bar logged-out';
  bar.innerHTML = `<button class="login-btn" id="loginBtn"><span>♪</span> Login with Spotify</button>`;
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('browseBtn').classList.add('hidden');
}

function renderBarLoggedIn(displayName) {
  const bar = document.getElementById('playbackBar');
  bar.className = 'playback-bar';
  const nameChip = displayName
    ? `<div class="bar-user">♪ ${esc(displayName)}</div>`
    : '';
  bar.innerHTML = `
    <div class="now-playing" id="nowPlaying">
      ${nameChip}
      <div class="now-playing-idle">Press ▶ on a track to start playing</div>
    </div>
    <div class="bar-center" id="barCenter" style="display:none">
      <div class="progress-wrap">
        <div class="progress-times-top">
          <span id="progressCurrent">0:00</span>
          <span id="progressRemaining"></span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progressFill"></div>
        </div>
      </div>
    </div>
    <div class="bar-bpm" id="barBpm"></div>
    <div class="playback-controls">
      <button class="ctrl-btn" id="playPauseBtn" disabled title="Play / Pause">▶</button>
    </div>
    <button class="logout-btn" id="logoutBtn">Logout</button>
  `;
  document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  document.getElementById('browseBtn').classList.remove('hidden');
}

function updateBarNowPlaying(track, isPlaying, posMs, durMs, bpm) {
  const nowPlaying = document.getElementById('nowPlaying');
  const ppBtn      = document.getElementById('playPauseBtn');
  const barCenter  = document.getElementById('barCenter');
  const bpmEl      = document.getElementById('barBpm');
  if (!nowPlaying) return;

  nowPlaying.innerHTML = `
    <div class="now-playing-name">${esc(track.name)}</div>
    <div class="now-playing-artist">${esc(track.artists?.map(a => a.name).join(', ') || '')}</div>
  `;

  if (barCenter) barCenter.style.display = '';
  updateProgressEl(posMs, durMs);

  if (bpmEl)  bpmEl.textContent  = bpm ? `${bpm} BPM` : '';
  if (ppBtn) { ppBtn.disabled = false; ppBtn.textContent = isPlaying ? '⏸' : '▶'; }
}

function updateProgressEl(posMs, durMs) {
  const fill = document.getElementById('progressFill');
  const curr = document.getElementById('progressCurrent');
  const rem  = document.getElementById('progressRemaining');
  if (!fill) return;
  fill.style.width = durMs ? `${Math.min(100, (posMs / durMs) * 100)}%` : '0%';
  if (curr) curr.textContent = fmtMs(posMs);
  if (rem)  rem.textContent  = durMs ? fmtMsRemaining(posMs, durMs) : '';
}

// ── Auth flow ─────────────────────────────────────────────────────────────────

async function handleLogin() {
  setStatus('Opening Spotify login…', 'info');
  const result = await window.api.spotifyOAuth();
  if (result.error) { setStatus(result.error, 'error'); return; }

  setStatus('Logging in…', 'info');
  const tokenResult = await window.api.exchangeCode(result.code);
  if (tokenResult.error) { setStatus(tokenResult.error, 'error'); return; }

  accessToken = tokenResult.accessToken;
  tokenExpiry = tokenResult.tokenExpiry;

  try { const me = await getMe(); userDisplayName = me?.display_name || me?.id || null; }
  catch { userDisplayName = null; }

  setStatus(`Logged in${userDisplayName ? ' as ' + userDisplayName : ''}!`, 'ok');
  renderBarLoggedIn(userDisplayName);
  initPlayer(accessToken);
  startPolling();
}

async function handleLogout() {
  stopPolling();
  if (spotifyPlayer) { spotifyPlayer.disconnect(); spotifyPlayer = null; }
  sdkDeviceId = null; accessToken = null; tokenExpiry = null;
  userDisplayName = null; lastTrackId = null; lastPaused = true;

  document.querySelectorAll('.track-card').forEach(card => {
    card.classList.remove('playing');
    const btn = card.querySelector('.play-btn');
    if (btn) btn.textContent = '▶';
  });

  await window.api.logout();
  renderBarLoggedOut();
}

// ── Library browser ───────────────────────────────────────────────────────────

let browserTab         = 'saved';
let savedTracksOffset  = 0;
let savedTracksTotal   = 0;
let browserSearchTimer = null;
let libraryIds         = new Set();

function setupLibraryBrowser() {
  const overlay   = document.getElementById('browserOverlay');
  const browseBtn = document.getElementById('browseBtn');
  const closeBtn  = document.getElementById('browserCloseBtn');
  const moreBtn   = document.getElementById('browserMoreBtn');
  const searchEl  = document.getElementById('browserSearch');
  const tabs      = document.querySelectorAll('.browser-tab');

  browseBtn.addEventListener('click', async () => {
    const tracks = await window.api.getTracks();
    libraryIds = new Set(tracks.map(t => t.id));
    savedTracksOffset = 0; browserTab = 'saved';
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'saved'));
    searchEl.value = '';
    overlay.classList.remove('hidden');
    loadSavedTracks(true);
  });

  closeBtn.addEventListener('click',  () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      browserTab = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      if (browserTab === 'saved') {
        savedTracksOffset = 0; searchEl.placeholder = 'Filter saved tracks…';
        loadSavedTracks(true);
      } else {
        searchEl.placeholder = 'Search Spotify…';
        setBrowserLoading('Type to search…');
        document.getElementById('browserMoreBtn').classList.add('hidden');
      }
    });
  });

  searchEl.addEventListener('input', () => {
    clearTimeout(browserSearchTimer);
    const q = searchEl.value.trim();
    if (browserTab === 'saved') { loadSavedTracks(true); return; }
    if (!q) { setBrowserLoading('Type to search…'); return; }
    setBrowserLoading('Searching…');
    browserSearchTimer = setTimeout(() => runSearch(q), 350);
  });

  moreBtn.addEventListener('click', () => { if (browserTab === 'saved') loadSavedTracks(false); });
}

function setBrowserLoading(msg = 'Loading…') {
  document.getElementById('browserBody').innerHTML = `<div class="browser-loading">${esc(msg)}</div>`;
  document.getElementById('browserMoreBtn').classList.add('hidden');
}

async function loadSavedTracks(reset) {
  if (reset) { savedTracksOffset = 0; setBrowserLoading(); }
  try {
    const data = await getSavedTracks(savedTracksOffset);
    if (!data) return;
    savedTracksTotal = data.total;
    const filter = document.getElementById('browserSearch').value.trim().toLowerCase();
    const items  = data.items.map(i => i.track).filter(t =>
      !filter || t.name.toLowerCase().includes(filter) || t.artists.some(a => a.name.toLowerCase().includes(filter))
    );
    renderBrowserRows(items, reset);
    savedTracksOffset += data.items.length;
    const moreBtn = document.getElementById('browserMoreBtn');
    if (savedTracksOffset < savedTracksTotal && !filter) {
      moreBtn.classList.remove('hidden');
      moreBtn.textContent = `Load more (${savedTracksTotal - savedTracksOffset} remaining)`;
    } else { moreBtn.classList.add('hidden'); }
  } catch (err) {
    document.getElementById('browserBody').innerHTML =
      `<div class="browser-loading" style="color:#e57373">${esc(err.message)}</div>`;
  }
}

async function runSearch(query) {
  try {
    const data   = await searchTracks(query);
    const tracks = data?.tracks?.items || [];
    renderBrowserRows(tracks, true);
    document.getElementById('browserMoreBtn').classList.add('hidden');
  } catch (err) {
    document.getElementById('browserBody').innerHTML =
      `<div class="browser-loading" style="color:#e57373">${esc(err.message)}</div>`;
  }
}

function renderBrowserRows(tracks, reset) {
  const body = document.getElementById('browserBody');
  if (reset) body.innerHTML = '';
  if (!tracks.length && reset) { body.innerHTML = '<div class="browser-loading">No results</div>'; return; }
  tracks.forEach(track => {
    const added = libraryIds.has(track.id);
    const row   = document.createElement('div');
    row.className = 'browser-row';
    row.innerHTML = `
      <div class="browser-row-info">
        <div class="browser-row-name">${esc(track.name)}</div>
        <div class="browser-row-meta">${esc(track.artists.map(a => a.name).join(', '))} · ${esc(track.album.name)}</div>
      </div>
      <div class="browser-row-dur">${fmtDuration(Math.round(track.duration_ms / 1000))}</div>
      <button class="browser-add-btn${added ? ' added' : ''}">${added ? '✓ Added' : '+ Add'}</button>
    `;
    const addBtn = row.querySelector('.browser-add-btn');
    if (!added) {
      addBtn.addEventListener('click', async () => {
        addBtn.textContent = '…'; addBtn.disabled = true;
        const result = await window.api.saveTrack(`spotify:track:${track.id}`);
        if (result.error) {
          addBtn.textContent = '+ Add'; addBtn.disabled = false; setStatus(result.error, 'error');
        } else {
          addBtn.textContent = '✓ Added'; addBtn.classList.add('added');
          libraryIds.add(track.id);
          const tracks = await window.api.getTracks();
          renderTracks(tracks);
        }
      });
    }
    body.appendChild(row);
  });
}

// ── Track list ────────────────────────────────────────────────────────────────

function renderTracks(tracks) {
  djTracks = tracks; // keep in sync for BPM lookup during playback

  const list  = document.getElementById('trackList');
  const empty = document.getElementById('emptyState');
  const count = document.getElementById('trackCount');

  count.textContent = tracks.length ? `${tracks.length} track${tracks.length !== 1 ? 's' : ''}` : '';

  if (!tracks.length) { list.innerHTML = ''; list.appendChild(empty); return; }
  empty.remove(); list.innerHTML = '';

  [...tracks].reverse().forEach(track => {
    const card = document.createElement('div');
    card.className = 'track-card' + (track.id === lastTrackId ? ' playing' : '');
    card.dataset.id = track.id;

    card.innerHTML = `
      <button class="play-btn" title="Play">${(track.id === lastTrackId && !lastPaused) ? '⏸' : '▶'}</button>
      <div class="track-main">
        <div class="track-name">${esc(track.name)}</div>
        <div class="track-meta">${esc(track.artist)}<span class="album"> · ${esc(track.album)}</span></div>
      </div>
      <div class="track-badges">
        <span class="badge badge-bpm" title="Click to edit BPM">${track.bpm ? `${track.bpm} BPM` : '— BPM'}</span>
        <span class="badge badge-duration">${fmtDuration(track.duration)}</span>
      </div>
      <div class="track-notes-row">
        <textarea class="track-notes" rows="1" placeholder="Add a note…">${esc(track.notes || '')}</textarea>
      </div>
      <div class="track-actions">
        <button class="btn-icon delete-btn">✕ Remove</button>
      </div>
    `;

    card.querySelector('.play-btn').addEventListener('click', async () => {
      const isThisPlaying = lastTrackId === track.id && !lastPaused;
      if (isThisPlaying) await togglePlayPause();
      else               await playTrack(track.id);
    });

    card.querySelector('.badge-bpm').addEventListener('click', () => startBpmEdit(card, track));

    const notesEl = card.querySelector('.track-notes');
    notesEl.addEventListener('input', autoResizeTextarea);
    notesEl.addEventListener('blur', async () => {
      if (notesEl.value !== (track.notes || '')) {
        track.notes = notesEl.value;
        await window.api.updateTrack(track.id, 'notes', notesEl.value);
      }
    });
    autoResizeTextarea.call(notesEl);

    card.querySelector('.delete-btn').addEventListener('click', async () => {
      card.style.opacity = '0.4';
      await window.api.deleteTrack(track.id);
      djTracks = djTracks.filter(t => t.id !== track.id);
      card.remove();
      const remaining = document.querySelectorAll('.track-card').length;
      document.getElementById('trackCount').textContent =
        remaining ? `${remaining} track${remaining !== 1 ? 's' : ''}` : '';
      if (!remaining) document.getElementById('trackList').appendChild(document.getElementById('emptyState'));
    });

    list.appendChild(card);
  });
}

function startBpmEdit(card, track) {
  const badge = card.querySelector('.badge-bpm');
  const input = document.createElement('input');
  input.type = 'number'; input.className = 'bpm-edit-input';
  input.value = track.bpm || ''; input.placeholder = 'BPM';
  badge.replaceWith(input); input.focus(); input.select();

  const commit = async () => {
    const val    = parseInt(input.value, 10);
    const newBpm = isNaN(val) || val <= 0 ? null : val;
    track.bpm = newBpm;
    // update djTracks so bar BPM reflects edits live
    const lt = djTracks.find(t => t.id === track.id);
    if (lt) lt.bpm = newBpm;
    await window.api.updateTrack(track.id, 'bpm', newBpm);
    const newBadge = document.createElement('span');
    newBadge.className = 'badge badge-bpm'; newBadge.title = 'Click to edit BPM';
    newBadge.textContent = newBpm ? `${newBpm} BPM` : '— BPM';
    newBadge.addEventListener('click', () => startBpmEdit(card, track));
    input.replaceWith(newBadge);
    // Immediately reflect in bar if this track is playing
    if (lastTrackId === track.id) {
      const bpmEl = document.getElementById('barBpm');
      if (bpmEl) bpmEl.textContent = newBpm ? `${newBpm} BPM` : '';
    }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = track.bpm || ''; input.blur(); }
  });
}

function autoResizeTextarea() {
  this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px';
}

// ── Drop & paste ──────────────────────────────────────────────────────────────

function setupDrop() {
  const zone       = document.getElementById('dropZone');
  const activate   = e => { e.preventDefault(); zone.classList.add('active'); };
  const deactivate = () => zone.classList.remove('active');

  document.addEventListener('dragenter', activate);
  document.addEventListener('dragover',  activate);
  document.addEventListener('dragleave', e => {
    if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) deactivate();
  });
  document.addEventListener('drop', async e => {
    e.preventDefault(); deactivate();
    const candidates = [];
    const plain = e.dataTransfer.getData('text/plain');
    if (plain) candidates.push(plain);
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) uriList.split('\n').forEach(u => candidates.push(u.trim()));
    for (const item of e.dataTransfer.items) {
      if (item.kind === 'string') {
        await new Promise(res => item.getAsString(s => { candidates.push(s); res(); }));
      }
    }
    const uri = candidates.map(extractSpotifyUri).find(Boolean);
    if (!uri) { setStatus("That doesn't look like a Spotify track. Try dragging from the Spotify app.", 'error'); return; }
    await handleTrackUri(uri);
  });
  document.addEventListener('paste', async e => {
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    const uri  = extractSpotifyUri(text);
    if (uri) { e.preventDefault(); await handleTrackUri(uri); }
  });
}

async function handleTrackUri(uri) {
  setStatus('Looking up track…', 'info');
  const result = await window.api.saveTrack(uri);
  if (result.duplicate) { setStatus('Track already in library.', ''); return; }
  if (result.error)     { setStatus(result.error, 'error'); return; }
  setStatus(`Added: ${result.track.name} — ${result.track.artist}`, 'ok');
  const tracks = await window.api.getTracks();
  renderTracks(tracks);
}

// ── Settings modal ────────────────────────────────────────────────────────────

function setupSettings() {
  const overlay   = document.getElementById('settingsOverlay');
  const openBtn   = document.getElementById('settingsBtn');
  const cancelBtn = document.getElementById('cancelSettingsBtn');
  const saveBtn   = document.getElementById('saveSettingsBtn');
  const devLink   = document.getElementById('spotifyDevLink');

  openBtn.addEventListener('click', async () => {
    const creds = await window.api.getCredentials();
    document.getElementById('clientIdInput').value     = creds.clientId || '';
    document.getElementById('clientSecretInput').value = creds.clientSecret || '';
    overlay.classList.remove('hidden');
  });
  cancelBtn.addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  saveBtn.addEventListener('click', async () => {
    const clientId     = document.getElementById('clientIdInput').value.trim();
    const clientSecret = document.getElementById('clientSecretInput').value.trim();
    if (!clientId || !clientSecret) { setStatus('Both fields are required.', 'error'); overlay.classList.add('hidden'); return; }
    await window.api.saveCredentials({ clientId, clientSecret });
    setStatus('Credentials saved.', 'ok');
    overlay.classList.add('hidden');
  });
  devLink.addEventListener('click', e => { e.preventDefault(); window.api.openExternal('https://developer.spotify.com/dashboard'); });
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  setupDrop();
  setupSettings();
  setupLibraryBrowser();

  const tracks = await window.api.getTracks();
  renderTracks(tracks);

  const auth = await window.api.getAuth();
  if (auth.hasRefreshToken) {
    const result = await window.api.refreshToken();
    if (result.accessToken) {
      accessToken = result.accessToken;
      tokenExpiry = result.tokenExpiry;
      try { const me = await getMe(); userDisplayName = me?.display_name || me?.id || null; } catch { /* ignore */ }
      renderBarLoggedIn(userDisplayName);
      initPlayer(accessToken);
      startPolling();
      return;
    }
  }

  renderBarLoggedOut();
  const creds = await window.api.getCredentials();
  if (!creds.clientId) setStatus('Open ⚙ Settings to add your Spotify API credentials first.', 'info');
})();
