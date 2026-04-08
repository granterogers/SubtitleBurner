// ── State ──────────────────────────────────────────────────────────────────
const state = {
  videoPath:      null,
  videoDuration:  0,
  subEvents:      [],
  rawSubEvents:   [],
  customColour:   '#ffffff',
  isSeeking:      false,
  videoInfo:      null,
  sampleTimer:    null,
  streamBaseUrl:  null,
  speakerColours: {},
  speakerEnabled: false,
  speakerPalette: ['#ffffff','#ffff00','#00e5ff','#69ff47','#ff9100','#ff4081'],
}

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const r  = await window.api.checkFfmpeg()
  const el = document.getElementById('ffmpeg-status')
  el.textContent = r.ok ? '● ffmpeg ready' : '● ffmpeg not found'
  el.className   = r.ok ? 'ok' : 'error'

  const player = document.getElementById('player')
  player.addEventListener('timeupdate',     onTimeUpdate)
  player.addEventListener('loadedmetadata', onVideoLoaded)
  player.addEventListener('ended',          onVideoEnded)
  player.addEventListener('play',  () => document.getElementById('btn-play').textContent = '⏸')
  player.addEventListener('pause', () => document.getElementById('btn-play').textContent = '▶')

  document.getElementById('track-select').addEventListener('change', async function() {
    const idx = parseInt(this.value)
    if (!isNaN(idx)) await loadTrack(idx)
  })

  document.getElementById('speaker-colours-enabled').addEventListener('change', function() {
    state.speakerEnabled = this.checked
    document.getElementById('speaker-colours-panel').style.display = this.checked ? 'block' : 'none'
    if (this.checked) {
      // Assign colours to all speakers now
      for (const ev of state.rawSubEvents) if (ev.speaker) getSpeakerColour(ev.speaker)
      renderSpeakerSwatches()
    }
    schedulePreviewRefresh()
  })

  document.querySelectorAll(
    '#font-size, #max-chars, #padding, #bg-opacity, #buffer-lines, #silence-gap,' +
    'input[name=font-colour], input[name=bg-style], #rolling-enabled'
  ).forEach(el => {
    el.addEventListener('input',  schedulePreviewRefresh)
    el.addEventListener('change', schedulePreviewRefresh)
  })

  showPreview()

})

function setStatus(msg) { document.getElementById('status-text').textContent = msg }

// ── Colour helpers ─────────────────────────────────────────────────────────
function getSelectedFontColour() {
  const val = document.querySelector('input[name=font-colour]:checked')?.value || 'white'
  return val === 'yellow' ? '#ffff00' : val === 'custom' ? state.customColour : '#ffffff'
}

function getFadeColour(age, maxAge) {
  const steps = ['#444','#666','#888','#aaa','#ddd','#fff']
  const idx = Math.round((1 - Math.min(age, maxAge) / Math.max(maxAge, 1)) * (steps.length - 1))
  return steps[Math.max(0, Math.min(idx, steps.length - 1))]
}

function getSpeakerColour(name) {
  if (!name) return getSelectedFontColour()
  if (!state.speakerColours[name]) {
    const idx = Object.keys(state.speakerColours).length % state.speakerPalette.length
    state.speakerColours[name] = state.speakerPalette[idx]
  }
  return state.speakerColours[name]
}

// ── Build subtitle HTML ─────────────────────────────────────────────────────
function buildSubHtml(lines, speaker) {
  const rolling = document.getElementById('rolling-enabled').checked
  const baseCol = getSelectedFontColour()
  const maxAge  = lines.length - 1
  return lines.map((line, i) => {
    const age = lines.length - 1 - i  // 0 = newest
    let col
    if (age === 0) {
      // Newest line: use selected font colour (speaker override if enabled)
      col = (state.speakerEnabled && speaker && state.speakerColours[speaker])
        ? state.speakerColours[speaker]
        : baseCol
    } else {
      col = rolling ? getFadeColour(age, maxAge) : baseCol
    }
    return `<span style="color:${col};display:block;white-space:nowrap">${escapeHtml(line)}</span>`
  }).join('')
}

