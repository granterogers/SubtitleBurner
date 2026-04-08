const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path   = require('path')
const { spawn, spawnSync } = require('child_process')
const fs     = require('fs')
const os     = require('os')
const http   = require('http')
const net    = require('net')

let streamServer = null
let streamPort   = 0
let currentStreamProc = null
let burnProc = null
let mainWindow = null

// ── Debug log (ring buffer + file, sent to renderer on demand) ────────────
const debugLog = []
const logFile = path.join(path.dirname(process.execPath === process.argv[0]
  ? process.argv[1]   // dev: script path
  : process.execPath  // packaged: exe path
), 'debug.log')

// Truncate log file on startup
try { fs.writeFileSync(logFile, '=== SubtitleBurner debug log ' + new Date().toISOString() + ' ===\n') } catch {}

function dbg(...args) {
  const line = '[' + new Date().toISOString().slice(11,23) + '] ' + args.join(' ')
  debugLog.push(line)
  if (debugLog.length > 500) debugLog.shift()
  console.log(line)
  try { fs.appendFileSync(logFile, line + '\n') } catch {}
  try { mainWindow?.webContents.send('debug-log', line) } catch {}
}

// ── Chromium-compatible video codecs ──────────────────────────────────────
// These can be passed through with -c:v copy. Everything else needs transcode.
const CHROMIUM_VIDEO_CODECS = new Set([
  'h264', 'avc', 'avc1',
  'vp8', 'vp9',
  'av1',
  'theora',
])

function needsVideoTranscode(codecName) {
  if (!codecName) return true
  const c = codecName.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const ok of CHROMIUM_VIDEO_CODECS) {
    if (c.includes(ok.replace(/[^a-z0-9]/g, ''))) return false
  }
  return true
}

// ── Port helper ───────────────────────────────────────────────────────────
function getFreePort() {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}

// ── Stream server ─────────────────────────────────────────────────────────
async function startStreamServer(ffmpegBin) {
  if (streamServer) return streamPort
  streamPort = await getFreePort()
  dbg('[Stream] Starting on port', streamPort)

  streamServer = http.createServer(async (req, res) => {
    const url  = new URL(req.url, 'http://localhost')
    const file = decodeURIComponent(url.searchParams.get('file') || '')
    const startTime = parseFloat(url.searchParams.get('t') || '0')

    dbg('[Stream] Request for:', file, 't=', startTime)

    if (!file || !fs.existsSync(file)) {
      dbg('[Stream] ERROR: file not found:', file)
      res.writeHead(404); res.end(); return
    }

    // Probe video codec to decide whether to transcode
    let videoCodec = null
    try {
      const fp = findBinary('ffprobe')
      if (fp) {
        const probe = spawnSync(fp, [
          '-v', 'quiet', '-print_format', 'json',
          '-show_streams', '-select_streams', 'v:0', file
        ], { encoding: 'utf8' })
        const info = JSON.parse(probe.stdout || '{}')
        videoCodec = info.streams?.[0]?.codec_name || null
        dbg('[Stream] Video codec detected:', videoCodec)
      }
    } catch (e) {
      dbg('[Stream] Probe error:', e.message)
    }

    const transcodeVideo = needsVideoTranscode(videoCodec)
    dbg('[Stream] Transcode video?', transcodeVideo, '(codec:', videoCodec + ')')

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
    })

    // Kill previous process immediately — overlapping audio causes A/V desync
    if (currentStreamProc) { try { currentStreamProc.kill() } catch {} }

    const fileDur = parseFloat(url.searchParams.get('dur') || '0')
    const segDur  = fileDur > 0 && startTime > 0 ? fileDur - startTime : fileDur

    const ffArgs = [
      '-i', file,
      // Accurate seek AFTER -i — slower to start but guarantees A/V sync
      // Fast seek before -i causes video/audio to land on different offsets
      ...(startTime > 0 ? ['-ss', String(startTime)] : []),
      '-c:v', transcodeVideo ? 'libx264' : 'copy',
      ...(transcodeVideo ? ['-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'] : []),
      '-c:a', 'aac',
      '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero',
      ...(segDur > 0 ? ['-metadata', 'DURATION=' + segDur.toFixed(3)] : []),
      '-movflags', 'frag_keyframe+empty_moov+faststart+default_base_moof',
      '-f', 'mp4', 'pipe:1'
    ]

    dbg('[Stream] FFmpeg args:', ffArgs.join(' '))

    const proc = spawn(ffmpegBin, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    currentStreamProc = proc

    let ffErr = ''
    proc.stderr.on('data', d => {
      const chunk = d.toString()
      ffErr += chunk
      // Only log FFmpeg's first few lines and errors to avoid spam
      if (ffErr.length < 2000 || chunk.includes('Error') || chunk.includes('error')) {
        dbg('[FFmpeg]', chunk.trim().slice(0, 200))
      }
    })
    proc.stdout.pipe(res)
    proc.on('close', code => {
      if (code !== 0) dbg('[Stream] FFmpeg exited with code', code, '— last stderr:', ffErr.slice(-500))
      else dbg('[Stream] FFmpeg stream finished cleanly')
    })
    req.on('close', () => { try { proc.kill() } catch {} })
    proc.on('error', e => {
      dbg('[Stream] FFmpeg spawn error:', e.message)
      try { res.end() } catch {}
    })
  })

  streamServer.listen(streamPort, '127.0.0.1')
  return streamPort
}

