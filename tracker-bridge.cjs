// Integration adapter for the bundled Task Time Tracker 0.0.31.
const vendorModule = require('./vendor/task-time-tracker.cjs');
const Tracker = vendorModule.default;
const { Notice } = require('obsidian');
const taskId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
class TrackerBridge {
  constructor(owner, Timer, appendRecord) { this.owner = owner; this.Timer = Timer; this.appendRecord = appendRecord; this.queue = Promise.resolve(); this.finishing = new Map(); }
  serial(fn) { const result = this.queue.then(fn); this.queue = result.catch(error => { console.error('fluxtimer tracker', error); new Notice(t('notice.syncFailed')); }); return result; }
  async init() {
    const p = this.owner, adapter = p.app.vault.adapter;
    const dir = p.manifest.dir || `${p.app.vault.configDir}/plugins/fluxtimer`;
    const path = `${dir}/tracker-data.json`;
    // Only one engine should own task tracking; ask the user to disable the standalone plugin rather than doing it for them.
    if (p.app.plugins?.enabledPlugins?.has?.('task-time-tracker')) new Notice(t('notice.oldDisabled'), 10000);
    if (!(await adapter.exists(path))) {
      const source = `${p.app.vault.configDir}/plugins/task-time-tracker/data.json`;
      const data = await adapter.exists(source) ? JSON.parse(await adapter.read(source)) : {};
      await adapter.write(`${dir}/tracker-migration-backup.json`, JSON.stringify(data, null, 2));
      await adapter.write(path, JSON.stringify(data, null, 2));
    }
    // Before construction: the vendor's startup dialogs and command names read the table immediately.
    this.applyLanguage(p.language);
    const tracker = this.tracker = new Tracker(p.app, { ...p.manifest, name: t('tracker.name') });
    tracker.loadData = async () => JSON.parse(await adapter.read(path));
    tracker.saveData = async data => { await adapter.write(path, JSON.stringify(data, null, 2)); };
    tracker.addSettingTab = tab => { this.settings = tab; };
    this.commands = [];
    tracker.addCommand = command => { this.commands.push(command); return command; };
    // Attach lifetime to the host, but await the vendor's asynchronous initialization ourselves.
    const initialize = tracker.onload.bind(tracker); tracker.onload = () => {};
    p.addChild(tracker); await initialize();
    const start = tracker.trackingEngine.start.bind(tracker.trackingEngine);
    const stop = tracker.trackingEngine.stop.bind(tracker.trackingEngine);
    tracker.trackingEngine.start = (...args) => this.serial(async () => { const result = await start(...args); this.sync(); return result; });
    tracker.trackingEngine.stop = () => this.serial(async () => { const result = await stop(); this.sync(); return result; });
    const notify = tracker.notifyTrackingChanged.bind(tracker);
    tracker.notifyTrackingChanged = () => { this.sync(); notify(); };
    this.sync();
    // Adopt pre-integration stopwatch state without dropping elapsed time.
    for (const timer of p.timers.filter(t => t.mode === 'up' && !t.taskId && t.state !== 'finished')) {
      const elapsed = timer.elapsed(); timer.taskId = taskId(); timer.taskPath = p.logPath;
      timer.managedTask = timer.recordName;
      if (timer.recordName) await this.ensureTask(timer);
      if (elapsed > 0) await tracker.store.addEntry({ id: `migrated-${timer.taskId}`, taskId: timer.taskId, taskText: timer.name, filePath: timer.taskPath, start: Date.now() - elapsed * 1000, end: Date.now() });
      if (timer.state === 'running') await tracker.trackingEngine.start(timer.taskId, timer.name, timer.taskPath);
    }
    this.sync(); await p.persist();
  }
  // 'auto' lets the vendor keep its own es/en choice; zh gets fluxtimer's Chinese table.
  applyLanguage(language) {
    const locale = obsidianLocale();
    const lang = language === 'auto' ? (locale.startsWith('zh') ? 'zh' : locale.startsWith('es') ? 'es' : 'en') : language;
    vendorModule.__ftSetLang?.(lang);
  }
  setLanguage(language) {
    this.applyLanguage(language);
    if (this.tracker) { try { this.refresh(); } catch (error) { console.error('fluxtimer: language refresh', error); } }
  }
  refresh() { this.tracker.statusBarWidget.refresh(); this.tracker.refreshLogViews(); this.tracker.inlineControlsBus.notify(); }
  sync() {
    if (this.owner.disposed) return;
    const p = this.owner, engine = this.tracker.trackingEngine, active = engine.getActiveEntry();
    let changed = false;
    if (active && !p.timers.some(t => t.taskId === active.taskId)) {
      const timer = new this.Timer({ id: `timer-${p.nextId++}`, mode: 'up', name: active.taskText, state: 'paused' });
      timer.taskId = active.taskId; timer.taskPath = active.filePath; timer.recordName = true;
      p.timers.push(timer); changed = true;
    }
    for (const timer of p.timers.filter(t => t.mode === 'up' && t.taskId)) {
      const running = active?.taskId === timer.taskId;
      if (timer.state === 'finished' && !running) continue;
      const state = running ? 'running' : 'paused';
      changed ||= timer.state !== state;
      timer.state = state; timer.elapsedStored = engine.getAccumulatedMs(timer.taskId) / 1000;
      if (running) timer.resumedAt = active.start;
    }
    if (changed) { p.render(); p.persist(); } else p.update();
  }
  async ensureTask(timer) {
    const file = await this.owner.ensureLogFile(timer.taskPath);
    await this.owner.app.vault.process(file, text => this.appendRecord(text, { id: timer.taskId, name: timer.name, minutes: 0, endedAt: Date.now(), open: true }));
  }
  async start(timer, restart = false) {
    if (restart) { timer.taskId = ''; timer.logged = false; }
    if (!timer.taskId) {
      timer.taskId = taskId(); timer.taskPath = this.owner.logPath; timer.managedTask = timer.recordName;
      if (timer.recordName) await this.ensureTask(timer);
    }
    await this.tracker.trackingEngine.start(timer.taskId, timer.name, timer.taskPath);
    this.sync(); this.refresh(); await this.owner.persist();
  }
  async toggle(timer) {
    if (this.tracker.trackingEngine.getActiveEntry()?.taskId === timer.taskId) await this.tracker.trackingEngine.stop();
    else await this.start(timer);
    this.refresh();
  }
  finish(timer, cancelled = false) {
    if (this.finishing.has(timer.id)) return this.finishing.get(timer.id);
    const job = this.finishOnce(timer, cancelled).finally(() => this.finishing.delete(timer.id));
    this.finishing.set(timer.id, job); return job;
  }
  async finishOnce(timer, cancelled = false) {
    if (this.tracker.trackingEngine.getActiveEntry()?.taskId === timer.taskId) await this.tracker.trackingEngine.stop();
    timer.elapsedStored = this.tracker.trackingEngine.getAccumulatedMs(timer.taskId) / 1000;
    timer.state = 'finished'; timer.endedAt = Date.now(); timer.logged = true;
    if (cancelled && timer.managedTask) {
      // Only discard sessions owned by this new task; never erase imported task history.
      await this.tracker.store.apply(state => { state.entries = state.entries.filter(e => e.taskId !== timer.taskId); return { result: null }; });
    } else if (!cancelled && timer.recordName) {
      const resolved = await this.tracker.taskIdentifier.resolvePreferring(timer.taskId, timer.taskPath);
      const file = resolved && this.owner.app.vault.getAbstractFileByPath(resolved.filePath);
      if (file) await this.owner.app.vault.process(file, text => {
        const marker = `[tt-id:: ${timer.taskId}]`, minutes = Math.round(timer.elapsedStored / 60);
        if (timer.managedTask) {
          const without = text.split('\n').filter(line => !line.includes(marker)).join('\n');
          return this.appendRecord(without, { id: timer.taskId, name: timer.name, minutes, endedAt: timer.endedAt });
        }
        return text.split('\n').map(line => line.includes(marker) ? line.replace(/^(\s*(?:[-*+]|\d+\.)\s*)\[.\]/, '$1[x]').replace(/\s+\d+分钟(?=\s*\[tt-id::)/, '').replace(marker, `${minutes}分钟 ${marker}`) : line).join('\n');
      });
    }
    this.refresh(); await this.owner.persist(); this.owner.render();
  }
  async taskClosed(text) {
    for (const timer of this.owner.timers.filter(t => t.mode === 'up' && t.taskId && t.state !== 'finished')) {
      const line = text.split('\n').find(line => line.includes(`[tt-id:: ${timer.taskId}]`));
      if (line && /^\s*(?:[-*+]|\d+\.)\s*\[[xX-]\]/.test(line)) await this.finish(timer, /^\s*(?:[-*+]|\d+\.)\s*\[-\]/.test(line));
    }
  }
  async addCompleted(entry) {
    await this.tracker.store.addEntry({ id: `fluxtimer-${entry.id}`, taskId: entry.id.replace(/[^a-zA-Z0-9]/g, ''), taskText: entry.name, filePath: entry.path, start: entry.endedAt - (entry.seconds ?? entry.minutes * 60) * 1000, end: entry.endedAt });
    this.refresh();
  }
  showSettings(container) { this.settings.containerEl = container; this.settings.display(); }
  export() { this.commands.find(command => command.id === 'export-time-entries')?.callback?.(); }
}
module.exports = TrackerBridge;
