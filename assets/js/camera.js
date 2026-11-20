/**
 * Câmera + gravação na melhor qualidade possível para o Teleprompter
 * - escolhe o melhor modo 16:9 que a câmera aguenta a 30 fps
 * - bitrate alto, H.264/MP4 quando disponível
 * - áudio 48 kHz sem filtros (sem redução de ruído/ganho automático)
 * - grava direto no armazenamento (OPFS) para tomadas longas em 4K
 */
(function () {
  'use strict';

  var MODES = {
    'max':   { label: 'Máxima', list: [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720]], minFps: 24 },
    '4k':    { label: 'Máx. resolução', list: [[3840, 2160], [3264, 1836], [2880, 1620], [2560, 1440]], minFps: 0 },
    '1440p': { label: '1440p',  list: [[2560, 1440]], minFps: 0 },
    '1080p': { label: '1080p',  list: [[1920, 1080]], minFps: 0 },
    '720p':  { label: '720p',   list: [[1280, 720]],  minFps: 0 }
  };

  var state = {
    stream: null,
    facing: load('tp_cam_facing', 'user'),
    res: load('tp_cam_res', 'max'),
    opacity: parseFloat(load('tp_cam_opacity', '0.45')),
    recorder: null,
    chunks: [],
    writer: null,
    writeChain: null,
    fileName: null,
    startedAt: 0,
    timer: null,
    settings: null
  };

  if (!MODES[state.res]) { state.res = 'max'; }

  var el = {};

  function load(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function $(id) { return document.getElementById(id); }

  function init() {
    el.video = $('cam-video');
    el.shade = $('cam-shade');
    el.panel = $('cam-panel');
    el.toggle = $('cam-toggle');
    el.rec = $('cam-rec');
    el.res = $('cam-res');
    el.flip = $('cam-flip');
    el.opacity = $('cam-opacity');
    el.info = $('cam-info');
    el.time = $('cam-time');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el.toggle.style.display = 'none';
      return;
    }

    el.res.value = state.res;
    el.opacity.value = state.opacity;
    applyOpacity();

    el.toggle.addEventListener('click', function () { state.stream ? stopCamera() : startCamera(); });
    el.rec.addEventListener('click', function () { state.recorder ? stopRecording() : startRecording(); });
    el.res.addEventListener('change', function () {
      state.res = el.res.value; save('tp_cam_res', state.res);
      if (state.stream && !state.recorder) { startCamera(); }
    });
    el.flip.addEventListener('click', function () {
      if (state.recorder) { return; }
      state.facing = state.facing === 'user' ? 'environment' : 'user';
      save('tp_cam_facing', state.facing);
      if (state.stream) { startCamera(); }
    });
    el.opacity.addEventListener('input', function () {
      state.opacity = parseFloat(el.opacity.value); save('tp_cam_opacity', state.opacity);
      applyOpacity();
    });

    el.panel.addEventListener('keydown', function (e) { e.stopPropagation(); });

    window.addEventListener('beforeunload', function (e) {
      if (state.recorder) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function applyOpacity() {
    el.shade.style.opacity = String(1 - state.opacity);
  }

  function stopTracks() {
    if (state.stream) { state.stream.getTracks().forEach(function (t) { t.stop(); }); }
    state.stream = null;
  }

  var AUDIO_HQ = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: { ideal: 48000 },
    sampleSize: { ideal: 16 },
    channelCount: { ideal: 2 }
  };

  function getMedia() {
    var big = MODES[state.res].list[0];
    var v = { facingMode: state.facing, width: { ideal: big[0] }, height: { ideal: big[1] }, frameRate: { ideal: 30 } };
    return navigator.mediaDevices.getUserMedia({ video: v, audio: AUDIO_HQ }).catch(function () {
      return navigator.mediaDevices.getUserMedia({ video: v, audio: true });
    }).catch(function () {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facing }, audio: true });
    });
  }

  // Tenta cada modo (paisagem e retrato) até achar o melhor que a câmera entrega
  function pickBestMode(track) {
    var caps = track.getCapabilities ? track.getCapabilities() : {};
    var maxW = caps.width && caps.width.max, maxH = caps.height && caps.height.max;
    var maxFps = (caps.frameRate && caps.frameRate.max) || 30;
    var fps = Math.min(30, maxFps);
    var mode = MODES[state.res];
    var tries = [];

    mode.list.forEach(function (wh) {
      var w = wh[0], h = wh[1];
      var fitsL = !maxW || (Math.max(maxW, maxH) >= w && Math.min(maxW, maxH) >= h);
      if (fitsL) { tries.push([w, h]); tries.push([h, w]); }
    });

    var fallback = null;

    function attempt(i) {
      if (i >= tries.length) {
        if (fallback) {
          return track.applyConstraints(fallback).catch(function () {});
        }
        return Promise.resolve();
      }
      var c = {
        width: { exact: tries[i][0] },
        height: { exact: tries[i][1] },
        frameRate: { ideal: fps, min: Math.min(mode.minFps || 1, fps) }
      };
      return track.applyConstraints(c).then(function () {
        var s = track.getSettings();
        if (!mode.minFps || !s.frameRate || s.frameRate >= mode.minFps) { return; }
        if (!fallback) { fallback = c; }
        return attempt(i + 1);
      }, function () { return attempt(i + 1); });
    }

    return attempt(0).then(function () {
      // foco / exposição / balanço de branco automáticos e contínuos quando suportado
      var adv = {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) { adv.focusMode = 'continuous'; }
      if (caps.exposureMode && caps.exposureMode.indexOf('continuous') !== -1) { adv.exposureMode = 'continuous'; }
      if (caps.whiteBalanceMode && caps.whiteBalanceMode.indexOf('continuous') !== -1) { adv.whiteBalanceMode = 'continuous'; }
      if (Object.keys(adv).length) {
        return track.applyConstraints({ advanced: [adv] }).catch(function () {});
      }
    });
  }

  function startCamera() {
    stopTracks();
    el.info.textContent = 'Abrindo câmera…';

    return getMedia().then(function (stream) {
      state.stream = stream;
      var vt = stream.getVideoTracks()[0];
      try { vt.contentHint = 'detail'; } catch (e) {}
      return pickBestMode(vt);
    }).then(function () {
      el.video.srcObject = state.stream;
      el.video.classList.toggle('mirror', state.facing === 'user');
      document.body.classList.add('cam-on');
      el.toggle.classList.add('active');
      el.panel.hidden = false;
      return el.video.play();
    }).then(function () {
      showInfo();
    }).catch(function (err) {
      alert('Não foi possível abrir a câmera: ' + (err && err.message ? err.message : err) +
        '\n\nPermita o acesso à câmera e ao microfone para este app.');
      stopCamera();
    });
  }

  function qualityName(w, h) {
    var s = Math.min(w, h);
    return s >= 2160 ? '4K' : s >= 1440 ? '1440p' : s >= 1080 ? '1080p' : s >= 720 ? '720p' : s + 'p';
  }

  function showInfo() {
    if (!state.stream) { return; }
    var s = state.stream.getVideoTracks()[0].getSettings();
    var a = state.stream.getAudioTracks()[0];
    var as = a ? a.getSettings() : null;
    var w = s.width || el.video.videoWidth, h = s.height || el.video.videoHeight;
    state.settings = { w: w, h: h, fps: s.frameRate || 30 };
    var txt = qualityName(w, h) + ' · ' + w + '×' + h + ' · ' + Math.round(s.frameRate || 30) + 'fps';
    txt += a ? ' · 🎤 ' + (as.sampleRate ? Math.round(as.sampleRate / 1000) + 'kHz' : 'ok') : ' · sem microfone';
    if (state.res === '4k' && Math.min(w, h) < 2160) { txt += ' (4K não disponível nesta câmera)'; }
    if ((s.frameRate || 30) < 25) { txt += ' · fps baixo: use "Máxima" para 30fps'; }
    el.info.textContent = txt;
  }

  function stopCamera() {
    if (state.recorder) { stopRecording(); }
    stopTracks();
    el.video.srcObject = null;
    document.body.classList.remove('cam-on');
    el.toggle.classList.remove('active');
    el.panel.hidden = true;
  }

  function pickMime() {
    var types = [
      'video/mp4;codecs=avc1.640033,mp4a.40.2',
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    if (typeof MediaRecorder === 'undefined') { return null; }
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) { return types[i]; }
    }
    return '';
  }

  function videoBitrate() {
    var st = state.settings || { w: 1920, h: 1080, fps: 30 };
    // ~0.25 bit por pixel por quadro: 1080p30 ≈ 16 Mbps, 3264×1836@20 ≈ 30 Mbps, 4K30 ≈ 60 Mbps
    var bps = Math.round(st.w * st.h * Math.max(24, st.fps) * 0.25);
    return Math.max(16000000, Math.min(bps, 60000000));
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // Armazenamento em disco (OPFS) para não estourar a memória em 4K
  function openDiskWriter(name) {
    if (!navigator.storage || !navigator.storage.getDirectory) { return Promise.resolve(null); }
    return navigator.storage.getDirectory().then(function (root) {
      return root.getFileHandle(name, { create: true });
    }).then(function (fh) {
      if (!fh.createWritable) { return null; }
      return fh.createWritable().then(function (w) { return { handle: fh, writable: w }; });
    }).catch(function () { return null; });
  }

  function cleanupOldTakes(keep) {
    if (!navigator.storage || !navigator.storage.getDirectory) { return; }
    navigator.storage.getDirectory().then(function (root) {
      if (!root.entries) { return; }
      var it = root.entries();
      function next() {
        return it.next().then(function (r) {
          if (r.done) { return; }
          var n = r.value[0];
          if (n.indexOf('take-') === 0 && n !== keep) { root.removeEntry(n).catch(function () {}); }
          return next();
        });
      }
      return next();
    }).catch(function () {});
  }

  function startRecording() {
    if (!state.stream) { return; }
    var mime = pickMime();
    if (mime === null) { alert('Este navegador não suporta gravação de vídeo.'); return; }

    var ext = mime.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
    var id = stamp();
    state.fileName = 'teleprompter-' + id + '.' + ext;
    var opfsName = 'take-' + id + '.' + ext;

    el.rec.disabled = true;
    cleanupOldTakes(null);

    openDiskWriter(opfsName).then(function (disk) {
      var opts = { videoBitsPerSecond: videoBitrate(), audioBitsPerSecond: 256000 };
      if (mime) { opts.mimeType = mime; }

      try {
        state.recorder = new MediaRecorder(state.stream, opts);
      } catch (e) {
        state.recorder = new MediaRecorder(state.stream);
      }

      state.writer = disk;
      state.writeChain = Promise.resolve();
      state.chunks = [];

      state.recorder.ondataavailable = function (e) {
        if (!e.data || !e.data.size) { return; }
        if (state.writer) {
          var w = state.writer.writable, data = e.data;
          state.writeChain = state.writeChain.then(function () { return w.write(data); }).catch(function () {
            // se o disco falhar, continua em memória
            state.chunks.push(data);
          });
        } else {
          state.chunks.push(e.data);
        }
      };
      state.recorder.onstop = finishRecording;
      state.recorder.start(1000);

      state.startedAt = Date.now();
      el.rec.disabled = false;
      el.rec.classList.add('recording');
      el.rec.setAttribute('aria-label', 'Parar gravação');
      el.res.disabled = true;
      el.flip.disabled = true;
      tick();
      state.timer = setInterval(tick, 500);
    });
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') { state.recorder.stop(); }
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }

  function finishRecording() {
    var type = ((state.recorder && state.recorder.mimeType) || 'video/webm').split(';')[0];
    var name = state.fileName;
    var disk = state.writer;
    var memChunks = state.chunks;

    state.recorder = null;
    state.writer = null;
    state.chunks = [];
    clearInterval(state.timer);
    el.rec.classList.remove('recording');
    el.rec.setAttribute('aria-label', 'Gravar');
    el.res.disabled = false;
    el.flip.disabled = false;
    el.time.textContent = 'Salvando…';

    // espera o último pedaço ser escrito
    setTimeout(function () {
      state.writeChain.then(function () {
        if (disk && !memChunks.length) {
          return disk.writable.close().then(function () { return disk.handle.getFile(); }).then(function (file) {
            download(new Blob([file], { type: type }), name);
            cleanupOldTakes(disk.handle.name);
          });
        }
        var parts = memChunks;
        if (disk) {
          return disk.writable.close().then(function () { return disk.handle.getFile(); }).then(function (file) {
            download(new Blob([file].concat(parts), { type: type }), name);
          });
        }
        download(new Blob(parts, { type: type }), name);
      }).catch(function (err) {
        alert('Erro ao salvar o vídeo: ' + (err && err.message ? err.message : err));
      }).then(function () {
        el.time.textContent = '';
      });
    }, 300);
  }

  function tick() {
    var s = Math.floor((Date.now() - state.startedAt) / 1000);
    var m = Math.floor(s / 60);
    el.time.textContent = '● ' + (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  // Expõe estado para diagnóstico
  window.TPCam = { state: state, start: startCamera, stop: stopCamera, rec: startRecording, stopRec: stopRecording };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
