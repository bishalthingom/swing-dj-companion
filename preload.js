const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Track library
  getTracks:       ()                        => ipcRenderer.invoke('get-tracks'),
  saveTrack:       (uri)                     => ipcRenderer.invoke('save-track', uri),
  deleteTrack:     (id)                      => ipcRenderer.invoke('delete-track', id),
  updateTrack:     (trackId, field, value)   => ipcRenderer.invoke('update-track', { trackId, field, value }),

  // Spotify app credentials (Client ID / Secret)
  getCredentials:  ()                        => ipcRenderer.invoke('get-credentials'),
  saveCredentials: (creds)                   => ipcRenderer.invoke('save-credentials', creds),

  // OAuth / user auth (for playback)
  spotifyOAuth:    ()                        => ipcRenderer.invoke('spotify-oauth'),
  exchangeCode:    (code)                    => ipcRenderer.invoke('exchange-code', code),
  refreshToken:    ()                        => ipcRenderer.invoke('refresh-token'),
  getAuth:         ()                        => ipcRenderer.invoke('get-auth'),
  logout:          ()                        => ipcRenderer.invoke('logout'),

  // Misc
  openExternal:    (url)                     => ipcRenderer.invoke('open-external', url),
});