function applyContainerStyle(el) {
  const fontSize = parseInt(document.getElementById('font-size').value)
  const padding  = parseInt(document.getElementById('padding').value)
  const bgStyle  = document.querySelector('input[name=bg-style]:checked')?.value || 'solid'
  const opacity  = parseInt(document.getElementById('bg-opacity').value) / 100
  el.style.fontSize   = fontSize + 'px'
  el.style.padding    = padding + 'px ' + (padding * 2) + 'px'
  el.style.lineHeight = '1.45'
  el.style.background = bgStyle === 'none' ? 'transparent' : 'rgba(0,0,0,' + opacity + ')'
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── Preview ────────────────────────────────────────────────────────────────
function schedulePreviewRefresh() {
  clearTimeout(state.sampleTimer)
  state.sampleTimer = setTimeout(showPreview, 180)
}

function refreshStyle() { schedulePreviewRefresh() }

function showPreview(ev) {
  const overlay = document.getElementById('sub-overlay')
  let lines, speaker
  if (ev) {
    lines = ev.lines; speaker = ev.speaker || ''
  } else {
    const rolling  = document.getElementById('rolling-enabled').checked
    const maxLines = parseInt(document.getElementById('buffer-lines').value)
    const maxChars = parseInt(document.getElementById('max-chars').value)
    const demo = [
      "She said she'd meet us at the park",
      "but the rain started before we arrived",
      "so we waited under the old oak tree",
      "until the clouds finally cleared away",
    ]
    if (rolling) {
      const wrapped = []
      for (const l of demo) for (const c of wordWrap(l, maxChars)) wrapped.push(c)
      lines = wrapped.slice(-maxLines)
    } else {
      lines = wordWrap(demo[demo.length - 1], maxChars)
    }
    speaker = state.speakerEnabled ? 'Alice' : ''
  }
  overlay.innerHTML    = buildSubHtml(lines, speaker)
  overlay.style.display = 'block'
  applyContainerStyle(overlay)
}

// ── Speaker swatches ───────────────────────────────────────────────────────
function renderSpeakerSwatches() {
  const container = document.getElementById('speaker-swatches')
  container.innerHTML = ''
  const entries = Object.entries(state.speakerColours)
  if (!entries.length) {
    container.innerHTML = '<span style="font-size:11px;color:#666">Load subtitles to see speakers</span>'
    return
  }
  for (const [name, col] of entries) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px'
    const swatch = document.createElement('div')
    swatch.style.cssText = 'width:18px;height:18px;border-radius:3px;background:' + col + ';border:1px solid #555;cursor:pointer;flex-shrink:0'
    swatch.onclick = () => pickSpeakerColour(name, swatch)
    const label = document.createElement('span')
    label.textContent = name || '(unnamed)'
    label.style.cssText = 'font-size:12px;color:#ccc'
    row.appendChild(swatch); row.appendChild(label)
    container.appendChild(row)
  }
}

function pickSpeakerColour(name, swatchEl) {
  const cols = ['#ffffff','#ffff00','#00e5ff','#69ff47','#ff9100','#ff4081','#ff0000','#aaaaaa','#88ccff','#cc88ff']
  const popup = document.createElement('div')
  popup.style.cssText = 'position:fixed;z-index:9999;background:#2a2a2a;border:1px solid #555;border-radius:6px;padding:8px;display:flex;flex-wrap:wrap;gap:5px;width:160px;top:50%;left:50%;transform:translate(-50%,-50%)'
  for (const c of cols) {
    const s = document.createElement('div')
    s.style.cssText = 'width:28px;height:28px;background:' + c + ';border-radius:3px;cursor:pointer'
    s.onclick = () => {
      state.speakerColours[name] = c
      swatchEl.style.background = c
      schedulePreviewRefresh()
      popup.remove()
    }
    popup.appendChild(s)
  }
  const close = document.createElement('button')
  close.textContent = '✕'; close.style.cssText = 'width:100%;margin-top:4px'
  close.onclick = () => popup.remove()
  popup.appendChild(close)
  document.body.appendChild(popup)
}

