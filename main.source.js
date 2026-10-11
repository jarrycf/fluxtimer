const { Plugin, PluginSettingTab, Setting, Notice, Menu, MarkdownView, setIcon } = require('obsidian');
const MAX = 180 * 60;
const DEFAULT_ICON_SIZE = 24;
const validSeconds = value => Number.isFinite(value) && value >= 1 && value <= MAX;
const format = seconds => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
function parseDuration(text) {
  const value = text.trim();
  if (!/^\d+(?::[0-5]\d)?$/.test(value)) return null;
  const parts = value.split(':').map(Number);
  const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 60;
  return validSeconds(seconds) ? seconds : null;
}
// A short movement never starts a timer. Each three CSS pixels adds one minute.
function dragDuration(initial, distance) { return Math.max(0, Math.min(MAX, initial + Math.round(distance / 3) * 60)); }
const defaultPresets = () => [{ seconds: 300, name: t('preset.rest') }, { seconds: 1500, name: t('preset.focus') }];
// "番茄专注=25, 休息一下=5, 冥想=00:30" → at most six presets; malformed parts are skipped.
function parsePresets(text) {
  const presets = [];
  for (const part of String(text || '').split(/[,，;；\n]/)) {
    const match = part.trim().match(/^()(\d+(?::[0-5]\d)?)$/) || part.trim().match(/^(.+?)\s*[=＝:：]\s*(\d+(?::[0-5]\d)?)$/);
    const seconds = match && parseDuration(match[2]);
    if (seconds) presets.push({ seconds, name: (match[1].trim() || t('unit.minutes', { n: Math.round(seconds / 60) })).slice(0, 20) });
    if (presets.length >= 6) break;
  }
  return presets;
}
const presetsText = presets => presets.map(p => `${p.name}=${p.seconds % 60 ? format(p.seconds) : p.seconds / 60}`).join(', ');
class Timer {
  constructor(saved = {}) {
    saved = saved && typeof saved === 'object' ? saved : {};
    this.id = String(saved.id || '');
    this.name = typeof saved.name === 'string' ? saved.name.slice(0, 60) : '';
    this.taskId = typeof saved.taskId === 'string' ? saved.taskId : '';
    this.taskPath = typeof saved.taskPath === 'string' ? saved.taskPath : '';
    this.managedTask = saved.managedTask === true;
    this.mode = saved.mode === 'up' ? 'up' : 'down';
    this.recordName = saved.recordName === true;
    this.logged = saved.logged === true;
    this.elapsedStored = Number.isFinite(saved.elapsedStored) ? Math.max(0, saved.elapsedStored) : 0;
    this.resumedAt = Number.isFinite(saved.resumedAt) ? saved.resumedAt : Date.now();
    this.endedAt = Number.isFinite(saved.endedAt) ? saved.endedAt : 0;
    this.selected = validSeconds(saved.selected) ? saved.selected : 1500;
    this.total = validSeconds(saved.total) ? saved.total : this.selected;
    this.state = ['running', 'paused', 'finished'].includes(saved.state) ? saved.state : 'idle';
    this.deadline = Number.isFinite(saved.deadline) ? saved.deadline : 0;
    this.remaining = Number.isFinite(saved.remaining) ? Math.max(0, Math.min(this.total, saved.remaining)) : this.total;
    if (this.mode === 'down' && this.state === 'running' && this.deadline <= 0) this.state = 'idle';
  }
  left(now = Date.now()) { return this.state === 'running' ? Math.max(0, Math.min(this.total, (this.deadline - now) / 1000)) : this.remaining; }
  elapsed(now = Date.now()) { return this.mode === 'up' ? this.elapsedStored + (this.state === 'running' ? Math.max(0, (now - this.resumedAt) / 1000) : 0) : this.total - this.left(now); }
  start(now = Date.now()) { this.total = this.selected; this.remaining = this.total; this.deadline = now + this.total * 1000; this.elapsedStored = 0; this.resumedAt = now; this.logged = false; this.endedAt = 0; this.state = 'running'; }
  pause(now = Date.now()) {
    if (this.state !== 'running' || this.tick(now)) return;
    if (this.mode === 'up') this.elapsedStored = this.elapsed(now); else this.remaining = this.left(now);
    this.state = 'paused';
  }
  resume(now = Date.now()) { if (this.state !== 'paused') return; this.resumedAt = now; this.deadline = now + this.remaining * 1000; this.state = 'running'; }
  finish(now = Date.now()) { if (this.mode !== 'up' || !['running', 'paused'].includes(this.state)) return; this.elapsedStored = this.elapsed(now); this.endedAt = now; this.state = 'finished'; }
  extend(seconds = 300, now = Date.now()) {
    if (this.mode === 'up' || !validSeconds(seconds)) return;
    this.tick(now);
    if (this.state === 'finished') {
      this.logged = false; this.endedAt = 0; this.total = seconds; this.remaining = seconds; this.deadline = now + seconds * 1000; this.state = 'running'; return;
    }
    if (!['running', 'paused'].includes(this.state)) return;
    const extra = Math.min(seconds, MAX - this.total);
    this.total += extra;
    if (this.state === 'running') this.deadline += extra * 1000;
    else this.remaining += extra;
  }
  tick(now = Date.now()) {
    if (this.mode === 'up' || this.state !== 'running' || this.left(now) > 0) return false;
    this.endedAt = this.deadline; this.state = 'finished'; this.remaining = 0; this.deadline = 0; return true;
  }
}
function restore(saved = {}) {
  saved = saved && typeof saved === 'object' ? saved : {};
  const source = Array.isArray(saved.timers) ? saved.timers : saved.timer ? [saved.timer] : [];
  // A finished stopwatch is already logged and closed: it leaves the rail instead of raising a card.
  const timers = source.filter(x => x && typeof x === 'object').map(x => new Timer(x)).filter(x => x.state !== 'idle' && !(x.mode === 'up' && x.state === 'finished'));
  // Reassign IDs on load so malformed or duplicate saved IDs cannot target another timer.
  timers.forEach((t, i) => { t.id = `timer-${i + 1}`; });
  const recent = saved.recent && validSeconds(saved.recent.seconds) ? { seconds: saved.recent.seconds, name: typeof saved.recent.name === 'string' ? saved.recent.name.slice(0, 60) : '' } : { seconds: validSeconds(saved.timer?.selected) ? saved.timer.selected : 60, name: '' };
  // v4 lowered the default from 28 to 24; migrate only saves that still hold the old default.
  const iconSize = Number.isFinite(saved.iconSize) ? Math.min(48, Math.max(20, saved.iconSize)) : DEFAULT_ICON_SIZE;
  const size = !(saved.version >= 4) && iconSize === 28 ? DEFAULT_ICON_SIZE : iconSize;
  const presets = Array.isArray(saved.presets) ? saved.presets.filter(p => p && validSeconds(p.seconds) && typeof p.name === 'string').slice(0, 6).map(p => ({ seconds: p.seconds, name: p.name.slice(0, 20) })) : null;
  // 4.2 saved the Chinese defaults verbatim; treat that exact list as unset so it follows the language.
  const legacyDefaults = presets && presets.length === 2 && presets[0].seconds === 300 && presets[0].name === '休息一下' && presets[1].seconds === 1500 && presets[1].name === '番茄专注';
  return { iconSize: size, logPath: typeof saved.logPath === 'string' && saved.logPath.endsWith('.md') ? saved.logPath : '提示事项.md', pendingLogs: Array.isArray(saved.pendingLogs) ? saved.pendingLogs.filter(x => x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.path === 'string' && Number.isFinite(x.minutes) && Number.isFinite(x.endedAt)) : [], timers, nextId: timers.length + 1, recent, layout: saved.layout === 'vertical' ? 'vertical' : 'horizontal', sound: saved.sound !== false, presets: legacyDefaults ? null : presets, statusBar: saved.statusBar !== false, notify: saved.notify !== false, lastMode: saved.lastMode === 'down' ? 'down' : 'up', language: ['zh', 'en', 'auto'].includes(saved.language) ? saved.language : 'auto' };
}
function appendRecord(text, entry) {
  const marker = `[tt-id:: ${entry.id.replace(/[^a-zA-Z0-9]/g, '')}]`;
  if (text.includes(`<!-- fluxtimer:${entry.id} -->`)) return text;
  if (text.includes(marker)) return text;
  const date = new Date(entry.endedAt), day = `${date.getMonth() + 1}.${date.getDate()}`;
  const sections = [...text.matchAll(/^(\d{1,2}\.\d{1,2})\s*$/gm)];
  const last = sections.at(-1);
  let result = text.replace(/\s*$/, '');
  if (!last || last[1] !== day) {
    if (last) {
      const section = text.slice(last.index + last[0].length);
      if (!section.includes(`${last[1]}累计用时:`)) {
        const minutes = [...section.matchAll(/^- \[x\] (?!.*累计用时:).*? (\d+)分钟(?:\s*(?:<!--.*?-->|\[tt-id::[^\]]+\]))?\s*$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
        result += `\n- [x] ${last[1]}累计用时: ${minutes}分钟`;
      }
    }
    result += `${result ? '\n\n' : ''}${day}`;
  }
  return `${result}\n- [${entry.open ? ' ' : 'x'}] ${entry.name}${entry.open ? '' : ` ${entry.minutes}分钟`} ${marker}\n`;
}
module.exports = class FluxTimer extends Plugin {
  async onload() {
    Object.assign(this, restore(await this.loadData()));
    FT_LANG = resolveLang(this.language);
    this.saveQueue = Promise.resolve(); this.rings = new Map(); this.draft = null; this.selectedId = null;
    this.logQueue = Promise.resolve();
    this.trackerReady = false;
    try {
      const TrackerBridge = loadTrackerBridge(require);
      this.bridge = new TrackerBridge(this, Timer, appendRecord);
      await this.bridge.init(); this.trackerReady = true;
      this.registerEvent(this.app.vault.on('modify', file => {
        if (file.extension === 'md') this.app.vault.cachedRead(file).then(text => this.bridge.taskClosed(text)).catch(error => this.logError(error));
      }));
    } catch (error) { console.error('fluxtimer tracker initialization', error); new Notice(t('notice.trackerFailed')); }

    this.ensureLogFile(this.logPath).then(() => this.flushLogs()).catch(error => this.logError(error));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (oldPath === this.logPath && file.extension === 'md') { this.logPath = file.path; this.persist(); } }));
    this.addSettingTab(new FluxSettings(this.app, this));
    this.statusEl = this.addStatusBarItem?.();
    if (this.statusEl) {
      this.statusEl.addClass?.('fluxtimer-status');
      this.statusEl.addEventListener('click', () => { const timer = this.statusTimer(); if (timer && this.host) { this.draft = null; this.selectedId = timer.id; this.render(); } });
    }
    this.registerCommands();
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.mount()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.mount()));
    // Capture phase so a click on the note, another pane or a native menu always folds the panel.
    this.registerDomEvent(document, 'pointerdown', event => this.collapseOutside(event), true);
    this.app.workspace.onLayoutReady(() => { if (!this.disposed) { this.mount(); this.tick(); } });
    this.registerInterval(window.setInterval(() => this.tick(), 200));
  }
  persist() {
    const data = { version: 4, iconSize: this.iconSize, logPath: this.logPath, pendingLogs: this.pendingLogs.map(x => ({ ...x })), sound: this.sound, notify: this.notify, statusBar: this.statusBar, layout: this.layout, lastMode: this.lastMode, presets: this.presets ? this.presets.map(p => ({ ...p })) : null, language: this.language, recent: { ...this.recent }, timers: this.timers.map(t => ({ ...t })) };
    this.saveQueue = this.saveQueue.then(() => this.saveData(data)).catch(error => {
      console.error('fluxtimer: save failed', error); new Notice(t('notice.saveFailed'));
    });
    return this.saveQueue;
  }
  // Unset presets follow the UI language; customised ones are kept verbatim.
  presetList() { return this.presets || defaultPresets(); }
  setLanguage(language) {
    this.language = ['zh', 'en', 'auto'].includes(language) ? language : 'auto';
    FT_LANG = resolveLang(this.language);
    this.bridge?.setLanguage?.(this.language);
    this.persist(); this.render(); this.updateStatus();
  }
  // Commands carry no default hotkeys; they can be bound in Obsidian's own hotkey settings.
  registerCommands() {
    if (!this.addCommand) return;
    const needHost = () => { if (!this.host) new Notice(t('notice.needNote')); return !!this.host; };
    this.addCommand({ id: 'new-timer', name: t('cmd.newTimer'), callback: () => { if (needHost()) this.openDraft(); } });
    this.addCommand({ id: 'new-countdown', name: t('cmd.newCountdown'), callback: () => { if (needHost()) this.openDraft('down'); } });
    this.addCommand({ id: 'new-stopwatch', name: t('cmd.newStopwatch'), callback: () => { if (needHost()) this.openDraft('up'); } });
    this.addCommand({ id: 'toggle-latest', name: t('cmd.toggleLatest'), checkCallback: checking => {
      const timer = [...this.timers].reverse().find(t => ['running', 'paused'].includes(t.state));
      if (!timer) return false; if (!checking) this.act(timer.id, 'toggle'); return true;
    } });
    this.addCommand({ id: 'clear-finished', name: t('cmd.clearFinished'), checkCallback: checking => {
      const done = this.timers.filter(t => t.state === 'finished'); if (!done.length) return false;
      if (!checking) { this.timers = this.timers.filter(t => t.state !== 'finished'); this.persist(); this.render(); this.updateStatus(); }
      return true;
    } });
    this.addCommand({ id: 'toggle-layout', name: t('cmd.toggleLayout'), callback: () => this.setLayout(this.layout === 'vertical' ? 'horizontal' : 'vertical') });
    this.addCommand({ id: 'open-log', name: t('cmd.openLog'), checkCallback: checking => { if (!this.trackerReady) return false; if (!checking) this.bridge.tracker.activateLogView(); return true; } });
    this.addCommand({ id: 'open-dashboard', name: t('cmd.openDashboard'), checkCallback: checking => { if (!this.trackerReady) return false; if (!checking) this.bridge.tracker.activateDashboardView(); return true; } });
  }
  // The status bar keeps the soonest countdown visible while a non-note view is focused.
  statusTimer(now = Date.now()) {
    const down = this.timers.filter(t => t.mode === 'down');
    return down.find(t => t.state === 'finished') || down.filter(t => t.state === 'running').sort((a, b) => a.left(now) - b.left(now))[0] || down.find(t => t.state === 'paused') || null;
  }
  updateStatus(now = Date.now()) {
    const el = this.statusEl; if (!el) return;
    const timer = this.statusBar ? this.statusTimer(now) : null;
    const text = !timer ? '' : timer.state === 'finished' ? t('status.done', { name: timer.name }) : `${format(timer.left(now))} · ${timer.name}${timer.state === 'paused' ? t('status.paused') : ''}`;
    if (el.textContent !== text) el.textContent = text;
    el.style.display = text ? '' : 'none';
    el.dataset.state = timer?.state || '';
    el.setAttribute('aria-label', text ? t('status.aria', { text }) : '');
  }
  notifySystem(names) {
    if (!this.notify || typeof window.Notification !== 'function' || document.hasFocus()) return;
    try { new window.Notification(t('notify.title'), { body: names.join(t('list.sep')), silent: true }); } catch (_) { /* The in-app notice still appears. */ }
  }
  async ensureLogFile(path) {
    const pick = () => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file && file.extension !== 'md') throw new Error(t('error.notMarkdown'));
      return file;
    };
    const existing = pick();
    if (existing) return existing;
    // Obsidian's Vault.create() re-checks the disk with an awaited adapter.exists(), so two
    // callers can both pass this pre-check and the loser is rejected with "File already
    // exists.". Creation is serialized here, and a file that is already on disk but not yet
    // in the vault index is adopted instead of failing.
    const job = (this.logCreate || Promise.resolve()).then(async () => {
      const indexed = pick();
      if (indexed) return indexed;
      try {
        return await this.app.vault.create(path, '');
      } catch (error) {
        if (!/already exists/i.test(error?.message || '')) throw error;
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          const adopted = pick();
          if (adopted) return adopted;
        }
        throw error;
      }
    });
    // Keep the queue alive after a failure; the caller still receives the rejection.
    this.logCreate = job.catch(() => {});
    return job;
  }
  logError(error) { console.error('fluxtimer: record failed', error); new Notice(t('notice.logFailed')); }
  record(timer) {
    if (timer.logged || timer.state !== 'finished') return;
    timer.logged = true;
    if (!timer.recordName || !timer.name.trim()) return;
    this.pendingLogs.push({ seconds: timer.elapsed(), id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, path: this.logPath, name: timer.name.replace(/[\r\n]+/g, ' ').replace(/<!--|-->/g, '').trim(), minutes: Math.round(timer.elapsed() / 60), endedAt: timer.endedAt || Date.now() });
  }
  flushLogs() {
    this.logQueue = this.logQueue.then(async () => {
      while (this.pendingLogs.length) {
        const entry = this.pendingLogs[0];
        // Save the pending entry before touching the note. Its invisible ID prevents retry duplicates.
        await this.persist();
        const file = await this.ensureLogFile(entry.path);
        await this.app.vault.process(file, text => appendRecord(text, entry));
        if (!this.trackerReady) throw new Error(t('notice.trackerNotReady'));
        await this.bridge.addCompleted(entry);
        this.pendingLogs.shift(); await this.persist();
      }
    }).catch(error => this.logError(error));
    return this.logQueue;
  }
  setIconSize(value) { this.iconSize = Math.min(48, Math.max(20, value)); this.root?.style.setProperty('--ft-size', `${this.iconSize}px`); this.persist(); }
  mount() {
    if (this.disposed) return;
    const host = this.app.workspace.getActiveViewOfType(MarkdownView)?.contentEl ?? null;
    if (host === this.host) return;
    this.cancelDrag(); this.root?.remove(); this.host?.classList.remove('fluxtimer-host');
    this.host = host;
    if (!host) return;
    host.classList.add('fluxtimer-host');
    this.root = host.ownerDocument.createElement('div'); this.root.className = 'fluxtimer'; host.appendChild(this.root);
    this.render();
  }
  el(tag, cls, text, parent = this.root) {
    const el = parent.ownerDocument.createElement(tag); if (cls) el.className = cls;
    if (text) el.textContent = text; parent.appendChild(el); return el;
  }
  button(text, label, action, parent = this.root, cls = '') {
    const button = this.el('button', cls, text, parent);
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    const icon = { '+': 'plus', '×': 'x', '−': 'minus', '▷': 'play', '↻': 'rotate-ccw' }[text];
    if (icon) { button.textContent = ''; setIcon(button, icon); }
    button.addEventListener('click', event => { Promise.resolve(action(event)).catch(error => this.logError(error)); }); return button;
  }
  // Below the ring, clamped to the root: the rail's scroll container would clip a nested tip.
  showTooltip(id) {
    const ref = this.rings?.get(id), root = this.root;
    if (!ref || !this.tooltip || !root || this.tooltipShown === id) return;
    const label = ref.button.getAttribute('aria-label') || ''; if (!label) return;
    this.tooltip.textContent = label; this.tooltip.classList.add('is-visible');
    const frame = root.getBoundingClientRect(), box = ref.wrap.getBoundingClientRect(), half = this.tooltip.offsetWidth / 2 + 2;
    const center = box.left - frame.left + box.width / 2;
    this.tooltip.style.left = `${half * 2 > frame.width ? frame.width / 2 : Math.min(Math.max(center, half), frame.width - half)}px`;
    this.tooltip.style.top = `${box.bottom - frame.top + 6}px`;
    this.tooltipShown = id;
  }
  hideTooltip() { this.tooltipShown = null; this.tooltip?.classList.remove('is-visible'); }
  openDraft(mode = this.lastMode) { this.suppressClick = false; this.cancelDrag(); this.selectedId = null; this.draft = { mode: mode === 'down' ? 'down' : 'up', seconds: 0, name: '' }; this.render(); this.root?.querySelector(this.draft.mode === 'down' ? '.ft-duration' : '.ft-name')?.focus(); }
  closePanel(focus = true) { this.cancelDrag(); this.draft = null; this.selectedId = null; this.render(); if (focus) this.addButton?.focus(); }
  // Outside clicks fold the opened ring only: the draft composer keeps whatever is typed in it.
  collapseOutside(event) {
    if (this.disposed || !this.root || !this.selectedId) return;
    if (this.root.contains(event.target)) return;
    this.selectedId = null; this.render();
  }
  render() {
    if (!this.host || !this.root || this.drag) return;
    const focused = this.root.ownerDocument.activeElement;
    const focusKey = this.root.contains(focused) ? focused?.dataset?.focus : null;
    const selection = focusKey && focused.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd] : null;
    this.root.replaceChildren(); this.rings = new Map(); this.tooltip = null; this.tooltipShown = null; this.durationInput = this.preview = this.detailTime = this.detailSub = this.detailBar = null;
    this.root.dataset.layout = this.layout;
    this.root.style.setProperty('--ft-size', `${this.iconSize}px`);
    this.root.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); this.closePanel(); } };
    const rail = this.el('div', 'ft-rail'); rail.setAttribute('aria-label', t('rail.aria'));
    for (const timer of this.timers) {
      const wrap = this.el('div', 'ft-ring-wrap', '', rail);
      const button = this.button('', timer.name || t('name.countdown'), () => {
        this.draft = null; this.selectedId = this.selectedId === timer.id ? null : timer.id; this.render();
      }, wrap, 'ft-ring');
      button.dataset.focus = timer.id; button.setAttribute('aria-expanded', String(this.selectedId === timer.id));
      // The bubble replaces the native title tip, so the two never stack.
      button.removeAttribute('title');
      this.el('span', 'ft-ring-track', '', button); const arc = this.el('span', 'ft-ring-arc', '', button);
      const ticks = this.el('span', 'ft-ring-ticks', '', button);
      const number = this.el('span', 'ft-ring-number', '', button);
      this.el('span', 'ft-pause-mark', 'Ⅱ', button);
      wrap.addEventListener('pointerenter', () => this.showTooltip(timer.id));
      wrap.addEventListener('pointermove', () => this.showTooltip(timer.id));
      wrap.addEventListener('pointerleave', () => this.hideTooltip());
      button.addEventListener('focus', () => this.showTooltip(timer.id));
      button.addEventListener('blur', () => this.hideTooltip());
      this.rings.set(timer.id, { button, wrap, arc, ticks, number });
    }
    // The rail clips its overflow, so the shared name bubble lives on the unclipped root.
    this.tooltip = this.el('div', 'ft-tooltip', '');
    this.tooltip.setAttribute('aria-hidden', 'true');
    this.addButton = this.button('+', t('add.aria'), () => this.draft ? this.closePanel() : this.openDraft(), rail, 'ft-add');
    this.addButton.dataset.focus = 'add'; this.addButton.setAttribute('aria-expanded', String(!!this.draft));
    this.addButton.addEventListener('contextmenu', e => {
      e.preventDefault(); const menu = new Menu();
      menu.addItem(item => item.setTitle(t('menu.horizontal')).setChecked(this.layout === 'horizontal').onClick(() => this.setLayout('horizontal')));
      menu.addItem(item => item.setTitle(t('menu.vertical')).setChecked(this.layout === 'vertical').onClick(() => this.setLayout('vertical')));
      if (this.trackerReady) {
        menu.addSeparator();
        menu.addItem(item => item.setTitle(t('menu.log')).setIcon('history').onClick(() => this.bridge.tracker.activateLogView()));
        menu.addItem(item => item.setTitle(t('menu.dashboard')).setIcon('bar-chart-3').onClick(() => this.bridge.tracker.activateDashboardView()));
        menu.addItem(item => item.setTitle(t('menu.export')).setIcon('download').onClick(() => this.bridge.export()));
      }
      menu.showAtMouseEvent(e);
    });
    if (this.draft) this.renderDraft();
    const selected = this.timers.find(t => t.id === this.selectedId);
    if (selected && selected.state !== 'finished') this.renderDetail(selected);
    this.renderFinished(); this.update();
    if (focusKey) {
      const next = Array.from(this.root.querySelectorAll('[data-focus]')).find(el => el.dataset.focus === focusKey);
      next?.focus(); if (selection && next?.setSelectionRange) next.setSelectionRange(...selection);
    }
  }
  renderDraft() {
    const panel = this.el('section', 'ft-composer'); panel.setAttribute('aria-label', t('composer.aria'));
    const modes = this.el('div', 'ft-modes', '', panel);
    for (const [mode, label] of [['up', t('mode.up')], ['down', t('mode.down')]]) {
      const button = this.button(label, label, () => { this.cancelDrag(); this.draft.mode = mode; this.render(); }, modes);
      button.setAttribute('aria-pressed', String((this.draft.mode || 'down') === mode));
    }
    this.preview = this.el('div', 'ft-end-preview', '', panel);
    const row = this.el('div', 'ft-compose-row', '', panel);
    this.button('×', t('composer.cancel'), () => this.closePanel(), row, 'ft-dismiss');
    const bar = this.el('div', 'ft-input-bar', '', row);
    const timeCell = this.el('div', 'ft-time-cell', '', bar);
    const bookmark = this.el('span', 'ft-bookmark', '', timeCell);
    bookmark.setAttribute('aria-hidden', 'true'); setIcon(bookmark, 'bookmark');
    const input = this.el('input', 'ft-duration', '', timeCell); this.durationInput = input;
    input.type = 'text'; input.value = this.draft.seconds ? format(this.draft.seconds) : ''; input.placeholder = '0 min'; input.disabled = this.draft.mode === 'up'; if (this.draft.mode === 'up') input.value = '00:00'; input.dataset.focus = 'duration';
    input.setAttribute('aria-label', t('duration.aria'));
    input.addEventListener('input', () => { this.draft.seconds = parseDuration(input.value) || 0; input.setCustomValidity(''); this.update(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.startDraft(); } });
    const name = this.el('input', 'ft-name', '', bar); name.type = 'text'; name.maxLength = 60; name.value = this.draft.name;
    name.placeholder = t('name.placeholder'); name.dataset.focus = 'name'; name.setAttribute('aria-label', t('name.aria'));
    name.addEventListener('input', () => { this.draft.name = name.value; });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.startDraft(); } });
    const handle = this.button(this.draft.mode === 'up' ? '▷' : '+', this.draft.mode === 'up' ? t('handle.up') : t('handle.down'), () => { if (!this.suppressClick) this.startDraft(); this.suppressClick = false; }, bar, 'ft-drag-handle');
    if (this.draft.mode === 'up') return;
    handle.dataset.focus = 'handle'; handle.setAttribute('role', 'slider'); handle.setAttribute('aria-valuemin', '0'); handle.setAttribute('aria-valuemax', '180');
    this.dragHandle = handle;
    handle.addEventListener('keydown', e => {
      if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); this.draft.seconds = Math.max(0, Math.min(MAX, this.draft.seconds + (['ArrowRight', 'ArrowUp'].includes(e.key) ? 60 : -60)));
        input.value = format(this.draft.seconds); this.update();
      }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.startDraft(); }
    });
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      this.drag = { id: e.pointerId, x: e.clientX, seconds: this.draft.seconds, moved: false, handle };
      panel.classList.add('is-dragging');
    });
    handle.addEventListener('pointermove', e => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const dx = e.clientX - this.drag.x; this.drag.moved ||= Math.abs(dx) >= 4;
      this.draft.seconds = dragDuration(this.drag.seconds, dx); input.value = format(this.draft.seconds);
      handle.style.setProperty('--ft-pull', `${Math.max(-8, Math.min(18, dx / 10))}px`); this.update();
    });
    handle.addEventListener('pointerup', e => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.suppressClick = this.drag.moved;
      const shouldStart = this.drag.moved && validSeconds(this.draft.seconds);
      this.cancelDrag(); if (shouldStart) this.startDraft(); else this.render();
    });
    handle.addEventListener('pointercancel', () => { this.cancelDrag(); this.render(); });
    handle.addEventListener('lostpointercapture', () => { if (this.drag) { this.cancelDrag(); this.render(); } });
    const presets = this.el('div', 'ft-presets', '', panel);
    // The latest countdown leads; configured presets follow unless they duplicate it.
    const choices = [[this.recent.seconds, this.recent.name || t('preset.lastFallback'), true], ...this.presetList().filter(p => !(p.seconds === this.recent.seconds && p.name === this.recent.name)).map(p => [p.seconds, p.name])];
    for (const [seconds, label, recent] of choices) {
      const preset = this.button('', t('preset.aria', { label, time: format(seconds) }), () => { this.draft = { mode: 'down', seconds, name: this.draft.name.trim(), presetLabel: label }; this.startDraft(); }, presets, 'ft-preset');
      this.el('span', 'ft-preset-value', seconds < 60 ? `${seconds}s` : seconds % 60 ? format(seconds) : `${seconds / 60}′`, preset);
      this.el('span', 'ft-preset-name', label, preset); if (recent) this.el('span', 'ft-recent', t('preset.recent'), preset);
    }
    this.el('div', 'ft-hint', t('composer.hint'), panel);
  }
  cancelDrag() {
    const drag = this.drag; this.drag = null;
    if (drag) {
      if (drag.handle.hasPointerCapture(drag.id)) drag.handle.releasePointerCapture(drag.id);
      drag.handle.style.removeProperty('--ft-pull');
    }
  }
  async startDraft() {
    if (!this.draft || this.starting) return;
    if (this.draft.mode === 'up' && !this.trackerReady) { new Notice(t('notice.reloadTracker')); return; }
    if (this.draft.mode !== 'up' && !validSeconds(this.draft.seconds)) {
      this.durationInput?.setCustomValidity(t('duration.invalid')); this.durationInput?.reportValidity(); return;
    }
    const timer = new Timer({ id: `timer-${this.nextId++}`, mode: this.draft.mode, recordName: !!this.draft.name.trim(), selected: this.draft.seconds, name: this.draft.name.trim() || this.draft.presetLabel || (this.draft.mode === 'up' ? t('name.stopwatch') : t('name.countdown')) });
    this.prepareAudio(); timer.start(); if (timer.mode === 'up') timer.state = 'paused'; this.timers.push(timer);
    if (timer.mode === 'up') {
      this.starting = true;
      try { await this.bridge.start(timer); } catch (error) { this.logError(error); } finally { this.starting = false; }
    } if (timer.mode === 'down') this.recent = { seconds: timer.selected, name: timer.name };
    this.lastMode = timer.mode;
    this.cancelDrag(); this.draft = null; this.selectedId = null; this.persist(); this.render();
    const ring = this.rings.get(timer.id)?.button;
    // No focus jump: a programmatically focused ring would draw the theme's focus frame and pop its tooltip.
    ring?.classList.add('ft-born');
    if (this.root?.contains(this.root.ownerDocument.activeElement)) this.root.ownerDocument.activeElement.blur();
  }
  renderDetail(timer) {
    const panel = this.el('section', 'ft-detail'); panel.setAttribute('aria-label', t('detail.aria', { name: timer.name }));
    panel.dataset.mode = timer.mode; panel.dataset.state = timer.state;
    const head = this.el('div', 'ft-detail-head', '', panel);
    const name = this.el('div', 'ft-detail-name', timer.name, head); name.title = timer.name;
    this.el('span', 'ft-detail-badge', timer.mode === 'up' ? t('badge.up') : t('badge.down'), head);
    this.detailTime = this.el('div', 'ft-detail-time', '', panel);
    this.detailSub = this.el('div', 'ft-detail-sub', '', panel);
    const track = this.el('div', 'ft-progress', '', panel); this.detailBar = this.el('span', '', '', track);
    const actions = this.el('div', 'ft-actions', '', panel);
    const pause = this.button(timer.state === 'paused' ? t('action.resume') : t('action.pause'), t('action.toggleAria'), () => this.act(timer.id, 'toggle'), actions, 'ft-primary'); pause.dataset.focus = 'pause';
    if (timer.mode === 'up') this.button(t('action.finish'), t('action.finishAria'), () => this.act(timer.id, 'finish'), actions);
    else {
      const one = this.button('+1', t('action.plus1Aria'), () => this.act(timer.id, 'extend', 60), actions); one.disabled = timer.total >= MAX; one.dataset.focus = 'extend1';
      const extend = this.button('+5', t('action.plus5Aria'), () => this.act(timer.id, 'extend', 300), actions); extend.disabled = timer.total >= MAX; extend.dataset.focus = 'extend';
      this.button('↻', t('action.restart'), () => this.act(timer.id, 'restart'), actions, 'ft-icon');
    }
    this.el('span', 'ft-actions-gap', '', actions);
    this.button(t('action.cancel'), t('action.removeAria'), () => this.act(timer.id, 'remove'), actions, 'ft-muted');
    this.button('−', t('action.collapse'), () => this.closePanel(), actions, 'ft-muted ft-icon');
  }
  renderFinished() {
    // Only countdowns raise a card: a stopwatch was closed by its own finish handler.
    const finished = this.timers.filter(t => t.state === 'finished' && t.mode === 'down');
    if (!finished.length) return;
    const stack = this.el('div', 'ft-alert-stack');
    for (const timer of finished) {
      const island = this.el('section', 'ft-island', '', stack); island.setAttribute('aria-label', t('island.aria', { name: timer.name }));
      this.el('span', 'ft-glint', '', island);
      const dismiss = this.button('×', t('island.close', { name: timer.name }), () => this.act(timer.id, 'remove'), island, 'ft-island-close'); dismiss.dataset.focus = `dismiss-${timer.id}`;
      const copy = this.el('div', 'ft-island-copy', '', island);
      this.el('span', 'ft-island-eyebrow', t('island.eyebrow'), copy); const title = this.el('strong', '', timer.name, copy); title.title = timer.name;
      const actions = this.el('div', 'ft-island-actions', '', island);
      for (const minutes of [1, 5, 30]) this.button(t('island.extend', { n: minutes }), t('island.extendAria', { n: minutes }), () => this.act(timer.id, 'extend', minutes * 60), actions);
      this.button('↻', t('action.restart'), () => this.act(timer.id, 'restart'), actions);
    }
  }
  // Finishing a stopwatch (button or the note's own checkbox) removes it; true when the rail changed.
  retireFinishedUp() {
    const gone = this.timers.filter(t => t.mode === 'up' && t.state === 'finished');
    if (!gone.length) return false;
    this.timers = this.timers.filter(t => !(t.mode === 'up' && t.state === 'finished'));
    if (gone.some(t => t.id === this.selectedId)) this.selectedId = null;
    return true;
  }
  async act(id, action, seconds) {
    const timer = this.timers.find(t => t.id === id); if (!timer) return;
    this.tick();
    if (timer.mode === 'up') {
      if (!this.trackerReady) { new Notice(t('notice.trackerNotReady')); return; }
      if (this.trackerAction) return;
      this.trackerAction = true;
      try {
        if (action === 'toggle') await this.bridge.toggle(timer);
        if (action === 'finish') { await this.bridge.finish(timer); this.retireFinishedUp(); }
        if (action === 'restart') await this.bridge.start(timer, true);
        if (action === 'remove') {
          if (timer.state !== 'finished') await this.bridge.finish(timer, true);
          this.timers = this.timers.filter(t => t.id !== id);
          if (this.selectedId === id) this.selectedId = null;
        }
        await this.persist(); this.render();
      } finally { this.trackerAction = false; }
      return;
    }
    if (action === 'finish') { timer.finish(); this.record(timer); this.flushLogs(); }
    if (action === 'toggle') { if (timer.state === 'running') timer.pause(); else if (timer.state === 'paused') { this.prepareAudio(); timer.resume(); } }
    if (action === 'extend') { this.prepareAudio(); timer.extend(seconds); }
    if (action === 'restart') { this.prepareAudio(); timer.start(); }
    if (action === 'remove') { this.timers = this.timers.filter(t => t.id !== id); if (this.selectedId === id) this.selectedId = null; }
    this.persist(); this.render();
  }
  setLayout(layout) { this.cancelDrag(); this.layout = layout === 'vertical' ? 'vertical' : 'horizontal'; this.persist(); this.render(); }
  update() {
    const now = Date.now();
    for (const timer of this.timers) {
      const ref = this.rings?.get(timer.id); if (!ref) continue;
      const left = timer.mode === 'up' ? timer.elapsed(now) : timer.left(now), lastMinute = timer.mode === 'down' && left <= 60 && timer.state !== 'finished';
      ref.button.dataset.mode = timer.mode;
      ref.button.dataset.state = timer.state; ref.button.classList.toggle('is-seconds', lastMinute);
      ref.number.textContent = timer.mode === 'up' ? String(Math.floor(left / 60)) : timer.state === 'finished' ? '0' : String(Math.ceil(lastMinute ? left : left / 60));
      ref.arc.style.setProperty('--ft-progress', String(timer.mode === 'up' ? (left % 60) / 60 : Math.max(0, Math.min(1, left / timer.total))));
      ref.ticks.style.setProperty('--ft-progress', String(Math.max(0, Math.min(1, left / 60))));
      const label = `${timer.name} · ${timer.state === 'finished' ? t('ring.done') : format(left)}${timer.state === 'paused' ? t('ring.paused') : ''}`;
      ref.button.setAttribute('aria-label', label);
      if (this.tooltipShown === timer.id) this.tooltip.textContent = label;
    }
    if (this.preview && this.draft) {
      this.preview.textContent = this.draft.mode === 'up' ? t('preview.up') : this.draft.seconds ? t('preview.end', { time: new Date(now + this.draft.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('preview.empty');
      if (this.draft.mode !== 'up') { this.dragHandle.setAttribute('aria-valuenow', String(this.draft.seconds / 60)); this.dragHandle.setAttribute('aria-valuetext', format(this.draft.seconds)); }
    }
    const selected = this.timers.find(t => t.id === this.selectedId);
    if (this.detailTime && selected) {
      const up = selected.mode === 'up', value = up ? selected.elapsed(now) : selected.left(now);
      this.detailTime.textContent = format(value);
      const end = !up && selected.state === 'running' ? t('detail.ends', { time: new Date(selected.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : '';
      this.detailSub.textContent = `${selected.state === 'paused' ? t('detail.paused') : up ? t('detail.elapsed') : t('detail.remaining')}${up ? '' : t('detail.total', { time: format(selected.total) })}${end}`;
      this.detailBar.style.width = `${(up ? (value % 60) / 60 : Math.max(0, Math.min(1, value / selected.total))) * 100}%`;
    }
    this.updateStatus(now);
  }
  tick() {
    const finished = this.timers.filter(t => t.tick());
    if (finished.length) {
      for (const timer of finished) this.record(timer);
      this.persist(); this.flushLogs();
      // Preserve pointer capture and typed drafts when another timer finishes.
      if (!this.drag) this.render();
      if (!this.host) new Notice(t('notice.finished', { names: finished.map(x => x.name).join(t('list.sep')) }), 8000);
      if (this.sound) this.chime();
      this.notifySystem(finished.map(t => t.name));
    } else if (this.retireFinishedUp()) { this.persist(); this.render(); }
    this.update();
  }
  prepareAudio() {
    if (!this.sound) return;
    try {
      if (!this.audio || this.audio.state === 'closed') this.audio = new window.AudioContext();
      this.audio.resume().catch(() => {});
    } catch (_) { /* Completion notices remain available without audio. */ }
  }
  async chime() {
    this.prepareAudio(); if (!this.audio) return;
    try {
      await this.audio.resume(); if (this.disposed) return;
      for (const [i, frequency] of [660, 880, 1100].entries()) {
        const oscillator = this.audio.createOscillator(), gain = this.audio.createGain(), start = this.audio.currentTime + i * 0.19;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.08, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.65);
        oscillator.connect(gain); gain.connect(this.audio.destination); oscillator.start(start); oscillator.stop(start + 0.7);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
    } catch (_) { /* The host may suspend audio in the background. */ }
  }
  onunload() {
    this.disposed = true; this.statusEl?.remove(); this.cancelDrag(); this.root?.remove(); this.host?.classList.remove('fluxtimer-host'); this.audio?.close().catch(() => {});
  }
};
class FluxSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName(t('set.language.name')).setDesc(t('set.language.desc')).addDropdown(dropdown => dropdown.addOption('zh', '中文').addOption('en', 'English').addOption('auto', t('set.language.auto')).setValue(this.plugin.language).onChange(value => { this.plugin.setLanguage(value); this.display(); }));
    const preview = this.containerEl.createDiv({ cls: 'fluxtimer ft-settings-preview' });
    preview.style.setProperty('--ft-size', `${this.plugin.iconSize}px`);
    const rail = this.plugin.el('div', 'ft-rail', '', preview);
    // One sample per state, so the colour of each mode can be checked in both themes.
    for (const [mode, state, progress, value, label] of [['down', 'running', '.7', '12', t('set.preview.down')], ['up', 'running', '.35', '8', t('set.preview.up')], ['down', 'paused', '.5', '5', t('set.preview.paused')], ['down', 'finished', '0', '0', t('set.preview.finished')]]) {
      const ring = this.plugin.button('', label, () => {}, rail, 'ft-ring');
      ring.dataset.mode = mode; ring.dataset.state = state;
      this.plugin.el('span', 'ft-ring-track', '', ring);
      const arc = this.plugin.el('span', 'ft-ring-arc', '', ring); arc.style.setProperty('--ft-progress', progress);
      this.plugin.el('span', 'ft-ring-number', value, ring); this.plugin.el('span', 'ft-pause-mark', 'Ⅱ', ring);
    }
    this.plugin.button('+', t('set.preview.size'), () => {}, rail, 'ft-add');
    new Setting(this.containerEl).setName(t('set.size.name')).setDesc(t('set.size.desc')).addSlider(slider => slider.setLimits(20, 48, 1).setValue(this.plugin.iconSize).setDynamicTooltip().onChange(value => { this.plugin.setIconSize(value); preview.style.setProperty('--ft-size', `${value}px`); }));
    new Setting(this.containerEl).setName(t('set.log.name')).setDesc(t('set.log.desc')).addDropdown(dropdown => {
      const paths = new Set(['提示事项.md', this.plugin.logPath, ...this.app.vault.getMarkdownFiles().map(file => file.path)]);
      for (const path of [...paths].sort()) dropdown.addOption(path, path);
      dropdown.setValue(this.plugin.logPath).onChange(async value => {
        try { await this.plugin.ensureLogFile(value); this.plugin.logPath = value; await this.plugin.persist(); }
        catch (error) { this.plugin.logError(error); dropdown.setValue(this.plugin.logPath); }
      });
    }).addButton(button => button.setButtonText(t('set.log.retry')).onClick(() => this.plugin.flushLogs()));
    new Setting(this.containerEl).setName(t('set.presets.name')).setDesc(t('set.presets.desc')).addText(text => {
      text.setPlaceholder(t('set.presets.placeholder')).setValue(presetsText(this.plugin.presetList()));
      text.inputEl.style.width = '260px';
      text.inputEl.addEventListener('blur', () => {
        const presets = parsePresets(text.getValue());
        if (!presets.length && text.getValue().trim()) { new Notice(t('notice.badPresets')); text.setValue(presetsText(this.plugin.presetList())); return; }
        // Saving the untouched default text keeps presets language-following.
        if (presetsText(presets) === presetsText(this.plugin.presetList())) return;
        this.plugin.presets = presets; this.plugin.persist(); text.setValue(presetsText(presets)); this.plugin.render();
      });
    }).addExtraButton(button => button.setIcon('rotate-ccw').setTooltip(t('set.presets.reset')).onClick(() => { this.plugin.presets = null; this.plugin.persist(); this.display(); }));
    new Setting(this.containerEl).setName(t('set.status.name')).setDesc(t('set.status.desc')).addToggle(toggle => toggle.setValue(this.plugin.statusBar).onChange(value => { this.plugin.statusBar = value; this.plugin.persist(); this.plugin.updateStatus(); }));
    new Setting(this.containerEl).setName(t('set.notify.name')).setDesc(t('set.notify.desc')).addToggle(toggle => toggle.setValue(this.plugin.notify).onChange(value => { this.plugin.notify = value; this.plugin.persist(); }));
    new Setting(this.containerEl).setName(t('set.sound.name')).setDesc(t('set.sound.desc')).addToggle(toggle => toggle.setValue(this.plugin.sound).onChange(value => { this.plugin.sound = value; this.plugin.persist(); }));
    new Setting(this.containerEl).setName(t('set.layout.name')).setDesc(t('set.layout.desc')).addDropdown(dropdown => dropdown.addOption('horizontal', t('set.layout.horizontal')).addOption('vertical', t('set.layout.vertical')).setValue(this.plugin.layout).onChange(value => this.plugin.setLayout(value)));
    if (this.plugin.trackerReady) {
      new Setting(this.containerEl).setName(t('set.tracker.name')).setDesc(t('set.tracker.desc')).addButton(button => button.setButtonText(t('set.tracker.log')).onClick(() => this.plugin.bridge.tracker.activateLogView())).addButton(button => button.setButtonText(t('set.tracker.stats')).onClick(() => this.plugin.bridge.tracker.activateDashboardView())).addButton(button => button.setButtonText(t('set.tracker.export')).onClick(() => this.plugin.bridge.export()));
      const details = this.containerEl.createEl('details'); details.createEl('summary', { text: t('set.tracker.full') });
      this.plugin.bridge.showSettings(details.createDiv());
    }
    new Setting(this.containerEl).setName(t('set.usage.name')).setDesc(t('set.usage.desc'));
  }
}
module.exports.Timer = Timer;
module.exports.parseDuration = parseDuration;
module.exports.dragDuration = dragDuration;
module.exports.parsePresets = parsePresets;
module.exports.t = (key, vars) => t(key, vars);
module.exports.setLang = lang => { FT_LANG = lang; };
module.exports.restore = restore;

module.exports.appendRecord = appendRecord;
