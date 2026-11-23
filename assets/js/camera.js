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

    el.meter = $('cam-meter-bar');
    el.audio = $('cam-audio');
    el.audio.value = audio.mode;
    el.audio.addEventListener('change', function () {
      audio.mode = el.audio.value; save('tp_cam_audio', audio.mode);
      if (!state.stream || state.recorder) { return; }
      var mic = state.stream.getAudioTracks()[0];
      var p = mic ? mic.applyConstraints({ noiseSuppression: audio.mode === 'radio', echoCancellation: false, autoGainControl: false }).catch(function () {}) : Promise.resolve();
      p.then(function () { buildAudio(state.stream); showInfo(); });
    });

    el.fps30 = $('cam-fps30');
    el.fps30.checked = fps.on;
    el.fps30.addEventListener('change', function () {
      fps.on = el.fps30.checked; save('tp_cam_fps30', fps.on ? '1' : '0');
      if (!fps.on && fps.manual) { setAutoExposure().then(showInfo); }
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
    teardownAudio();
  }

  /**
   * Áudio
   * 'radio'   = voz de rádio: redução de ruído do Android + filtro de graves, corte de "embolado",
   *             presença, compressor, ganho e limitador (voz alta, clara e sem estourar)
   * 'natural' = microfone sem redução de ruído, só filtro de graves, compressão leve e limitador
   */
  var audio = { mode: load('tp_cam_audio', 'radio'), ctx: null, nodes: null, track: null, meterTimer: null };
  if (audio.mode !== 'radio' && audio.mode !== 'natural') { audio.mode = 'radio'; }

  function audioConstraints() {
    var ns = audio.mode === 'radio';
    return {
      echoCancellation: false,
      noiseSuppression: ns,
      autoGainControl: false,
      sampleRate: { ideal: 48000 },
      channelCount: { ideal: 1 }
    };
  }

  function getAudioCtx() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return null; }
    if (!audio.ctx || audio.ctx.state === 'closed') {
      try { audio.ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); } catch (e) { audio.ctx = new AC(); }
    }
    if (audio.ctx.state === 'suspended') { audio.ctx.resume(); }
    return audio.ctx;
  }

  function biquad(ctx, type, freq, gain, q) {
    var f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    if (gain !== undefined) { f.gain.value = gain; }
    if (q !== undefined) { f.Q.value = q; }
    return f;
  }

  function compressor(ctx, threshold, ratio, attack, release, knee) {
    var c = ctx.createDynamicsCompressor();
    c.threshold.value = threshold; c.ratio.value = ratio;
    c.attack.value = attack; c.release.value = release; c.knee.value = knee;
    return c;
  }

  function teardownAudio() {
    if (audio.meterTimer) { clearInterval(audio.meterTimer); audio.meterTimer = null; }
    if (audio.nodes) { audio.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} }); }
    audio.nodes = null;
    if (audio.track) { try { audio.track.stop(); } catch (e) {} }
    audio.track = null;
    if (el.meter) { el.meter.style.width = '0%'; }
  }

  // Monta a cadeia de tratamento de voz e devolve a faixa de áudio processada
  function buildAudio(stream) {
    teardownAudio();
    var mic = stream.getAudioTracks()[0];
    var ctx = mic && getAudioCtx();
    if (!ctx) { return mic || null; }

    var src = ctx.createMediaStreamSource(new MediaStream([mic]));
    var chain;
    if (audio.mode === 'radio') {
      // mesma receita do VOZ_RADIO do editor de vídeo
      var pre = ctx.createGain(); pre.gain.value = 0.5;  // -6 dB: o microfone do tablet chega quente demais
      var makeup = ctx.createGain(); makeup.gain.value = 1.6; // +4 dB
      chain = [
        pre,
        biquad(ctx, 'highpass', 90, undefined, 0.7),     // tira ronco/batida na mesa
        biquad(ctx, 'peaking', 200, -3, 1.4),            // tira o "embolado"
        biquad(ctx, 'peaking', 420, -3.5, 1.2),          // tira som de caixa/sala
        biquad(ctx, 'peaking', 2600, 5, 1.2),            // presença
        biquad(ctx, 'peaking', 4500, 3, 1.4),            // clareza
        biquad(ctx, 'highshelf', 7500, 4),               // brilho de rádio
        compressor(ctx, -21, 4, 0.005, 0.08, 6),         // segura a dinâmica
        makeup,
        compressor(ctx, -1.5, 20, 0.001, 0.05, 0)        // limitador: nunca estoura
      ];
    } else {
      var preN = ctx.createGain(); preN.gain.value = 0.6;
      chain = [
        preN,
        biquad(ctx, 'highpass', 80, undefined, 0.7),
        biquad(ctx, 'peaking', 250, -2, 1.2),
        compressor(ctx, -20, 2.5, 0.01, 0.2, 10),
        compressor(ctx, -1.5, 20, 0.001, 0.05, 0)
      ];
    }

    var analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    var dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;

    var prev = src;
    chain.forEach(function (n) { prev.connect(n); prev = n; });
    prev.connect(analyser);
    prev.connect(dest);

    audio.nodes = [src].concat(chain, [analyser, dest]);
    audio.track = dest.stream.getAudioTracks()[0];

    // medidor de nível
    var buf = new Float32Array(analyser.fftSize);
    audio.meterTimer = setInterval(function () {
      if (!el.meter) { return; }
      analyser.getFloatTimeDomainData(buf);
      var peak = 0;
      for (var i = 0; i < buf.length; i++) { var a = Math.abs(buf[i]); if (a > peak) { peak = a; } }
      var db = 20 * Math.log10(peak || 1e-6);
      var pct = Math.max(0, Math.min(100, (db + 50) * 2));
      el.meter.style.width = pct + '%';
      el.meter.style.background = db > -3 ? '#e33' : db > -12 ? '#fc3' : '#3c6';
    }, 80);

    return audio.track;
  }

  // Stream que vai para o gravador: vídeo da câmera + áudio tratado
  function recordStream() {
    var v = state.stream.getVideoTracks();
    var a = audio.track ? [audio.track] : state.stream.getAudioTracks();
    return new MediaStream(v.concat(a));
  }

  function getMedia() {
    var big = MODES[state.res].list[0];
    var v = { facingMode: state.facing, width: { ideal: big[0] }, height: { ideal: big[1] }, frameRate: { ideal: 30 } };
    return navigator.mediaDevices.getUserMedia({ video: v, audio: audioConstraints() }).catch(function () {
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
    stopFpsLoop();
    stopTracks();
    el.info.textContent = 'Abrindo câmera…';

    return getMedia().then(function (stream) {
      state.stream = stream;
      var vt = stream.getVideoTracks()[0];
      try { vt.contentHint = 'detail'; } catch (e) {}
      return pickBestMode(vt);
    }).then(function () {
      buildAudio(state.stream);
      el.video.srcObject = state.stream;
      el.video.classList.toggle('mirror', state.facing === 'user');
      document.body.classList.add('cam-on');
      el.toggle.classList.add('active');
      el.panel.hidden = false;
      return el.video.play();
    }).then(function () {
      showInfo();
      startFpsLoop();
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
    if (fps.manual) { txt += ' · 30fps fixo (pouca luz)'; }
    el.info.textContent = txt;
  }

  /**
   * 30 fps fixo: em pouca luz o automático alonga a exposição e o vídeo cai para 13–20 fps.
   * Aqui fixamos a exposição em 1/30 s e ajustamos o ISO medindo o brilho real da imagem.
   */
  var fps = { on: load('tp_cam_fps30', '1') === '1', manual: false, target: 0, iso: 400, timer: null, busy: false };

  function frameLuma() {
    try {
      var c = fps.canvas || (fps.canvas = document.createElement('canvas'));
      c.width = 64; c.height = 36;
      var g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(el.video, 0, 0, 64, 36);
      var d = g.getImageData(0, 0, 64, 36).data, s = 0;
      for (var i = 0; i < d.length; i += 4) { s += (d[i] + d[i + 1] + d[i + 2]) / 3; }
      return s / (d.length / 4);
    } catch (e) { return 0; }
  }

  function measureFps(ms) {
    return new Promise(function (resolve) {
      var v = el.video;
      if (!v.requestVideoFrameCallback) { resolve(30); return; }
      var n = 0, t0 = performance.now();
      function f() { n++; if (performance.now() - t0 < ms) { v.requestVideoFrameCallback(f); } else { resolve(n * 1000 / ms); } }
      v.requestVideoFrameCallback(f);
    });
  }

  function videoTrack() { return state.stream && state.stream.getVideoTracks()[0]; }

  function setAutoExposure() {
    var t = videoTrack();
    fps.manual = false;
    if (t) { return t.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }).catch(function () {}); }
    return Promise.resolve();
  }

  function fpsStep() {
    var t = videoTrack();
    if (!t || fps.busy || !fps.on || el.video.readyState < 2) { return; }
    var caps = t.getCapabilities ? t.getCapabilities() : {};
    if (!caps.exposureTime || !caps.iso || !caps.exposureMode || caps.exposureMode.indexOf('manual') === -1) { return; }
    var s = t.getSettings();
    if ((s.frameRate || 30) < 29) { return; } // modo de alta resolução: câmera não chega a 30

    fps.busy = true;
    var p;
    if (!fps.manual) {
      p = measureFps(1000).then(function (real) {
        if (real >= 26) { return; }
        fps.target = frameLuma();
        fps.iso = Math.min(caps.iso.max, Math.max(caps.iso.min, 800));
        fps.manual = true;
        return t.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: 330, iso: Math.round(fps.iso) }] });
      });
    } else {
      var l = frameLuma();
      if (l > 0 && fps.target > 0) {
        if (fps.iso <= caps.iso.min + 1 && l > fps.target * 1.15) {
          // ficou claro: volta ao automático
          p = setAutoExposure();
        } else if (Math.abs(l - fps.target) > fps.target * 0.05) {
          var k = Math.min(1.6, Math.max(0.6, fps.target / Math.max(l, 2)));
          fps.iso = Math.min(caps.iso.max, Math.max(caps.iso.min, fps.iso * k));
          p = t.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: 330, iso: Math.round(fps.iso) }] });
        }
      }
    }
    Promise.resolve(p).catch(function () {}).then(function () {
      fps.busy = false;
      showInfo();
    });
  }

  function startFpsLoop() {
    stopFpsLoop();
    fps.manual = false;
    fps.timer = setInterval(fpsStep, 700);
  }

  function stopFpsLoop() {
    if (fps.timer) { clearInterval(fps.timer); fps.timer = null; }
  }

  function stopCamera() {
    stopFpsLoop();
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
        state.recorder = new MediaRecorder(recordStream(), opts);
      } catch (e) {
        state.recorder = new MediaRecorder(recordStream());
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
  window.TPCam = { state: state, fps: fps, audio: audio, start: startCamera, stop: stopCamera, rec: startRecording, stopRec: stopRecording };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