// ── App setup ─────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 780, minWidth: 900, minHeight: 620,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    show: false
  })
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(true))
  mainWindow.webContents.session.setPermissionCheckHandler(() => true)
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => { mainWindow.maximize(); mainWindow.show() })
}

app.whenReady().then(createWindow)

app.on('before-quit', () => {
  try { burnProc?.kill('SIGTERM') } catch {}
  try { currentStreamProc?.kill('SIGTERM') } catch {}
})
app.on('window-all-closed', () => {
  try { burnProc?.kill('SIGTERM') } catch {}
  try { currentStreamProc?.kill('SIGTERM') } catch {}
  streamServer?.close()
  app.quit()
})

// ── Find binaries ─────────────────────────────────────────────────────────
function findBinary(name) {
  const exeName = process.platform === 'win32' ? name + '.exe' : name
  const which = spawnSync(
    process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }
  )
  if (which.status === 0 && which.stdout.trim())
    return which.stdout.trim().split('\n')[0].trim()
  const extra = [
    'C:\\ffmpeg\\bin\\' + exeName,
    'C:\\Program Files\\ffmpeg\\bin\\' + exeName,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ffmpeg', 'bin', exeName),
    path.join(os.homedir(), 'scoop', 'shims', exeName),
  ]
  for (const c of extra) { try { fs.accessSync(c); return c } catch {} }
  return null
}

function runProcess(bin, args) {
  return new Promise((resolve, reject) => {
    let out = '', err = ''
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', d => out += d)
    proc.stderr.on('data', d => err += d)
    proc.on('close', code => code === 0 ? resolve({ stdout: out, stderr: err }) : reject(new Error(err.slice(-2000))))
    proc.on('error', reject)
  })
}

// ── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('check-ffmpeg', async () => {
  const ffmpeg  = findBinary('ffmpeg')
  const ffprobe = findBinary('ffprobe')
  dbg('[Init] ffmpeg:', ffmpeg || 'NOT FOUND')
  dbg('[Init] ffprobe:', ffprobe || 'NOT FOUND')
  // Log ffmpeg version for debugging
  if (ffmpeg) {
    try {
      const v = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' })
      dbg('[Init] ffmpeg version:', v.stdout.split('\n')[0])
    } catch {}
  }
  return { ffmpeg, ffprobe, ok: !!(ffmpeg && ffprobe) }
})

ipcMain.handle('open-file', async (_, filters) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: filters || [] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('save-file', async (_, defaultPath) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: [{ name: 'MKV', extensions: ['mkv'] }, { name: 'MP4', extensions: ['mp4'] }]
  })
  return r.canceled ? null : r.filePath
})

ipcMain.handle('probe-file', async (_, filePath) => {
  const fp = findBinary('ffprobe')
  if (!fp) throw new Error('ffprobe not found')
  dbg('[Probe] Probing:', filePath)
  const { stdout } = await runProcess(fp, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath])
  const result = JSON.parse(stdout)
  // Log stream summary
  for (const s of result.streams || []) {
    dbg(`[Probe] Stream #${s.index}: ${s.codec_type} — ${s.codec_name} ${s.width ? s.width+'x'+s.height : ''} ${s.tags?.language || ''}`)
  }
  return result
})

