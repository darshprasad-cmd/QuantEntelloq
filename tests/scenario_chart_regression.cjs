// Exercise the production navigation/calculation/resize functions without a browser dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Production function boundaries are present');
  return source.slice(a, b);
}
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, value: '', textContent: '', innerHTML: '', style: {}, offsetWidth: 900,
    classList: { add() {}, remove() {}, contains() { return false; } }
  });
  return elements.get(id);
}
const values = { 'sc-invest': '25000', 'sc-monthly': '125', 'sc-return': '7',
  'sc-years': '8', 'sc-fee': '0.4', 'sc-inflation': '2', 'sc-tax': '15', 'sc-benchmark': '6' };
Object.entries(values).forEach(([id, value]) => element(id).value = value);
const charts = [], timers = [], events = {};
const context = vm.createContext({
  document: { getElementById: element, querySelectorAll: () => [],
    querySelector: () => null, documentElement: {}, body: {} },
  window: { scrollTo() {}, addEventListener(name, fn) { events[name] = fn; } },
  state: { currentPage: '' }, _qzComingSoon: {}, _qzSyncSectionChrome() {},
  setTimeout(fn) { timers.push(fn); }, ResizeObserver: class { observe() {} },
  LightweightCharts: { createChart() {
    const chart = { series: [], removed: false, remove() { this.removed = true; },
      addAreaSeries() { const s = { setData(data) { this.data = data; } }; this.series.push(s); return s; },
      addLineSeries() { return this.addAreaSeries(); },
      timeScale() { return { fitContent() {} }; }, applyOptions() {} };
    charts.push(chart); return chart;
  } }
});
vm.runInContext(section('function showPage(', '// ==================== V2 SECTION NAV'), context);
vm.runInContext(section('function calcScenario()', '// --- Crisis scenarios ---'), context);
vm.runInContext(section("window.addEventListener('resize', () => {\n  if(state.currentPage", '// ==================== LANDING PAGE CHARTS'), context);
const flush = () => { while (timers.length) timers.shift()(); };
const series = () => charts.at(-1).series[0].data;
const snapshot = () => JSON.stringify(series());

context.showPage('scenario'); flush();
assert.equal(charts.length, 1, 'Initial navigation renders a chart');
assert.equal(series().length, 9, 'The entered eight-year horizon is retained');
assert.equal(series()[0].value, 25000, 'The entered investment is retained');
const initial = snapshot();

context.showPage('portfolio'); context.showPage('scenario'); flush();
assert.equal(snapshot(), initial, 'Returning to the page keeps the same projection');
assert.equal(charts.at(-2).removed, true, 'The previous chart is disposed when redrawn');

element('scenario-chart').offsetWidth = 390;
events.resize();
assert.equal(snapshot(), initial, 'Resizing retains the plotted projection');
Object.entries(values).forEach(([id, value]) => assert.equal(element(id).value, value));

element('sc-monthly').value = '300';
context.calcScenario();
assert.ok(series().at(-1).value > JSON.parse(initial).at(-1).value, 'Input changes update the plotted projection');
const changed = snapshot();
events.resize();
assert.equal(snapshot(), changed, 'Resizing preserves the updated projection');
console.log('Scenario chart navigation, return, resize and input regressions passed.');
