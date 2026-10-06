/* Unit-тесты чистых функций GazeCore (без DOM): I-VT и AOI. Запуск: node test/gaze-core.test.js */
'use strict';

// Стаб для canvas-функций не нужен — тестируем только аналитику.
global.document = { createElement: function () { throw new Error('DOM в unit-тестах недоступен'); } };
require('../shared/gaze-core.js');
const { detectFixations, analyzeAOI } = globalThis.GazeCore;

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  - ' + name); }
  else { failed++; console.error('FAIL  - ' + name); }
}

console.log('detectFixations (I-VT):');
{
  // неподвижный взгляд 500мс -> одна фиксация
  const ev = [];
  for (let t = 0; t <= 500; t += 33) ev.push({ x: 100 + (t % 2), y: 200, t });
  const f = detectFixations(ev);
  assert(f.length === 1, 'неподвижный поток -> 1 фиксация');
  assert(Math.abs(f[0].x - 100.5) < 5 && f[0].duration >= 400, 'центр масс и длительность корректны');
}
{
  // саккада: быстрый прыжок 100->800 за 16мс разрывает кластер
  const ev = [];
  for (let t = 0; t <= 300; t += 33) ev.push({ x: 100, y: 100, t });
  for (let t = 320; t <= 620; t += 33) ev.push({ x: 800, y: 100, t });
  const f = detectFixations(ev);
  assert(f.length === 2, 'две области покоя -> 2 фиксации');
  assert(f[0].x < 200 && f[1].x > 700, 'фиксации в правильных кластерах');
}
{
  // слишком короткий кластер (< minDurationMs) отбрасывается
  const ev = [{ x: 0, y: 0, t: 0 }, { x: 1, y: 0, t: 20 }];
  assert(detectFixations(ev).length === 0, 'кластер <100мс отбрасывается');
  assert(detectFixations([]).length === 0 && detectFixations([{x:1,y:1,t:0}]).length === 0, 'пустой/одиночный вход без падений');
}

console.log('analyzeAOI:');
{
  const aois = [
    { id: 'cta', rect: { left: 50, top: 50, width: 100, height: 40 } },
    { id: 'hero', rect: { left: 0, top: 0, width: 300, height: 300 } },
  ];
  const fix = [
    { x: 80, y: 60, tStart: 0, duration: 200, n: 5 },     // cta+hero
    { x: 200, y: 200, tStart: 500, duration: 300, n: 8 }, // hero
    { x: 900, y: 900, tStart: 1000, duration: 150, n: 3 },// мимо
  ];
  const r = analyzeAOI(fix, aois);
  const hero = r.find(a => a.id === 'hero'), cta = r.find(a => a.id === 'cta');
  assert(hero.dwellMs === 500 && hero.count === 2, 'hero: dwell=500ms, count=2');
  assert(cta.dwellMs === 200 && cta.firstHitT === 0, 'cta: dwell=200ms, TTFB=0');
  assert(r[0].id === 'hero', 'сортировка по dwell (убыв.)');
  assert(analyzeAOI([], aois).every(a => a.dwellMs === 0), 'пустые фиксации -> нули');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
