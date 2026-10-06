/*!
 * Gaze Lab — общий core (shared/gaze-core.js)
 * Единая реализация heatmap-рендера, I-VT фиксации и AOI-анализа.
 * Используется index.html (live-трекинг) и future бэкендом/дашбордом.
 * Формат событий: { x, y, t } — экранные координаты (CSS px), время в мс от старта сессии.
 */
(function (global) {
  'use strict';

  /* ---------------- heatmap gradient ---------------- */
  var _gradientCache = null;
  function heatGradient() {
    if (_gradientCache) return _gradientCache;
    var c = document.createElement('canvas');
    c.width = 256; c.height = 1;
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0.00, '#0a3ea8');
    g.addColorStop(0.35, '#1fb6c9');
    g.addColorStop(0.60, '#7be05a');
    g.addColorStop(0.80, '#ffd23f');
    g.addColorStop(1.00, '#ff4d3d');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 1);
    var d = ctx.getImageData(0, 0, 256, 1).data;
    var arr = [];
    for (var i = 0; i < 256; i++) arr.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    _gradientCache = arr;
    return arr;
  }

  /**
   * Нарисовать тепловую карту gaze-событий поверх ctx (координаты ctx = пиксели области w×h).
   * Опции: { scale=автоматически до 900px, radius, intensity }
   */
  function drawHeatmap(ctx, events, w, h, opts) {
    opts = opts || {};
    if (!events.length) return;
    var scale = opts.scale || Math.min(1, 900 / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    var octx = off.getContext('2d');
    octx.globalCompositeOperation = 'lighter';
    octx.scale(scale, scale);
    var radius = opts.radius || Math.max(28, Math.min(w, h) * 0.06);
    var alpha = opts.intensity || 0.10;
    for (var i = 0; i < events.length; i++) {
      var p = events[i];
      if (p.x < -radius || p.y < -radius || p.x > w + radius || p.y > h + radius) continue;
      var grad = octx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, 'rgba(0,0,0,' + alpha + ')');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      octx.fillStyle = grad;
      octx.beginPath(); octx.arc(p.x, p.y, radius, 0, Math.PI * 2); octx.fill();
    }
    var img = octx.getImageData(0, 0, cw, ch);
    var data = img.data, stops = heatGradient();
    for (var k = 3; k < data.length; k += 4) {
      var a = data[k];
      if (a === 0) continue;
      var c2 = stops[Math.min(255, a)];
      data[k - 3] = c2[0]; data[k - 2] = c2[1]; data[k - 1] = c2[2];
      data[k] = Math.min(255, a + 70);
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cw, ch, 0, 0, w, h);
  }

  /* ---------------- fixation detection (I-VT) ---------------- */
  /**
   * Классический алгоритм I-VT: последовательные точки, скорость между которыми
   * ниже порога, сливаются в фиксацию; быстрые переходы — саккады.
   * Вход: события, отсортированные по t. Выход: [{x,y,tStart,duration,n}] — центр масс фиксации.
   */
  function detectFixations(events, opts) {
    opts = opts || {};
    // Порог подобран под вебкам-данные: при троттлинге 30мс микродрожание ±1px
    // даёт ~33px/s, поэтому порог должен быть выше этого шума (реальные саккады — сотни px/s)
    var velocityThreshold = opts.velocityThreshold || 60; // px/s (screen-space approximation)
    var minDuration = opts.minDurationMs || 100;
    var gapMs = opts.gapMs || 150;
    var dispersionFloor = opts.dispersionFloorPx != null ? opts.dispersionFloorPx : 2; // px: точки ближе к центру масс — всегда один кластер, независимо от dt
    if (events.length < 2) return [];

    function centroid(cl) {
      var sx = 0, sy = 0;
      for (var j = 0; j < cl.length; j++) { sx += cl[j].x; sy += cl[j].y; }
      return { x: sx / cl.length, y: sy / cl.length };
    }

    function pushCluster(cl, out) {
      if (cl.length === 0) return;
      // одиночная точка — вырожденная фиксация нулевой длительности
      if (cl.length === 1) {
        out.push({ x: cl[0].x, y: cl[0].y, tStart: cl[0].t, duration: 0, n: 1 });
        return;
      }
      var dur = cl[cl.length - 1].t - cl[0].t;
      if (dur < minDuration) return;
      var c = centroid(cl);
      out.push({ x: c.x, y: c.y, tStart: cl[0].t, duration: dur, n: cl.length });
    }

    var fixations = [];
    var cluster = [events[0]];
    for (var i = 1; i < events.length; i++) {
      var b = events[i];
      var last = cluster[cluster.length - 1];
      // разрыв в потоке сэмплов длиннее окна — это не одна непрерывная фиксация
      if (b.t - last.t > gapMs) {
        pushCluster(cluster, fixations);
        cluster = [b];
        continue;
      }
      var dt = Math.max(1, b.t - last.t);
      var c = centroid(cluster);
      // расстояние до центра масс кластера нормировано по времени: пороги в px/ms
      // физически корректнее, чем псевдоскорость px/s на троттлинге 30мс
      // (микродрожание ±1px давало бы ложные 33px/s и рвало одну фиксацию)
      var dist = Math.hypot(b.x - c.x, b.y - c.y);
      // дисперсионный допуск спасает фиксацию при коротких dt (шум веб-камеры),
      // порог скорости — при длинных (медленный дрейф взгляда = саккада)
      if (dist <= dispersionFloor || dist / dt < velocityThreshold / 1000) {
        cluster.push(b);
      } else {
        pushCluster(cluster, fixations);
        cluster = [b];
      }
    }
    pushCluster(cluster, fixations);
    return fixations;
  }

  /* ---------------- AOI analysis ---------------- */
  /**
   * aoiList: [{id, rect:{left,top,width,height}}] — в координатах той же системы, что и события.
   * Фиксации сопоставляются с AOI по центру масс. Возвращает список метрик,
   * отсортированный по dwell time (убыв.).
   */
  function analyzeAOI(fixations, aoiList) {
    var res = {};
    aoiList.forEach(function (a) {
      res[a.id] = { id: a.id, dwellMs: 0, count: 0, firstHitT: null };
    });
    fixations.forEach(function (f) {
      for (var i = 0; i < aoiList.length; i++) {
        var r = aoiList[i].rect;
        if (f.x >= r.left && f.x <= r.left + r.width &&
            f.y >= r.top && f.y <= r.top + r.height) {
          var s = res[aoiList[i].id];
          s.dwellMs += f.duration;
          s.count++;
          if (s.firstHitT === null) s.firstHitT = f.tStart;
        }
      }
    });
    return Object.keys(res).map(function (k) { return res[k]; })
      .sort(function (a, b) { return b.dwellMs - a.dwellMs; });
  }

  function rectFromEl(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  global.GazeCore = {
    heatGradient: heatGradient,
    drawHeatmap: drawHeatmap,
    detectFixations: detectFixations,
    analyzeAOI: analyzeAOI,
    rectFromEl: rectFromEl,
    version: '0.1.0'
  };
})(typeof window !== 'undefined' ? window : globalThis);