function pickColour() {
  const existing = document.getElementById('colour-popup')
  if (existing) { existing.remove(); return }
  const popup = document.createElement('div')
  popup.id = 'colour-popup'
  popup.style.cssText = 'position:fixed;z-index:9999;background:#2a2a2a;border:1px solid #555;border-radius:6px;padding:8px;display:flex;flex-wrap:wrap;gap:5px;width:190px;top:50%;left:50%;transform:translate(-50%,-50%)'
  const cols = ['#ffffff','#ffff00','#00ffff','#00ff00','#ff8800','#ff69b4','#ff0000','#aaaaaa','#88ccff','#cc88ff']
  for (const c of cols) {
    const s = document.createElement('div')
    s.style.cssText = 'width:30px;height:30px;background:' + c + ';border-radius:3px;cursor:pointer'
    s.onclick = () => {
      state.customColour = c
      document.getElementById('colour-swatch').style.background = c
      document.querySelector('input[name=font-colour][value=custom]').checked = true
      schedulePreviewRefresh()
      popup.remove()
    }
    popup.appendChild(s)
  }
  const close = document.createElement('button')
  close.textContent = '✕ close'; close.style.cssText = 'width:100%;margin-top:4px'
  close.onclick = () => popup.remove()
  popup.appendChild(close)
  document.body.appendChild(popup)
}

function updateLabel(slider, labelId, multiplier) {
  const v = multiplier ? (slider.value * multiplier).toFixed(1) + 's' : slider.value + (labelId.includes('opacity') ? '%' : '')
  document.getElementById(labelId).textContent = v
}

// ── File browsing ──────────────────────────────────────────────────────────
async function browseVideo() {
  const p = await window.api.openFile([
    { name: 'Video Files', extensions: ['mkv','mp4','avi','mov'] },
    { name: 'All Files', extensions: ['*'] }
  ])
  if (!p) return
  state.videoPath = p
  document.getElementById('input-path').value = p.split(/[\\/]/).pop()
  document.getElementById('input-path').title  = p
  document.getElementById('output-path').value = p.replace(/\.[^.]+$/, '') + '_burned.mkv'
  await loadVideo(p)
  await scanTracks()
}

async function browseSub() {
  const p = await window.api.openFile([
    { name: 'Subtitle Files', extensions: ['srt','ass','ssa','vtt'] },
    { name: 'All Files', extensions: ['*'] }
  ])
  if (!p) return
  document.getElementById('sub-path').value = p.split(/[\\/]/).pop()
  document.getElementById('sub-path').title  = p
  loadSubContent(await window.api.readSubFile(p), p)
  document.getElementById('burn-btn').disabled = false
}

async function browseOutput() {
  const p = await window.api.saveFile(document.getElementById('output-path').value || undefined)
  if (p) document.getElementById('output-path').value = p
}

// ── Video ──────────────────────────────────────────────────────────────────
async function loadVideo(filePath) {
  const player = document.getElementById('player')
  state.filePath = filePath

  // Remove old audio-proxy if any
  const old = document.getElementById('audio-proxy')
  if (old) old.remove()

  setStatus('Loading...')
  const streamUrl = await window.api.getStreamUrl(filePath)
  if (streamUrl) {
    // Use stream URL — FFmpeg transcodes DTS/AC3 -> AAC on the fly
    state.streamBaseUrl = streamUrl
    player.src = streamUrl
    console.log('[Audio] Using stream URL:', streamUrl)
  } else {
    // Fallback: direct file (audio may not work for DTS)
    state.streamBaseUrl = null
    const normalized = filePath.replace(/\\/g, '/')
    player.src = 'file:///' + normalized.replace(/^\/+/, '')
    console.warn('[Audio] No stream server — using file:// (DTS audio may not play)')
  }

  player.muted  = false
  player.volume = parseFloat(document.getElementById('volume').value)
  player.style.display = 'block'
  document.getElementById('no-video').style.display = 'none'
  document.getElementById('btn-play').disabled = false
  document.getElementById('btn-stop').disabled = false

  player.addEventListener('error', (e) => {
    console.error('[Audio] player error code:', player.error?.code, player.error?.message)
  }, { once: true })
}

function onVideoLoaded() {
  state.videoDuration = document.getElementById('player').duration
  updateTimeDisplay(0)
  setStatus('Ready — ' + fmt(state.videoDuration))
}

function onVideoEnded() {
  document.getElementById('player').currentTime = 0
  document.getElementById('btn-play').textContent = '▶'
  showPreview()
}

