const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { module: { exports: {} }, require: () => ({ Plugin: class {}, PluginSettingTab: class {} }), console, Date };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
const { Timer, parseDuration, dragDuration, restore, appendRecord, parsePresets, t, setLang } = context.module.exports;
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const timer = (seconds = 60) => { const t = new Timer({ selected: seconds }); t.start(1000); return t; };
test('duration syntax and bounds', () => {
  for (const [input, result] of [['25',1500],['00:01',1],['05:30',330],['180',10800],['180:01',null],['0',null],['1:60',null],['abc',null],['-5',null],['',null]]) assert.equal(parseDuration(input),result);
});
test('pause and resume keep exact fractional seconds', () => {
  const t=timer();t.pause(2250);assert.equal(t.left(99000),58.75);t.resume(100000);assert.equal(t.left(101000),57.75);
});
test('multiple deadlines do not affect each other', () => {
  const a=timer(1),b=timer(300);assert.equal(a.tick(5000),true);assert.equal(b.tick(5000),false);assert.equal(b.left(5000),296);
});
test('sleep finishes exactly once', () => { const t=timer();assert.equal(t.tick(900000),true);assert.equal(t.tick(900001),false); });
test('extend running, paused, finished; preserve original restart duration', () => {
  const t=timer();t.extend(300,2000);assert.equal(t.left(2000),359);t.pause(3000);t.extend(60,5000);assert.equal(t.left(99999),418);
  t.resume(10000);t.tick(999999);t.extend(1800,1000000);assert.equal(t.left(1000000),1800);t.start(1000001);assert.equal(t.total,60);
});
test('extension never exceeds 180 minutes', () => { const t=timer(10800);t.extend(300,2000);assert.equal(t.total,10800);t.extend(-5,3000);assert.equal(t.total,10800); });
test('drag has bounded minute mapping', () => { assert.equal(dragDuration(0,30),600);assert.equal(dragDuration(60,-30),0);assert.equal(dragDuration(0,10000),10800); });
test('v1 active timer migrates without resetting deadline', () => {
  const t=timer(1500);const data=restore({timer:JSON.parse(JSON.stringify(t)),sound:false});assert.equal(data.timers.length,1);assert.equal(data.timers[0].left(11000),1490);assert.equal(data.sound,false);assert.equal(data.recent.seconds,1500);
});
test('v1 idle timer becomes recent preset, no idle ring', () => { const data=restore({timer:{selected:300,state:'idle'}});assert.equal(data.timers.length,0);assert.equal(data.recent.seconds,300); });
test('v2 reload preserves each timer and repairs duplicate IDs', () => {
  const a=timer(300),b=timer(900);b.pause(11000);const data=restore({timers:[{...a,id:'same'},{...b,id:'same'}],layout:'vertical'});
  assert.equal(data.timers[0].left(21000),280);assert.equal(data.timers[1].left(21000),890);assert.notEqual(data.timers[0].id,data.timers[1].id);assert.equal(data.layout,'vertical');
});
test('malformed storage is safe', () => { assert.equal(restore(null).timers.length,0);assert.equal(restore({timers:[null,42,{}]}).timers.length,0);assert.equal(new Timer(null).state,'idle'); });
test('stopwatch excludes pauses and persists elapsed time', () => {
  const t = new Timer({ mode: 'up' }); t.start(1000); t.pause(61000);
  assert.equal(t.elapsed(200000),60); t.resume(200000); t.finish(230000);
  assert.equal(t.elapsed(),90); assert.equal(new Timer({...t}).elapsed(),90);
});
test('next day adds previous subtotal; retries do not duplicate records', () => {
  const entry = (id,day,minutes) => ({id,name:'数学回顾:公式',minutes,endedAt:new Date(2026,8,day,12).getTime()});
  let text = appendRecord('',entry('one',20,250));
  text = appendRecord(text,entry('two',20,750));
  assert.equal(text.includes('累计用时'),false);
  text = appendRecord(text,entry('three',21,24));
  assert.ok(text.includes('- [x] 9.20累计用时: 1000分钟\n\n9.21'));
  assert.equal(appendRecord(text,entry('three',21,24)),text);
});
test('a finished stopwatch is dropped on load, a finished countdown is kept', () => {
  const data = restore({ timers: [{ id: 'u', mode: 'up', state: 'finished' }, { id: 'd', mode: 'down', state: 'finished' }, { id: 'r', mode: 'up', state: 'running' }] });
  assert.equal(data.timers.length, 2);
  assert.deepEqual(data.timers.map(t => t.mode), ['down', 'up']);
  assert.equal(data.timers[1].state, 'running');
});
test('preset text parses names, minutes and mm:ss; skips junk; caps at six', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parsePresets('休息一下=5, 番茄专注＝25；冥想:00:30, 坏的=abc, 25:00'))), [{seconds:300,name:'休息一下'},{seconds:1500,name:'番茄专注'},{seconds:30,name:'冥想'},{seconds:1500,name:'25 分钟'}]);
  assert.equal(parsePresets('a=1,b=2,c=3,d=4,e=5,f=6,g=7').length, 6);
  assert.equal(parsePresets('').length, 0);
});
test('new settings default safely and survive a round trip', () => {
  const fresh = restore({});
  assert.equal(fresh.presets, null); assert.equal(fresh.language, 'auto');
  assert.equal(fresh.statusBar, true); assert.equal(fresh.notify, true); assert.equal(fresh.lastMode, 'up');
  const saved = restore({ presets: [{ seconds: 600, name: '十分钟' }, { seconds: 0, name: 'bad' }, null], statusBar: false, notify: false, lastMode: 'down' });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.presets.map(p => p.name))), ['十分钟']);
  assert.equal(saved.statusBar, false); assert.equal(saved.notify, false); assert.equal(saved.lastMode, 'down');
});
test('4.2 saved Chinese defaults become language-following; custom presets are kept', () => {
  assert.equal(restore({ presets: [{ seconds: 300, name: '休息一下' }, { seconds: 1500, name: '番茄专注' }] }).presets, null);
  assert.equal(restore({ presets: [{ seconds: 300, name: '休息一下' }] }).presets.length, 1);
  assert.equal(restore({ language: 'en' }).language, 'en'); assert.equal(restore({ language: 'fr' }).language, 'auto');
});
test('strings switch language and fill placeholders; records stay Chinese', () => {
  setLang('en'); assert.equal(t('island.eyebrow'), "Time's up"); assert.equal(t('preview.end', { time: '10:00' }), 'Ends around 10:00');
  assert.ok(appendRecord('', { id: 'x', name: 'Read', minutes: 5, endedAt: new Date(2026, 9, 9).getTime() }).includes('Read 5分钟'));
  setLang('zh'); assert.equal(t('island.eyebrow'), '时间到了'); assert.equal(t('no.such.key'), 'no.such.key');
});
console.log(`${checks} checks passed`);
