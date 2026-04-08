const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path   = require('path')
const { spawn } = require('child_process')
const fs     = require('fs')
const os     = require('os')
const http   = require('http')
const net    = require('net')

let streamServer = null
let streamPort   = 0
let currentStreamProc = null
let burnProc = null

function getFreePort() {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}

async function startStreamServer(ffmpegBin) {
  if (streamServer) return streamPort
  streamPort = await getFreePort()
  streamServer = http.createServer((req, res) => {
    const url  = new URL(req.url, 'http://localhost')
    const file = decodeURIComponent(url.searchParams.get('file') || '')
    console.log('[Stream] Request for:', file)
    if (!file || !fs.existsSync(file)) {
      console.error('[Stream] File not found:', file)
      res.writeHead(404); res.end(); return
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
    })
    if (currentStreamProc) { try { currentStreamProc.kill() } catch {} }
    const startTime = parseFloat(url.searchParams.get('t') || '0')
    const ffArgs = [
      ...(startTime > 0 ? ['-ss', String(startTime)] : []),
      '-i', file,
      '-c:v', 'copy',          // copy video (fast)
      '-c:a', 'aac',           // transcode DTS/AC3/EAC3 -> AAC
      '-b:a', '192k',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4', 'pipe:1'
    ]
    console.log('[Stream] FFmpeg args:', ffArgs.join(' '))
    const proc = spawn(ffmpegBin, ffArgs, { stdio: ['ignore','pipe','pipe'] })
    currentStreamProc = proc
    let ffErr = ''
    proc.stderr.on('data', d => { ffErr += d.toString(); })
    proc.stdout.pipe(res)
    proc.on('close', (code) => { if (code !== 0) console.error('[Stream] FFmpeg exited', code, ffErr.slice(-500)) })
    req.on('close', () => { try { proc.kill() } catch {} })
    proc.on('error', (e) => { console.error('[Stream] FFmpeg error:', e); try { res.end() } catch {} })
  })
  streamServer.listen(streamPort, '127.0.0.1')
  return streamPort
}

// ── Audio fix: must be set before app ready ────────────────────────────────
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 740, minWidth: 900, minHeight: 600,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    show: false
  })

  // Allow all media permissions so local video/audio plays
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(true)
  })
  mainWindow.webContents.session.setPermissionCheckHandler(() => true)

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })
}

app.whenReady().then(createWindow)
ipcMain.handle('cancel-burn', () => {
  if (burnProc) { try { burnProc.kill('SIGTERM') } catch {} burnProc = null; return true }
  return false
})

app.on('before-quit', () => {
  if (burnProc)          { try { burnProc.kill('SIGTERM') }          catch {} }
  if (currentStreamProc) { try { currentStreamProc.kill('SIGTERM') } catch {} }
})

app.on('window-all-closed', () => {
  if (burnProc)          { try { burnProc.kill('SIGTERM') }          catch {} }
  if (currentStreamProc) { try { currentStreamProc.kill('SIGTERM') } catch {} }
  if (streamServer) streamServer.close()
  app.quit()
})

// ── Find ffmpeg / ffprobe ──────────────────────────────────────────────────
function findBinary(name) {
  const exeName = process.platform === 'win32' ? name + '.exe' : name
  const which = require('child_process').spawnSync(
    process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }
  )
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split('\n')[0].trim()

  // Common Windows locations
  const extra = [
    'C:\\ffmpeg\\bin\\' + exeName,
    'C:\\Program Files\\ffmpeg\\bin\\' + exeName,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ffmpeg', 'bin', exeName),
    path.join(os.homedir(), 'scoop', 'shims', exeName),
  ]
  for (const c of extra) {
    try { fs.accessSync(c); return c } catch {}
  }
  return null
}

function runProcess(bin, args) {
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    const proc = spawn(bin, args, { stdio: ['ignore','pipe','pipe'] })
    proc.stdout.on('data', d => out += d)
    proc.stderr.on('data', d => err += d)
    proc.on('close', code => code === 0 ? resolve({ stdout:out, stderr:err }) : reject(new Error(err.slice(-2000))))
    proc.on('error', reject)
  })
}

// ── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('check-ffmpeg', async () => {
  const ffmpeg  = findBinary('ffmpeg')
  const ffprobe = findBinary('ffprobe')
  return { ffmpeg, ffprobe, ok: !!(ffmpeg && ffprobe) }
})

ipcMain.handle('open-file', async (_, filters) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties:['openFile'], filters: filters || [] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('save-file', async (_, defaultPath) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: [{ name:'MKV', extensions:['mkv'] }, { name:'MP4', extensions:['mp4'] }]
  })
  return r.canceled ? null : r.filePath
})

ipcMain.handle('probe-file', async (_, filePath) => {
  const fp = findBinary('ffprobe')
  if (!fp) throw new Error('ffprobe not found')
  const { stdout } = await runProcess(fp, ['-v','quiet','-print_format','json','-show_streams','-show_format', filePath])
  return JSON.parse(stdout)
})

ipcMain.handle('extract-subs', async (_, { filePath, trackIndex }) => {
  const ff = findBinary('ffmpeg')
  if (!ff) throw new Error('ffmpeg not found')
  const tmp = path.join(os.tmpdir(), 'sbt_' + Date.now() + '.ass')
  await runProcess(ff, ['-y','-i',filePath,'-map','0:'+trackIndex, tmp])
  const content = fs.readFileSync(tmp, 'utf-8')
  try { fs.unlinkSync(tmp) } catch {}
  return content
})

ipcMain.handle('get-stream-url', async (_, filePath) => {
  const ff = findBinary('ffmpeg')
  if (!ff) return null
  const port = await startStreamServer(ff)
  return 'http://127.0.0.1:' + port + '/stream?file=' + encodeURIComponent(filePath)
})

ipcMain.handle('read-sub-file',  (_, p) => fs.readFileSync(p, 'utf-8'))
ipcMain.handle('delete-file',    (_, p) => { try { fs.unlinkSync(p) } catch {} })
ipcMain.handle('show-in-folder', (_, p) => shell.showItemInFolder(p))

ipcMain.handle('write-temp-ass', (_, content) => {
  const tmp = path.join(os.tmpdir(), 'sbt_' + Date.now() + '.ass')
  fs.writeFileSync(tmp, content, 'utf-8')
  return tmp
})

// ── Burn with progress ─────────────────────────────────────────────────────
ipcMain.handle('burn', async (event, { inputPath, assPath, outputPath, codec, crf, preset, videoInfo }) => {
  const ff = findBinary('ffmpeg')
  if (!ff) throw new Error('ffmpeg not found')

  const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\\\:')
  const args = ['-y', '-i', inputPath, '-vf', 'ass=' + escaped, '-c:v', codec]
  if (codec !== 'copy') args.push('-crf', String(crf), '-preset', preset)
  args.push('-c:a', 'copy', '-c:s', 'copy', outputPath)

  return new Promise((resolve, reject) => {
    burnProc = spawn(ff, args, { stdio:['ignore','pipe','pipe'] })
    const proc = burnProc
    const lines = []
    proc.stderr.on('data', chunk => {
      const line = chunk.toString()
      lines.push(line)
      const tm = line.match(/time=(\d+):(\d+):([\d.]+)/)
      const fm = line.match(/fps=\s*([\d.]+)/)
      const sm = line.match(/speed=\s*([\d.]+)x/)
      if (tm) {
        const cur   = parseInt(tm[1])*3600 + parseInt(tm[2])*60 + parseFloat(tm[3])
        const total = videoInfo?.duration || 0
        const pct   = total > 0 ? Math.min(100, cur/total*100) : 0
        try { event.sender.send('burn-progress', { pct, cur, total, fps: fm ? fm[1] : '?', speed: sm ? sm[1] : '?' }) } catch {}
      }
    })
    proc.on('close', code => { burnProc = null; code === 0 ? resolve({ok:true}) : reject(new Error(lines.join('').slice(-3000))) })
    proc.on('error', (e) => { burnProc = null; reject(e) })
  })
})
