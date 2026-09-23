import { chromium } from 'playwright';
import { mkdir, rename, copyFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { toMp4, durationMs } from './video.mjs';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const TITLE_CARD_MS = 2000;
const VERDICT_CARD_MS = 2500;
const LOGIN_TIMEOUT_MS = 20_000;
const LOAD_CAP_MS = 3000;
const DOM_QUIET_MS = 300;
const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_PASSES = 4;
const HIGHLIGHT_HOLD_MS = 700;
const MASK = '••••••••';

/** Thrown when an element ref stopped resolving because the page changed under the action. */
export class StaleRefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleRefError';
    this.code = 'stale_ref';
  }
}

/** Renders (and persists) the recorded overlay. Runs inside the page: no outer references. */
function renderOverlay(patch) {
  const KEY = '__aqa_overlay_state';
  let state = {};
  try { state = JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { state = {}; }
  if (patch && typeof patch === 'object') for (const key of Object.keys(patch)) state[key] = patch[key];
  try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* opaque origin */ }
  const doc = document;
  if (!doc.documentElement) return false;
  const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
  let root = doc.getElementById('__aqa_overlay');
  if (!root) {
    root = doc.createElement('div');
    root.id = '__aqa_overlay';
    root.setAttribute('data-aqa-overlay', '1');
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;';
  }
  if (root.parentNode !== doc.documentElement) doc.documentElement.appendChild(root);
  const ensure = (id, css) => {
    let el = doc.getElementById(id);
    if (!el) {
      el = doc.createElement('div');
      el.id = id;
      el.setAttribute('data-aqa-overlay', '1');
      root.appendChild(el);
    }
    el.style.cssText = css;
    return el;
  };
  const drop = id => { const el = doc.getElementById(id); if (el) el.remove(); };
  const card = (id, background, lines) => {
    const el = ensure(id, `position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;padding:56px;` +
      `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;` +
      `background:${background};color:#ffffff;font:600 26px/1.35 ${FONT};text-align:center;`);
    el.textContent = '';
    for (const line of lines) {
      if (!line || !line.text) continue;
      const row = doc.createElement('div');
      row.style.cssText = line.css;
      row.textContent = line.text;
      el.appendChild(row);
    }
    root.appendChild(el); // full-screen cards always sit above the caption and the checklist
    return el;
  };
  const checks = Array.isArray(state.expectations) ? state.expectations.filter(Boolean) : null;
  const score = value => (Number.isFinite(value) ? value.toFixed(2) : '–');
  const checkRow = (item, palette) => {
    const row = doc.createElement('div');
    const met = Boolean(item.met);
    row.style.cssText = `color:${met ? palette.met : palette.unmet};white-space:normal;overflow-wrap:anywhere;`;
    row.textContent = `${met ? '✓' : '✗'} ${score(item.p)} ${item.statement || ''}`.trim();
    return row;
  };

  if (state.caption) {
    const bar = ensure('__aqa_caption', `position:absolute;left:0;right:0;bottom:0;box-sizing:border-box;` +
      `padding:16px 24px;background:rgba(10,12,18,0.88);border-top:3px solid #4da3ff;color:#f4f7fb;` +
      `font:600 20px/1.4 ${FONT};letter-spacing:0.2px;text-shadow:0 1px 2px rgba(0,0,0,0.65);` +
      `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`);
    bar.textContent = state.caption;
  } else drop('__aqa_caption');

  let target = null;
  if (state.highlightRef) {
    try { target = doc.querySelector(`[data-aqa-ref="${state.highlightRef}"]`); } catch { target = null; }
  }
  if (target) {
    const r = target.getBoundingClientRect();
    ensure('__aqa_highlight', `position:absolute;left:${Math.round(r.left - 4)}px;top:${Math.round(r.top - 4)}px;` +
      `width:${Math.round(r.width + 8)}px;height:${Math.round(r.height + 8)}px;border:3px solid #ff3d71;` +
      `border-radius:6px;box-shadow:0 0 0 3px rgba(255,61,113,0.28);box-sizing:border-box;`);
  } else drop('__aqa_highlight');

  if (checks && checks.length) {
    const panel = ensure('__aqa_checks', `position:absolute;top:16px;right:16px;max-width:420px;max-height:70%;` +
      `box-sizing:border-box;padding:12px 14px;overflow:hidden;background:rgba(10,12,18,0.86);` +
      `border:1px solid rgba(255,255,255,0.18);border-radius:10px;color:#f4f7fb;` +
      `font:600 16px/1.35 ${FONT};text-align:left;display:flex;flex-direction:column;gap:7px;` +
      `text-shadow:0 1px 2px rgba(0,0,0,0.65);`);
    panel.textContent = '';
    for (const item of checks) panel.appendChild(checkRow(item, { met: '#6ee7a0', unmet: '#ff8fa8' }));
  } else drop('__aqa_checks');

  if (state.title) {
    const t = state.title;
    card('__aqa_title', 'linear-gradient(150deg,#0b1220 0%,#16233c 60%,#1d3157 100%)', [
      { text: 'auto-qa', css: `font:700 20px/1 ${FONT};letter-spacing:6px;text-transform:uppercase;color:#4da3ff;` },
      { text: t.task, css: `font:700 40px/1.25 ${FONT};max-width:960px;` },
      { text: t.subtitle, css: `font:500 22px/1.4 ${FONT};color:#c6d3e6;` },
      { text: t.url, css: `font:500 18px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8fb6e8;max-width:1000px;overflow-wrap:anywhere;` },
    ]);
  } else drop('__aqa_title');

  if (state.verdict) {
    const v = state.verdict;
    const palette = { passed: '#116b3a', failed: '#8c1024', incomplete: '#8a5a06' };
    const status = String(v.status || 'incomplete').toLowerCase();
    card('__aqa_verdict', palette[status] || palette.incomplete, [
      { text: { passed: 'PASS', failed: 'FAIL' }[status] || 'INCOMPLETE', css: `font:800 86px/1 ${FONT};letter-spacing:8px;` },
      { text: v.reason ? `reason: ${v.reason}` : '', css: `font:600 24px/1.4 ${FONT};color:rgba(255,255,255,0.92);` },
      { text: Number.isFinite(v.confidence) ? `confidence ${v.confidence.toFixed(2)}` : '', css: `font:600 22px/1.4 ${FONT};color:rgba(255,255,255,0.85);` },
      { text: v.summary, css: `font:500 22px/1.45 ${FONT};max-width:980px;color:rgba(255,255,255,0.95);` },
    ]);
    if (checks && checks.length) {
      const list = doc.createElement('div');
      list.style.cssText = `display:flex;flex-direction:column;gap:8px;text-align:left;max-width:900px;` +
        `font:600 19px/1.35 ${FONT};`;
      for (const item of checks) list.appendChild(checkRow(item, { met: '#d6ffe6', unmet: '#ffd9df' }));
      doc.getElementById('__aqa_verdict').appendChild(list);
    }
  } else drop('__aqa_verdict');
  return true;
}