ipcMain.handle('extract-subs', async (_, { filePath, trackIndex, codecName }) => {
  const ff = findBinary('ffmpeg')
  if (!ff) throw new Error('ffmpeg not found')
  dbg('[Subs] Extracting track', trackIndex, 'codec:', codecName, 'from', filePath)
  // Use correct extension so ffmpeg outputs the right format
  const isSrt = codecName && (codecName.includes('subrip') || codecName.includes('srt'))
  const ext = isSrt ? '.srt' : '.ass'
  const tmp = path.join(os.tmpdir(), 'sbt_' + Date.now() + ext)
  await runProcess(ff, ['-y', '-i', filePath, '-map', '0:' + trackIndex, tmp])
  const content = fs.readFileSync(tmp, 'utf-8')
  try { fs.unlinkSync(tmp) } catch {}
  dbg('[Subs] Extracted', content.split('\n').length, 'lines as', ext)
  return content
})

ipcMain.handle('get-stream-url', async (_, filePath) => {
  const ff = findBinary('ffmpeg')
  if (!ff) { dbg('[Stream] ffmpeg not found, no stream URL'); return null }
  // Get duration from ffprobe to pass to stream server
  let duration = 0
  try {
    const fp = findBinary('ffprobe')
    if (fp) {
      const r = spawnSync(fp, ['-v','quiet','-show_entries','format=duration','-of','csv=p=0', filePath], { encoding:'utf8' })
      duration = parseFloat(r.stdout.trim()) || 0
      dbg('[Stream] File duration:', duration.toFixed(1) + 's')
    }
  } catch {}
  const port = await startStreamServer(ff)
  const url = 'http://127.0.0.1:' + port + '/stream?file=' + encodeURIComponent(filePath)
    + (duration > 0 ? '&dur=' + duration.toFixed(3) : '')
  dbg('[Stream] URL ready:', url)
  return url
})

ipcMain.handle('get-debug-log', () => debugLog.join('\n'))

ipcMain.handle('read-sub-file',  (_, p) => fs.readFileSync(p, 'utf-8'))
ipcMain.handle('delete-file',    (_, p) => { try { fs.unlinkSync(p) } catch {} })
ipcMain.handle('show-in-folder', (_, p) => shell.showItemInFolder(p))

ipcMain.handle('write-temp-ass', (_, content) => {
  const tmp = path.join(os.tmpdir(), 'sbt_' + Date.now() + '.ass')
  fs.writeFileSync(tmp, content, 'utf-8')
  return tmp
})

ipcMain.handle('cancel-burn', () => {
  if (burnProc) { try { burnProc.kill('SIGTERM') } catch {} burnProc = null; return true }
  return false
})

// ── Burn ──────────────────────────────────────────────────────────────────
ipcMain.handle('burn', async (event, { inputPath, assPath, outputPath, codec, crf, preset, videoInfo }) => {
  const ff = findBinary('ffmpeg')
  if (!ff) throw new Error('ffmpeg not found')

  const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\\\:')
  const args = ['-y', '-i', inputPath, '-vf', 'ass=' + escaped, '-c:v', codec]
  if (codec !== 'copy') args.push('-crf', String(crf), '-preset', preset)
  args.push('-c:a', 'copy', '-c:s', 'copy', outputPath)

  dbg('[Burn] Starting:', args.join(' '))

  return new Promise((resolve, reject) => {
    burnProc = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
        try { event.sender.send('burn-progress', { pct, cur, total, fps: fm?.[1] || '?', speed: sm?.[1] || '?' }) } catch {}
      }
    })
    proc.on('close', code => {
      burnProc = null
      if (code === 0) { dbg('[Burn] Complete'); resolve({ ok: true }) }
      else { dbg('[Burn] Failed, exit', code); reject(new Error(lines.join('').slice(-3000))) }
    })
    proc.on('error', e => { burnProc = null; dbg('[Burn] Error:', e.message); reject(e) })
  })
})
