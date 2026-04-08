const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  checkFfmpeg:    ()      => ipcRenderer.invoke('check-ffmpeg'),
  openFile:       (f)     => ipcRenderer.invoke('open-file', f),
  saveFile:       (d)     => ipcRenderer.invoke('save-file', d),
  probeFile:      (p)     => ipcRenderer.invoke('probe-file', p),
  extractSubs:    (o)     => ipcRenderer.invoke('extract-subs', o),
  readSubFile:    (p)     => ipcRenderer.invoke('read-sub-file', p),
  writeTempAss:   (c)     => ipcRenderer.invoke('write-temp-ass', c),
  deleteFile:     (p)     => ipcRenderer.invoke('delete-file', p),
  showInFolder:   (p)     => ipcRenderer.invoke('show-in-folder', p),
  getStreamUrl:   (p)     => ipcRenderer.invoke('get-stream-url', p),
  cancelBurn:     ()      => ipcRenderer.invoke('cancel-burn'),
  burn:           (o)     => ipcRenderer.invoke('burn', o),
  getDebugLog:    ()      => ipcRenderer.invoke('get-debug-log'),
  onBurnProgress: (cb)    => {
    ipcRenderer.on('burn-progress', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('burn-progress')
  },
  onDebugLog: (cb) => {
    ipcRenderer.on('debug-log', (_, line) => cb(line))
    return () => ipcRenderer.removeAllListeners('debug-log')
  }
})
