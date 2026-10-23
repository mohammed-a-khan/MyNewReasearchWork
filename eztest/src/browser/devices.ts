/**
 * Device descriptors for emulation, built from the devices' published screen
 * specifications (CSS pixel resolution and pixel ratio). The viewport is the
 * screen minus a typical browser UI (address bar, toolbars); every phone and
 * tablet also has a "<name> landscape" entry.
 */
import type { DeviceDescriptor, ViewportSize } from './types.js';

const CHROME_MAJOR = '141';

function iosUA(kind: 'iPhone' | 'iPad', ios: string): string {
  const v = ios.replace(/\./g, '_');
  const platform = kind === 'iPhone' ? `iPhone; CPU iPhone OS ${v} like Mac OS X` : `iPad; CPU OS ${v} like Mac OS X`;
  return `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ios.split('.').slice(0, 2).join('.')} Mobile/15E148 Safari/604.1`;
}

function androidUA(model: string, android: string, mobile = true): string {
  return `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 ${mobile ? 'Mobile ' : ''}Safari/537.36`;
}

interface Spec {
  name: string;
  /** Screen size in CSS px, portrait. */
  screen: ViewportSize;
  dpr: number;
  ua: string;
  kind: 'iphone' | 'ipad' | 'android-phone' | 'android-tablet';
}