function togglePlay() {
  const p = document.getElementById('player')
  if (!p.src || p.src === window.location.href) return
  p.paused ? p.play() : p.pause()
}

function stopVideo() {
  const p = document.getElementById('player')
  p.pause()
  if (state.streamBaseUrl) {
    p.src = state.streamBaseUrl
    p.load()
  } else {
    p.currentTime = 0
  }
  showPreview()
}

function setVolume(v) {
  const p = document.getElementById('player')
  p.volume = parseFloat(v); p.muted = false
}

// ── Seek ───────────────────────────────────────────────────────────────────
function onSeekInput() {
  state.isSeeking = true
  updateTimeDisplay(document.getElementById('seek-bar').value / 1000 * (document.getElementById('player').duration || 0))
}

function onSeekChange() {
  const pos = document.getElementById('seek-bar').value / 1000 * (document.getElementById('player').duration || 0)
  const p   = document.getElementById('player')

  if (state.streamBaseUrl) {
    // Re-request stream from new position — much more reliable than currentTime
    const wasPlaying = !p.paused
    const url = state.streamBaseUrl + '&t=' + pos.toFixed(2)
    p.src = url
    p.load()
    if (wasPlaying) p.play()
  } else {
    p.currentTime = pos
  }
  state.isSeeking = false
}

function onTimeUpdate() {
  if (state.isSeeking) return
  const p = document.getElementById('player')
  const pos = p.currentTime, dur = p.duration || 0
  document.getElementById('seek-bar').value = dur > 0 ? pos / dur * 1000 : 0
  updateTimeDisplay(pos)
  const ev = state.subEvents.find(e => pos >= e.start && pos < e.end)
  if (ev) showPreview(ev)
  else     document.getElementById('sub-overlay').style.display = 'none'
}

function updateTimeDisplay(pos) {
  document.getElementById('time-display').textContent = fmt(pos) + ' / ' + fmt(document.getElementById('player').duration || state.videoDuration || 0)
}

function fmt(s) {
  if (!isFinite(s)) return '0:00:00'
  return Math.floor(s/3600) + ':' + String(Math.floor((s%3600)/60)).padStart(2,'0') + ':' + String(Math.floor(s%60)).padStart(2,'0')
}

// ── Track scanning ─────────────────────────────────────────────────────────
async function scanTracks() {
  if (!state.videoPath) { alert('Open a video first.'); return }
  setStatus('Scanning...')
  try {
    const info = await window.api.probeFile(state.videoPath)
    state.videoInfo = info
    const sel = document.getElementById('track-select')
    sel.innerHTML = '<option value="">— select track —</option>'
    const tracks = (info.streams||[]).filter(s => s.codec_type === 'subtitle')
    for (const t of tracks) {
      const opt = document.createElement('option')
      opt.value = t.index
      opt.textContent = 'Track ' + t.index + ': ' + (t.tags?.language||'unknown') + (t.tags?.title ? ' — '+t.tags.title : '') + ' (' + t.codec_name + ')'
      sel.appendChild(opt)
    }
    if (tracks.length) { sel.selectedIndex = 1; await loadTrack(tracks[0].index) }
    else setStatus('No subtitle tracks found')
  } catch(e) { setStatus('Scan error: ' + e.message) }
}

async function loadTrack(idx) {
  setStatus('Extracting track ' + idx + '...')
  try {
    loadSubContent(await window.api.extractSubs({ filePath: state.videoPath, trackIndex: idx }), null)
    document.getElementById('burn-btn').disabled = false
    setStatus('Track ' + idx + ' loaded — ' + state.subEvents.length + ' events')
  } catch(e) { setStatus('Extract error: ' + e.message) }
}

// ── Subtitle parsing ───────────────────────────────────────────────────────
function loadSubContent(content, filePath) {
  const ext = filePath ? filePath.split('.').pop().toLowerCase() : 'ass'
  state.rawSubEvents = (ext === 'ass' || ext === 'ssa') ? parseAss(content) : parseSrt(content)
  state.speakerColours = {}
  // Only pre-assign colours if speaker mode is enabled
  if (state.speakerEnabled) {
    for (const ev of state.rawSubEvents) if (ev.speaker) getSpeakerColour(ev.speaker)
  }
  reprocessSubs()
  renderSpeakerSwatches()
}

