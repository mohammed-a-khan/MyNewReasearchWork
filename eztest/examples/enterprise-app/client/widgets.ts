/**
 * Sliders, masked inputs and drop zones: noUiSlider (MIT) and IMask (MIT)
 * for real, a WAI-ARIA slider, a plain drop zone (drag-and-drop events only)
 * and a Dropzone.js-style zone (hidden file input).
 */
import noUiSlider from 'nouislider';
import sliderCss from 'nouislider/dist/nouislider.css';
import IMask from 'imask';
import { ariaSlider, dropZone, dropzoneJs } from './emulated/aria.js';
import { h } from './emulated/dom.js';
import { log } from './page.js';

document.head.appendChild(h('style', {}, sliderCss));
const root = document.getElementById('root')!;
function section(title: string, id: string): HTMLElement {
  const host = h('div', { class: 'host', style: 'padding: 8px 24px' });
  root.appendChild(h('section', { 'aria-labelledby': `h-${id}` }, h('h2', { id: `h-${id}` }, title), host));
  return host;
}

const price = h('div', { style: 'width: 300px; margin: 20px 0' });
section('Price', 'price').appendChild(price);
const s1 = noUiSlider.create(price, { start: 10, step: 1, range: { min: 0, max: 100 }, keyboardSupport: true });
s1.on('change', (v) => log(`price=${String(v)}`));

const range = h('div', { style: 'width: 300px; margin: 20px 0' });
section('Price range', 'price-range').appendChild(range);
noUiSlider.create(range, { start: [20, 80], step: 5, connect: true, range: { min: 0, max: 100 }, keyboardSupport: true });

ariaSlider(section('Discount', 'discount'), 'Discount', 0, 50, 10, 5);

const card = h('input', { id: 'card', type: 'text', inputmode: 'numeric', placeholder: '0000 0000 0000 0000' }) as HTMLInputElement;
const cardHost = section('Payment', 'payment');
cardHost.appendChild(h('label', { for: 'card' }, 'Card number'));
cardHost.appendChild(card);
IMask(card, { mask: '0000 0000 0000 0000' });
const phone = h('input', { id: 'phone', type: 'tel', placeholder: '+1 (000) 000-0000' }) as HTMLInputElement;
cardHost.appendChild(h('label', { for: 'phone' }, 'Phone'));
cardHost.appendChild(phone);
IMask(phone, { mask: '+{1} (000) 000-0000' });

dropZone(section('Attachments', 'attachments'), 'Attachments');
dropzoneJs(section('Uploads', 'uploads'), 'Uploads');