const OVERLAY_INIT = `(() => {
  const render = ${renderOverlay.toString()};
  const boot = () => { try { render(null); } catch (e) {} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();`;

/** Reads the page. Runs inside the page: no outer references. */
function collectSnapshot({ scope, nameChars, textChars, maxInteractive, maxText, maxOptions, textBudget }) {
  const root = (scope && document.querySelector(scope)) || document.body || document.documentElement;
  for (const tagged of document.querySelectorAll('[data-aqa-ref]')) tagged.removeAttribute('data-aqa-ref');
  const clean = (value, limit) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };
  const inOverlay = el => Boolean(el.closest('[data-aqa-overlay]'));
  const visible = el => {
    if (el.closest('[aria-hidden="true"]') || el.hasAttribute('hidden')) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const SKIP_TEXT = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const CODE_LIKE = /\{[^}]*[:;][^}]*\}|@media|!important|function\s*\(|=>\s*[{(]|\/\*|;\s*\}/;
  // Text a sighted user would read: no stylesheet/script payloads, no display:none subtrees,
  // but clipped screen-reader-only text is kept because it is the name icon buttons rely on.
  const textOf = (el, depth = 0) => {
    let out = '';
    for (const node of el.childNodes) {
      if (out.length > 400) break;
      if (node.nodeType === 3) { out += node.nodeValue; continue; }
      if (node.nodeType !== 1 || depth >= 6) continue;
      const tag = (node.tagName || '').toUpperCase();
      if (SKIP_TEXT.has(tag) || node.hasAttribute('data-aqa-overlay')) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      out += ` ${textOf(node, depth + 1)}`;
    }
    return out;
  };
  const nameFrom = value => {
    const text = clean(value, nameChars);
    return !text || CODE_LIKE.test(text) ? '' : text;
  };
  const labelledBy = el => (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)).filter(Boolean).map(node => textOf(node)).join(' ');
  const labelFor = el => {
    if (el.id) {
      const tag = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (tag) return textOf(tag);
    }
    const wrapper = el.closest('label');
    return wrapper ? textOf(wrapper) : '';
  };
  const graphicName = el => {
    const svg = el.querySelector('svg');
    if (svg) {
      const title = svg.querySelector('title');
      const named = svg.getAttribute('aria-label') || (title && title.textContent) || '';
      if (named) return named;
    }
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    return img ? img.getAttribute('alt') || img.getAttribute('title') || '' : '';
  };
  const linkPath = el => {
    const raw = el.getAttribute('href');
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(raw)) return '';
    try {
      const target = new URL(raw, location.href);
      return `link to ${target.pathname}${target.search}`;
    } catch { return ''; }
  };
  const isCurrentHref = el => {
    const marker = el.getAttribute('aria-current');
    if (marker && marker !== 'false') return true;
    const raw = el.getAttribute('href');
    if (!raw) return false;
    try {
      const target = new URL(raw, location.href);
      return `${target.pathname}${target.search}` === `${location.pathname}${location.search}`;
    } catch { return false; }
  };
  const accessibleName = el => {
    const candidates = [el.getAttribute('aria-label'), labelledBy(el), labelFor(el),
      el.getAttribute('placeholder'), textOf(el), graphicName(el), el.getAttribute('title'), el.getAttribute('alt'),
      el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()) ? el.value : '',
      el.getAttribute('name'), linkPath(el)];
    for (const candidate of candidates) {
      const text = nameFrom(candidate);
      if (text) return text;
    }
    return '';
  };
  const roleOf = el => {
    const explicit = (el.getAttribute('role') || '').toLowerCase();
    if (['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'treeitem',
      'textbox', 'combobox', 'switch'].includes(explicit)) {
      return explicit === 'switch' ? 'checkbox' : explicit;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchfield';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'button';
  };

  const nodes = [{
    ref: 'doc', role: 'document', label: clean(document.title, nameChars), value: location.pathname,
    hittable: false, visibleToUser: true,
    hiddenContentAbove: scrollY > 4,
    hiddenContentBelow: scrollY + innerHeight < (document.documentElement.scrollHeight || 0) - 4,
  }];

  // JS-backed selects (TomSelect, Select2, Headless UI…) render their choices as [role="option"]
  // outside the native control: without them the widget is pressable but its options are a dead end.
  const INTERACTIVE = 'a[href],button,summary,select,textarea,input,[contenteditable=""],[contenteditable="true"],' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],' +
    '[role="option"],[role="treeitem"],[role="textbox"],[role="combobox"]';
  let index = 0;
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    if (index >= maxInteractive) break;
    if (inOverlay(el)) continue;
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
    if (el.hasAttribute('data-aqa-ref')) continue;
    if (!visible(el)) continue;
    const role = roleOf(el);
    const identifier = el.getAttribute('data-testid') || el.id || el.getAttribute('name') || '';
    let label = accessibleName(el);
    if (!label && role === 'button') label = 'unnamed button';
    if (!label) continue;
    const ref = `e${++index}`;
    el.setAttribute('data-aqa-ref', ref);
    const node = { ref, role, label, hittable: true, visibleToUser: true,
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true' };
    if (identifier) node.identifier = clean(identifier, 60);
    if (role === 'textbox' || role === 'textarea' || role === 'searchfield') {
      node.editable = true;
      const value = clean(el.value ?? textOf(el), nameChars);
      if (value) node.value = value;
    } else if (role === 'checkbox' || role === 'radio') {
      node.selected = Boolean(el.checked || el.getAttribute('aria-checked') === 'true');
    } else if (role === 'link') {
      if (isCurrentHref(el)) { node.selected = true; node.current = true; }
    } else if (role === 'tab' || role === 'option' || role === 'treeitem') {
      if (el.getAttribute('aria-selected') === 'true') node.selected = true;
    } else if (role === 'combobox' && el.options) {
      node.options = [...el.options].slice(0, maxOptions).map(option => clean(option.label || option.text || option.value, 40));
      const selected = el.selectedOptions && el.selectedOptions[0];
      if (selected) node.value = clean(selected.label || selected.text || selected.value, 40);
    }
    nodes.push(node);
  }

  const TEXT = 'h1,h2,h3,h4,h5,h6,label,legend,caption,th,td,p,li,' +
    '[role="alert"],[role="status"],.alert,.flash,.notice,.error,.toast';
  const seen = new Set();
  let textCount = 0;
  let spent = 0;
  for (const el of root.querySelectorAll(TEXT)) {
    if (textCount >= maxText || spent >= textBudget) break;
    if (inOverlay(el) || el.hasAttribute('data-aqa-ref')) continue;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const alert = Boolean(el.closest('[role="alert"],[role="status"],.alert,.flash,.notice,.error,.toast'));
    const raw = textOf(el);
    if (!raw.trim()) continue;
    if (tag === 'p' || tag === 'li') {
      if (!alert && raw.trim().length > 180) continue;
    }
    const label = clean(raw, textChars);
    if (!label || seen.has(label) || CODE_LIKE.test(label)) continue;
    seen.add(label);
    const role = /^h[1-6]$/.test(tag) ? 'heading' : alert ? 'alert' : 'text';
    const ref = `t${++textCount}`;
    el.setAttribute('data-aqa-ref', ref);
    nodes.push({ ref, role, label, hittable: false, visibleToUser: true });
    spent += label.length;
  }

  return {
    appName: document.title || location.host,
    url: location.href,
    visibility: { state: 'foreground', scrollY: Math.round(scrollY), pageHeight: Math.round(document.documentElement.scrollHeight || 0) },
    nodes,
  };
}