function parseSrt(text) {
  const events = []
  for (const block of text.trim().split(/\r?\n\r?\n/)) {
    const lines = block.split('\n').map(l=>l.trim()).filter(Boolean)
    const tl = lines.find(l=>l.includes('-->'))
    if (!tl) continue
    const [s,e] = tl.split('-->').map(x=>x.trim())
    const start = parseSrtTime(s), end = parseSrtTime(e)
    if (start===null||end===null) continue
    const txt = lines.slice(lines.indexOf(tl)+1).map(l=>l.replace(/<[^>]+>/g,'').trim()).filter(Boolean)
    if (txt.length) events.push({ start, end, speaker:'', lines: txt })
  }
  return events
}

function parseSrtTime(s) {
  const m = s.replace(',','.').match(/(\d+):(\d{2}):([\d.]+)/)
  return m ? parseInt(m[1])*3600+parseInt(m[2])*60+parseFloat(m[3]) : null
}

function parseAss(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('Dialogue:')) continue
    const parts = line.split(',')
    if (parts.length < 10) continue
    const start = parseAssTime(parts[1].trim()), end = parseAssTime(parts[2].trim())
    if (start===null||end===null) continue
    const speaker = parts[4].trim()
    const clean = parts.slice(9).join(',').replace(/\{[^}]*\}/g,'').replace(/\\N/gi,'\n').replace(/\\n/gi,'\n').trim()
    if (clean) events.push({ start, end, speaker, lines: clean.split('\n').map(l=>l.trim()).filter(Boolean) })
  }
  return events.sort((a,b)=>a.start-b.start)
}

function parseAssTime(s) {
  const m = s.match(/(\d+):(\d{2}):([\d.]+)/)
  return m ? parseInt(m[1])*3600+parseInt(m[2])*60+parseFloat(m[3]) : null
}

// ── Rolling buffer ─────────────────────────────────────────────────────────
function reprocessSubs() {
  if (!state.rawSubEvents.length) return
  const rolling  = document.getElementById('rolling-enabled').checked
  const maxLines = parseInt(document.getElementById('buffer-lines').value)
  const silence  = parseInt(document.getElementById('silence-gap').value) / 10
  const maxChars = parseInt(document.getElementById('max-chars').value)
  if (!rolling) {
    state.subEvents = state.rawSubEvents.map(ev => ({...ev, lines: wordWrap(ev.lines.join(' '), maxChars)}))
    schedulePreviewRefresh(); return
  }
  const output=[], buffer=[]
  for (let i=0; i<state.rawSubEvents.length; i++) {
    const ev = state.rawSubEvents[i]
    if (i>0 && (ev.start-state.rawSubEvents[i-1].end)>silence) buffer.length=0
    for (const c of wordWrap(ev.lines.join(' '),maxChars)) { buffer.push(c); if(buffer.length>maxLines) buffer.shift() }
    const displayEnd = i+1<state.rawSubEvents.length ? state.rawSubEvents[i+1].start : ev.end
    output.push({ start:ev.start, end:displayEnd, speaker:ev.speaker, lines:[...buffer] })
  }
  state.subEvents = output
  schedulePreviewRefresh()
}

function wordWrap(text, max) {
  if (text.length<=max) return [text]
  const words=text.split(' '), lines=[]
  let cur=''
  for (const w of words) { if(cur&&cur.length+1+w.length>max){lines.push(cur);cur=''} cur=cur?cur+' '+w:w }
  if (cur) lines.push(cur)
  return lines
}

