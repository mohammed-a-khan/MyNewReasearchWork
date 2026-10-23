/**
 * Canvas charts: Chart.js (MIT) and Apache ECharts (Apache-2.0) for real,
 * exposed as the globals apps commonly have (window.Chart, window.echarts);
 * plus a Highcharts-style global (Highcharts is commercial: emulated), a
 * canvas chart with an accessible data table, and an opaque canvas.
 */
import Chart from 'chart.js/auto';
import * as echarts from 'echarts';
import { MONTHLY_REVENUE, MONTHS } from '../data.js';
import { highchartsLike, opaqueChart, tableChart } from './emulated/aria.js';
import { h } from './emulated/dom.js';

declare global {
  interface Window {
    Chart?: typeof Chart;
    echarts?: typeof echarts;
  }
}

window.Chart = Chart;
window.echarts = echarts;

const root = document.getElementById('root')!;
function section(title: string, id: string): HTMLElement {
  const host = h('div', { class: 'host' });
  root.appendChild(h('section', { 'aria-labelledby': `h-${id}` }, h('h2', { id: `h-${id}` }, title), host));
  return host;
}

const canvas = h('canvas', { width: 500, height: 200, role: 'img', 'aria-label': 'Revenue' }) as HTMLCanvasElement;
section('Revenue', 'revenue').appendChild(h('div', { style: 'width: 500px; height: 200px' }, canvas));
new Chart(canvas, {
  type: 'line',
  data: { labels: MONTHS, datasets: [{ label: '2026', data: MONTHLY_REVENUE }, { label: '2025', data: MONTHLY_REVENUE.map((v) => Math.round(v * 0.8)) }] },
  options: { animation: false, responsive: false },
});

const ec = h('div', { style: 'width: 500px; height: 220px', 'aria-label': 'Orders by region' });
section('Orders by region', 'by-region').appendChild(ec);
echarts.init(ec, undefined, { renderer: 'canvas' }).setOption({
  animation: false,
  xAxis: { type: 'category', data: ['EU', 'NA', 'APAC', 'LATAM'] },
  yAxis: { type: 'value' },
  series: [{ name: 'Orders', type: 'bar', data: [2527, 2490, 2510, 2473] }],
});

highchartsLike(section('Profit', 'profit'), 'Profit');
tableChart(section('Orders per month', 'orders-chart'), 'Orders per month');
opaqueChart(section('Traffic', 'traffic'), 'Traffic');
