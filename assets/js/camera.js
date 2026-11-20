/**
 * Câmera + gravação (até 4K) para o Teleprompter
 */
(function () {
  'use strict';

  var RES = {
    '4k':    { w: 3840, h: 2160, bps: 25000000, label: '4K' },
    '1080p': { w: 1920, h: 1080, bps: 10000000, label: '1080p' },
    '720p':  { w: 1280, h: 720,  bps: 5000000,  label: '720p' }
  };

  var state = {
    stream: null,
    facing: load('tp_cam_facing', 'user'),
    res: load('tp_cam_res', '4k'),
    opacity: parseFloat(load('tp_cam_opacity', '0.45')),
    recorder: null,
    chunks: [],
    startedAt: 0,
    timer: null
  };

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

    // Impede que o espaço/setas dos controles da câmera acionem o teleprompter
    el.panel.addEventListener('keydown', function (e) { e.stopPropagation(); });
  }

  function applyOpacity() {
    // opacidade = quanto do vídeo aparece; o resto é escurecido para o texto ficar legível
    el.shade.style.opacity = String(1 - state.opacity);
  }

  function stopTracks() {
    if (state.stream) { state.stream.getTracks().forEach(function (t) { t.stop(); }); }
    state.stream = null;
  }

  function startCamera() {
    stopTracks();
    var r = RES[state.res];
    var constraints = {
      video: {
        facingMode: state.facing,
        width: { ideal: r.w },
        height: { ideal: r.h },
        frameRate: { ideal: 30 }
      },
      audio: { echoCancellation: true, noiseSuppression: true }
    };

    return navigator.mediaDevices.getUserMedia(constraints).catch(function () {
      // Alguns aparelhos recusam com áudio/resolução; tenta só o básico
      constraints.video = { facingMode: state.facing, width: { ideal: r.w }, height: { ideal: r.h } };
      return navigator.mediaDevices.getUserMedia(constraints);
    }).then(function (stream) {
      state.stream = stream;
      el.video.srcObject = stream;
      el.video.classList.toggle('mirror', state.facing === 'user');
      document.body.classList.add('cam-on');
      el.toggle.classList.add('active');
      el.panel.hidden = false;
      return el.video.play();
    }).then(function () {
      var s = state.stream.getVideoTracks()[0].getSettings();
      var w = s.width || el.video.videoWidth, h = s.height || el.video.videoHeight;
      var big = Math.max(w, h), small = Math.min(w, h);
      var name = big >= 3840 ? '4K' : big >= 1920 ? '1080p' : big >= 1280 ? '720p' : small + 'p';
      el.info.textContent = name + ' · ' + w + '×' + h + (s.frameRate ? ' · ' + Math.round(s.frameRate) + 'fps' : '');
      if (state.res === '4k' && big < 3840) {
        el.info.textContent += ' (esta câmera não faz 4K)';
      }
    }).catch(function (err) {
      alert('Não foi possível abrir a câmera: ' + (err && err.message ? err.message : err) +
        '\n\nPermita o acesso à câmera e ao microfone para este site.');
      stopCamera();
    });
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
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
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

  function startRecording() {
    if (!state.stream) { return; }
    var mime = pickMime();
    if (mime === null) { alert('Este navegador não suporta gravação de vídeo.'); return; }

    var opts = { videoBitsPerSecond: RES[state.res].bps, audioBitsPerSecond: 192000 };
    if (mime) { opts.mimeType = mime; }

    try {
      state.recorder = new MediaRecorder(state.stream, opts);
    } catch (e) {
      state.recorder = new MediaRecorder(state.stream);
    }

    state.chunks = [];
    state.recorder.ondataavailable = function (e) { if (e.data && e.data.size) { state.chunks.push(e.data); } };
    state.recorder.onstop = finishRecording;
    state.recorder.start(1000);

    state.startedAt = Date.now();
    el.rec.classList.add('recording');
    el.rec.setAttribute('aria-label', 'Parar gravação');
    el.res.disabled = true;
    el.flip.disabled = true;
    tick();
    state.timer = setInterval(tick, 500);
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') { state.recorder.stop(); }
  }

  function finishRecording() {
    var type = (state.recorder && state.recorder.mimeType) || 'video/webm';
    var ext = type.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
    var blob = new Blob(state.chunks, { type: type.split(';')[0] });
    state.recorder = null;
    state.chunks = [];
    clearInterval(state.timer);
    el.rec.classList.remove('recording');
    el.rec.setAttribute('aria-label', 'Gravar');
    el.res.disabled = false;
    el.flip.disabled = false;
    el.time.textContent = '';

    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var name = 'teleprompter-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext;

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function tick() {
    var s = Math.floor((Date.now() - state.startedAt) / 1000);
    var m = Math.floor(s / 60);
    el.time.textContent = (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