// ── ASS for burn ───────────────────────────────────────────────────────────
function buildAssFile() {
  const fontSize = parseInt(document.getElementById('font-size').value)
  const bgStyle  = document.querySelector('input[name=bg-style]:checked').value
  const opacity  = parseInt(document.getElementById('bg-opacity').value)/100
  const pad      = parseInt(document.getElementById('padding').value)
  const rolling  = document.getElementById('rolling-enabled').checked
  const alpha    = Math.round((1-opacity)*255).toString(16).padStart(2,'0').toUpperCase()
  const backCol  = bgStyle==='none' ? '&H00000000' : '&H'+alpha+'000000'
  const borderSt = bgStyle==='none' ? 1 : 4
  const h        = getSelectedFontColour().replace('#','')
  const primCol  = '&H00'+h.slice(4,6)+h.slice(2,4)+h.slice(0,2)
  const fadeAss  = ['&H00444444','&H00666666','&H00888888','&H00AAAAAA','&H00DDDDDD','&H00FFFFFF']

  let out = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n'
  out += '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
  out += 'Style: Default,Arial,'+fontSize+','+primCol+',&H000000FF,&H00000000,'+backCol+',0,0,0,0,100,100,0,0,'+borderSt+',1,0,2,'+pad+','+pad+','+pad+',1\n\n'
  out += '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'

  for (const ev of state.subEvents) {
    let text
    if (rolling && ev.lines.length > 1) {
      const maxAge = ev.lines.length-1
      text = ev.lines.map((l,i) => {
        const age  = ev.lines.length-1-i
        const fidx = Math.round((1-Math.min(age,maxAge)/maxAge)*(fadeAss.length-1))
        let col    = fadeAss[Math.max(0,Math.min(fidx,fadeAss.length-1))]
        if (state.speakerEnabled && ev.speaker && age===0) {
          const sc = getSpeakerColour(ev.speaker).replace('#','')
          col = '&H00'+sc.slice(4,6)+sc.slice(2,4)+sc.slice(0,2)
        }
        return '{\\c'+col+'}'+l
      }).join('\\N')
    } else {
      text = ev.lines.join('\\N')
    }
    out += 'Dialogue: 0,'+fmtAss(ev.start)+','+fmtAss(ev.end)+',Default,,0,0,0,,'+text+'\n'
  }
  return out
}

function fmtAss(t) {
  const h=Math.floor(t/3600), m=Math.floor((t%3600)/60), s=Math.floor(t%60), cs=Math.round((t-Math.floor(t))*100)
  return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+String(cs).padStart(2,'0')
}

// ── Burn ───────────────────────────────────────────────────────────────────
async function cancelBurn() {
  setStatus('Cancelling...')
  await window.api.cancelBurn()
}

async function startBurn() {
  if (!state.videoPath)        { alert('Load a video file first.'); return }
  if (!state.subEvents.length) { alert('Load subtitles first.');    return }
  const outputPath = document.getElementById('output-path').value.trim()
  if (!outputPath)             { alert('Set an output path.');       return }

  const burnBtn   = document.getElementById('burn-btn')
  const cancelBtn = document.getElementById('cancel-btn')
  const progress  = document.getElementById('progress-bar')
  burnBtn.disabled = true
  if (cancelBtn) cancelBtn.style.display = 'inline-block'
  progress.style.display = 'block'; progress.value = 0

  let assPath = null
  const rm = window.api.onBurnProgress(({pct,cur,total,fps,speed}) => {
    progress.value = pct
    setStatus('Burning '+pct.toFixed(1)+'%  ['+fmt(cur)+' / '+fmt(total)+']  '+fps+' fps  '+speed+'x')
  })

  try {
    assPath = await window.api.writeTempAss(buildAssFile())
    await window.api.burn({
      inputPath: state.videoPath, assPath, outputPath,
      codec: document.getElementById('codec').value,
      crf:   parseInt(document.getElementById('crf').value),
      preset: document.getElementById('preset').value,
      videoInfo: { duration: state.videoDuration }
    })
    progress.value = 100
    setStatus('Done! → ' + outputPath.split(/[\\/]/).pop())
    if (confirm('Burn complete!\n\n'+outputPath+'\n\nShow in folder?')) await window.api.showInFolder(outputPath)
  } catch(e) {
    if (e.message && (e.message === 'CANCELLED' || e.message.includes('kill') || e.message.includes('signal'))) {
      setStatus('Burn cancelled.')
    } else {
      setStatus('Burn failed: ' + e.message.slice(0, 120))
      alert('Burn failed:\n\n' + e.message.slice(0, 800))
    }
  } finally {
    rm(); if(assPath) await window.api.deleteFile(assPath)
    burnBtn.disabled = false
    if (cancelBtn) cancelBtn.style.display = 'none'
    setTimeout(() => { progress.style.display = 'none'; setStatus('Ready') }, 3000)
  }
}