const SPECS: Spec[] = [
  { name: 'iPhone SE', screen: { width: 375, height: 667 }, dpr: 2, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 8', screen: { width: 375, height: 667 }, dpr: 2, ua: iosUA('iPhone', '16.0'), kind: 'iphone' },
  { name: 'iPhone 8 Plus', screen: { width: 414, height: 736 }, dpr: 3, ua: iosUA('iPhone', '16.0'), kind: 'iphone' },
  { name: 'iPhone X', screen: { width: 375, height: 812 }, dpr: 3, ua: iosUA('iPhone', '16.0'), kind: 'iphone' },
  { name: 'iPhone XR', screen: { width: 414, height: 896 }, dpr: 2, ua: iosUA('iPhone', '16.0'), kind: 'iphone' },
  { name: 'iPhone 11', screen: { width: 414, height: 896 }, dpr: 2, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 11 Pro', screen: { width: 375, height: 812 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 11 Pro Max', screen: { width: 414, height: 896 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 12', screen: { width: 390, height: 844 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 12 Mini', screen: { width: 375, height: 812 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 12 Pro', screen: { width: 390, height: 844 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 12 Pro Max', screen: { width: 428, height: 926 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 13', screen: { width: 390, height: 844 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 13 Mini', screen: { width: 375, height: 812 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 13 Pro', screen: { width: 390, height: 844 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 13 Pro Max', screen: { width: 428, height: 926 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 14', screen: { width: 390, height: 844 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 14 Plus', screen: { width: 428, height: 926 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 14 Pro', screen: { width: 393, height: 852 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 14 Pro Max', screen: { width: 430, height: 932 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 15', screen: { width: 393, height: 852 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 15 Plus', screen: { width: 430, height: 932 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 15 Pro', screen: { width: 393, height: 852 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPhone 15 Pro Max', screen: { width: 430, height: 932 }, dpr: 3, ua: iosUA('iPhone', '17.0'), kind: 'iphone' },
  { name: 'iPad (gen 7)', screen: { width: 810, height: 1080 }, dpr: 2, ua: iosUA('iPad', '16.0'), kind: 'ipad' },
  { name: 'iPad Mini', screen: { width: 768, height: 1024 }, dpr: 2, ua: iosUA('iPad', '16.0'), kind: 'ipad' },
  { name: 'iPad Air', screen: { width: 820, height: 1180 }, dpr: 2, ua: iosUA('iPad', '17.0'), kind: 'ipad' },
  { name: 'iPad Pro 11', screen: { width: 834, height: 1194 }, dpr: 2, ua: iosUA('iPad', '17.0'), kind: 'ipad' },
  { name: 'Pixel 4', screen: { width: 353, height: 745 }, dpr: 3, ua: androidUA('Pixel 4', '12'), kind: 'android-phone' },
  { name: 'Pixel 5', screen: { width: 393, height: 851 }, dpr: 2.75, ua: androidUA('Pixel 5', '13'), kind: 'android-phone' },
  { name: 'Pixel 7', screen: { width: 412, height: 915 }, dpr: 2.625, ua: androidUA('Pixel 7', '14'), kind: 'android-phone' },
  { name: 'Pixel 8', screen: { width: 412, height: 915 }, dpr: 2.625, ua: androidUA('Pixel 8', '14'), kind: 'android-phone' },
  { name: 'Galaxy S8', screen: { width: 360, height: 740 }, dpr: 3, ua: androidUA('SM-G950U', '9'), kind: 'android-phone' },
  { name: 'Galaxy S9+', screen: { width: 320, height: 658 }, dpr: 4.5, ua: androidUA('SM-G965U', '10'), kind: 'android-phone' },
  { name: 'Galaxy S20', screen: { width: 360, height: 800 }, dpr: 3, ua: androidUA('SM-G981B', '13'), kind: 'android-phone' },
  { name: 'Galaxy S23', screen: { width: 360, height: 780 }, dpr: 3, ua: androidUA('SM-S911B', '14'), kind: 'android-phone' },
  { name: 'Galaxy A55', screen: { width: 384, height: 832 }, dpr: 2.8125, ua: androidUA('SM-A556B', '14'), kind: 'android-phone' },
  { name: 'Moto G4', screen: { width: 360, height: 640 }, dpr: 3, ua: androidUA('Moto G (4)', '7.0'), kind: 'android-phone' },
  { name: 'Nexus 5', screen: { width: 360, height: 640 }, dpr: 3, ua: androidUA('Nexus 5', '6.0'), kind: 'android-phone' },
  { name: 'Nexus 7', screen: { width: 600, height: 960 }, dpr: 2, ua: androidUA('Nexus 7', '6.0', false), kind: 'android-tablet' },
  { name: 'Galaxy Tab S4', screen: { width: 712, height: 1138 }, dpr: 2.25, ua: androidUA('SM-T837A', '10', false), kind: 'android-tablet' },
  { name: 'Galaxy Tab S9', screen: { width: 800, height: 1280 }, dpr: 2, ua: androidUA('SM-X710', '14', false), kind: 'android-tablet' },
];

/** Space the browser UI takes, portrait / landscape (CSS px). */
const UI: Record<Spec['kind'], { portrait: number; landscape: number }> = {
  iphone: { portrait: 180, landscape: 100 },
  ipad: { portrait: 70, landscape: 70 },
  'android-phone': { portrait: 110, landscape: 60 },
  'android-tablet': { portrait: 80, landscape: 80 },
};

function build(): Record<string, DeviceDescriptor> {
  const out: Record<string, DeviceDescriptor> = {};
  for (const s of SPECS) {
    const browser = s.kind === 'iphone' || s.kind === 'ipad' ? 'webkit' : 'chromium';
    const ui = UI[s.kind];
    out[s.name] = {
      userAgent: s.ua,
      screen: { ...s.screen },
      viewport: { width: s.screen.width, height: s.screen.height - ui.portrait },
      deviceScaleFactor: s.dpr,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: browser,
    };
    out[`${s.name} landscape`] = {
      userAgent: s.ua,
      screen: { width: s.screen.height, height: s.screen.width },
      viewport: { width: s.screen.height, height: s.screen.width - ui.landscape },
      deviceScaleFactor: s.dpr,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: browser,
    };
  }
  const desktop = (name: string, ua: string, browser: DeviceDescriptor['defaultBrowserType'], dpr = 1) => {
    out[name] = {
      userAgent: ua,
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: dpr,
      isMobile: false,
      hasTouch: false,
      defaultBrowserType: browser,
    };
  };
  const chromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
  desktop('Desktop Chrome', chromeUA, 'chromium');
  desktop('Desktop Chrome HiDPI', chromeUA, 'chromium', 2);
  desktop('Desktop Edge', `${chromeUA} Edg/${CHROME_MAJOR}.0.0.0`, 'chromium');
  desktop('Desktop Edge HiDPI', `${chromeUA} Edg/${CHROME_MAJOR}.0.0.0`, 'chromium', 2);
  desktop('Desktop Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 'firefox');
  desktop('Desktop Firefox HiDPI', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 'firefox', 2);
  desktop('Desktop Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'webkit', 2);
  return out;
}

/** Device descriptors by name ("iPhone 13", "Pixel 7 landscape", "Desktop Chrome" ...). */
export const devices: Record<string, DeviceDescriptor> = build();