/**
 * True when nothing has mutated the DOM for quietMs and nothing declares itself busy.
 * Runs inside the page: no outer references. The observer is installed on the first call and
 * lives on window, so each poll reads the same timestamp instead of restarting the measurement.
 */
function pageSettled({ quietMs }) {
  const KEY = '__aqa_settle';
  let state = window[KEY];
  if (!state || !state.observer) {
    state = window[KEY] = { last: performance.now(), observer: null };
    state.observer = new MutationObserver(() => { state.last = performance.now(); });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    return false;
  }
  const busy = document.querySelector('[aria-busy="true"]') ||
    document.querySelector('.turbo-progress-bar,[data-turbo-progress-bar],#nprogress');
  if (busy) { state.last = performance.now(); return false; }
  return performance.now() - state.last >= quietMs;
}

export class BrowserDevice {
  constructor({ url, profile, headless = true, viewport, settleMs = 400, settleTimeoutMs = SETTLE_TIMEOUT_MS,
    scope, title, backend, highlightMs = HIGHLIGHT_HOLD_MS } = {}) {
    const base = profile?.baseUrl;
    const target = url || (base ? new URL(profile?.startPath || '/', base).toString() : null);
    if (!target) throw new Error('A target url (or a profile with baseUrl) is required.');
    this.url = target;
    this.profile = profile || null;
    this.headless = headless;
    this.viewport = viewport || profile?.viewport || DEFAULT_VIEWPORT;
    this.settleMs = Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : 400;
    this.settleTimeoutMs = Number.isFinite(settleTimeoutMs) && settleTimeoutMs > 0 ? settleTimeoutMs : SETTLE_TIMEOUT_MS;
    // A web page can be typed into key by key, so pressing Enter in a field is a real action here.
    this.capabilities = { key: true };
    this.scope = scope || profile?.scope || null;
    this.title = title || 'Web QA run';
    this.backend = backend || null;
    this.secrets = (profile?.login?.fields || []).filter(f => f.secret && f.value).map(f => String(f.value));
    this.state = { caption: null, highlightRef: null, title: null, verdict: null, expectations: null };
    this.highlightMs = Number.isFinite(highlightMs) && highlightMs >= 0 ? highlightMs : HIGHLIGHT_HOLD_MS;
    this.lastStep = null;
    this.recordingPath = null;
    this.stagingDir = null;
    this.closed = false;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  mask(text) {
    let out = String(text ?? '');
    for (const secret of this.secrets) {
      if (secret.length >= 3) out = out.split(secret).join(MASK);
    }
    return out;
  }

  static ref(value) {
    return String(value || '').replace(/^@/, '').replace(/~s\d+$/, '');
  }

  async apply(patch) {
    Object.assign(this.state, patch);
    if (!this.page || this.page.isClosed()) return;
    try { await this.page.evaluate(renderOverlay, { ...this.state }); }
    catch { /* mid-navigation; the next apply re-paints */ }
  }

  async open() {
    this.browser = await chromium.launch({ headless: this.headless });
    this.stagingDir = join(process.cwd(), '.autoqa-video', randomUUID());
    await mkdir(this.stagingDir, { recursive: true });
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      recordVideo: { dir: this.stagingDir, size: this.viewport },
      ignoreHTTPSErrors: true,
    });
    await this.context.addInitScript({ content: OVERLAY_INIT });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15_000);

    // Paint the title card before anything else so the video never opens on blank frames.
    await this.page.setContent('<!doctype html><html><head><title>auto-qa</title></head><body style="margin:0;background:#0b1220"></body></html>');
    await this.apply({
      title: { task: this.title, subtitle: `web · chromium${this.backend ? ` · ${this.backend}` : ''}`, url: this.url },
      caption: null, highlightRef: null, verdict: null,
    });
    await delay(TITLE_CARD_MS);

    const login = this.profile?.login;
    if (login) {
      await this.apply({ title: null, caption: 'Setup: signing in' });
      const loginUrl = new URL(login.path || '/', this.profile.baseUrl || this.url).toString();
      await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.apply({});
      for (const field of login.fields || []) {
        if (!field?.selector) throw new Error('Each profile login field needs a selector.');
        await this.page.fill(field.selector, String(field.value ?? ''), { timeout: 10_000 });
      }
      if (login.submit) await this.page.click(login.submit, { timeout: 10_000 });
      if (login.waitForUrlNot) {
        try {
          await this.page.waitForFunction(fragment => !location.href.includes(fragment),
            login.waitForUrlNot, { timeout: LOGIN_TIMEOUT_MS, polling: 250 });
        } catch {
          throw new Error(`Sign-in did not complete: the URL still contains ${JSON.stringify(login.waitForUrlNot)} after ${LOGIN_TIMEOUT_MS / 1000}s (now at ${this.page.url()}).`);
        }
      }
      // The sign-in redirect may land on an interstitial: say what is happening while startPath loads.
      await this.apply({ caption: 'Setup: opening start page' });
      await this.settle();
    } else {
      await this.apply({ title: null });
    }

    // this.url is already the resolved start page: an explicit --url when one was given, the
    // profile's baseUrl + startPath otherwise. Recomputing it here would override --url.
    const start = this.url;
    await this.page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.settle();
    // The setup caption must not linger while the model thinks about the first step.
    await this.apply({ caption: `${login ? 'Signed in' : 'Page loaded'} · deciding step 1…` });
    return { platform: 'web', url: this.page.url(), browser: 'chromium' };
  }

  /**
   * Waits for the page to stop moving: load, network, aria-busy/progress bar, a quiet DOM, and
   * then settleMs of grace for a late reaction — a debounced submit or a lazy frame starts its
   * request long after the DOM went quiet, so a request arriving inside that window restarts the
   * wait. Everything is bounded by settleTimeoutMs.
   */
  async settle() {
    if (!this.page || this.page.isClosed()) return;
    const deadline = Date.now() + this.settleTimeoutMs;
    const left = () => deadline - Date.now();
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      await this.page.waitForLoadState('load', { timeout: Math.min(LOAD_CAP_MS, Math.max(left(), 1)) }).catch(() => {});
      await this.page.waitForLoadState('networkidle', { timeout: Math.min(LOAD_CAP_MS, Math.max(left(), 1)) }).catch(() => {});
      // Turbo/AJAX visits keep mutating the DOM long after networkidle; a quiet DOM is the real signal.
      if (left() > 50) {
        await this.page.waitForFunction(pageSettled, { quietMs: DOM_QUIET_MS },
          { timeout: left(), polling: 100 }).catch(() => {});
      }
      const grace = Math.min(this.settleMs, Math.max(left(), 0));
      if (grace <= 0) break;
      const reacted = await this.page.waitForRequest(() => true, { timeout: grace }).then(() => true).catch(() => false);
      if (!reacted || left() <= 0) break;
    }
    await this.apply({});
  }

  async snapshot() {
    if (!this.page || this.page.isClosed()) throw new Error('The browser page is closed.');
    return this.page.evaluate(collectSnapshot, {
      scope: this.scope, nameChars: 80, textChars: 100,
      maxInteractive: 70, maxText: 60, maxOptions: 15, textBudget: 2500,
    });
  }

  locator(ref) {
    const id = BrowserDevice.ref(ref);
    if (!id) throw new Error('This action needs an element ref.');
    return this.page.locator(`[data-aqa-ref="${id}"]`).first();
  }

  async coveredByOverlay(locator) {
    return locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && hit.closest('[data-aqa-overlay]'));
    }).catch(() => false);
  }

  /**
   * Runs an interaction against a ref, turning "the page moved under us" into a typed StaleRefError
   * so the caller can re-read the screen instead of ending the run.
   */
  async interact(ref, run) {
    const id = BrowserDevice.ref(ref);
    const before = this.page.url();
    const target = this.locator(ref);
    const resolves = async () => Boolean(await target.count().catch(() => 0));
    if (!(await resolves())) {
      throw new StaleRefError(`Element ${id} is no longer on the page: the screen changed before the action ran.`);
    }
    try {
      return await run(target);
    } catch (error) {
      if (error instanceof StaleRefError) throw error;
      const message = String(error?.message || '');
      const transient = /Timeout \d+ms exceeded|detached|not attached|Execution context was destroyed|navigat|Target (page|closed)|frame was detached/i.test(message);
      const gone = !(await resolves());
      const moved = !this.page.isClosed() && this.page.url() !== before;
      if (transient && (gone || moved)) {
        throw new StaleRefError(`Element ${id} stopped responding while the page was changing (${message.split('\n')[0]}).`);
      }
      throw error;
    }
  }

  async act(action, { signal } = {}) {
    signal?.throwIfAborted();
    if (!this.page || this.page.isClosed()) throw new Error('The browser page is closed.');
    switch (action.kind) {
      case 'press':
        await this.interact(action.ref, async target => {
          try {
            await target.click({ timeout: 4000 });
          } catch (error) {
            if (!(await this.coveredByOverlay(target))) throw error;
            await target.click({ force: true, timeout: 4000 });
          }
        });
        break;
      case 'fill':
        // fill() alone sets the value without a single key event, so keyup-driven search,
        // type-ahead and validation never run. Clear, then type the text key by key.
        await this.interact(action.ref, async target => {
          const text = String(action.text ?? action.value ?? '');
          await target.fill('', { timeout: 8000 });
          await target.pressSequentially(text, { delay: 20, timeout: 8000 });
        });
        break;
      case 'key':
        await this.interact(action.ref, target => target.press(String(action.key || 'Enter'), { timeout: 8000 }));
        break;
      case 'select':
        await this.interact(action.ref, async target => {
          const value = String(action.value ?? action.text ?? '');
          try { await target.selectOption({ label: value }, { timeout: 8000 }); }
          catch { await target.selectOption(value, { timeout: 8000 }); }
        });
        break;
      case 'scroll': {
        const { width, height } = this.viewport;
        const step = { down: [0, height * 0.7], up: [0, -height * 0.7], right: [width * 0.7, 0], left: [-width * 0.7, 0] }[action.direction];
        if (!step) throw new Error(`Unsupported scroll direction: ${action.direction}`);
        await this.page.evaluate(([x, y]) => window.scrollBy({ left: x, top: y, behavior: 'instant' }), step.map(Math.round));
        break;
      }
      case 'back':
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
        break;
      case 'wait':
        await delay(500, undefined, { signal });
        break;
      default:
        throw new Error(`Unsupported device action: ${action.kind}`);
    }
    await this.apply({ highlightRef: null });
    await this.settle();
    // The page has changed: never leave the previous step's caption over it while the model thinks.
    if (Number.isFinite(this.lastStep)) {
      await this.apply({ caption: `Step ${this.lastStep} done · deciding step ${this.lastStep + 1}…` });
    }
    signal?.throwIfAborted();
    return { ok: true };
  }

  /** Normalizes the run's expectation checklist; undefined leaves the current panel untouched. */
  expectationsPatch(expectations) {
    if (!Array.isArray(expectations)) return {};
    return {
      expectations: expectations.filter(item => item && typeof item === 'object').map(item => ({
        statement: this.mask(item.statement || ''),
        p: Number.isFinite(item.p) ? item.p : null,
        met: Boolean(item.met),
      })),
    };
  }

  async annotate({ step, kind, description, confidence, ref, expectations } = {}) {
    const what = this.mask(description || kind || 'thinking');
    const parts = [];
    if (Number.isFinite(step)) parts.push(`Step ${step}`);
    parts.push(what);
    if (Number.isFinite(confidence)) parts.push(`confidence ${confidence.toFixed(2)}`);
    if (Number.isFinite(step)) this.lastStep = step;
    const target = ref ? BrowserDevice.ref(ref) : null;
    await this.apply({ caption: parts.join(' · '), highlightRef: target, title: null, ...this.expectationsPatch(expectations) });
    if (!this.highlightMs || !this.recordingPath || !this.page || this.page.isClosed()) return;
    if (!target) {
      // A terminal decision has no element: hold so the settled checklist is readable before the verdict card.
      if (kind === 'verdict') await delay(this.highlightMs);
      return;
    }
    // Hold long enough for the outline to be readable in the recording before the action fires.
    const located = this.page.locator(`[data-aqa-ref="${target}"]`).first();
    if (!(await located.count().catch(() => 0))) return;
    await located.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    await this.apply({});
    await delay(this.highlightMs);
  }

  async showVerdict({ status, reason, confidence, summary, expectations } = {}) {
    await this.apply({
      verdict: { status, reason, confidence, summary: this.mask(summary || '') },
      caption: null, highlightRef: null, title: null, ...this.expectationsPatch(expectations),
    });
    await delay(VERDICT_CARD_MS);
  }

  async screenshot(path) {
    if (!this.page || this.page.isClosed()) throw new Error('The browser page is closed.');
    await mkdir(dirname(path), { recursive: true });
    await this.page.screenshot({ path });
    return path;
  }

  async startRecording(path) {
    if (!this.context) throw new Error('Open the device before recording.');
    if (!path) throw new Error('A recording output path is required.');
    await mkdir(dirname(path), { recursive: true });
    this.recordingPath = path;
    return { path, recording: true };
  }

  async stopRecording() {
    if (!this.recordingPath) throw new Error('Recording was never started.');
    const outPath = this.recordingPath;
    this.recordingPath = null;
    const video = this.page?.video?.();
    if (!video) throw new Error('This context was not recording video.');
    if (!this.page.isClosed()) await this.page.close();
    await this.context.close();
    this.context = null;
    this.page = null;
    const source = await video.path();
    const rawPath = join(dirname(outPath), 'raw.webm');
    try { await rename(source, rawPath); }
    catch { await copyFile(source, rawPath); }
    await toMp4(rawPath, outPath);
    await this.cleanStaging();
    return { outPath, rawPath, durationMs: await durationMs(outPath) };
  }

  async cleanStaging() {
    if (!this.stagingDir) return;
    const dir = this.stagingDir;
    this.stagingDir = null;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rmdir(dirname(dir)).catch(() => {}); // only succeeds when no other run is staging
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch { /* already gone */ }
    try { if (this.context) await this.context.close(); } catch { /* already gone */ }
    try { if (this.browser) await this.browser.close(); } catch { /* already gone */ }
    this.page = null;
    this.context = null;
    this.browser = null;
    await this.cleanStaging();
  }
}
