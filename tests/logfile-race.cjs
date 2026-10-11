// Regression test: ensureLogFile must never surface Obsidian's "File already exists."
// Loads the real distributable (../main.js) with a stubbed obsidian module, and models
// Vault.create exactly as Obsidian implements it: `if (await adapter.exists(path)) throw
// new Error("File already exists.")`, with the vault index lagging behind disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const context = {
  module: { exports: {} },
  require: () => ({ Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, Menu: class {}, setIcon() {} }),
  console,
  Date,
  setTimeout,
  clearTimeout,
  window: { setInterval: () => 1 },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
const FluxTimer = context.module.exports;

// Mirrors Obsidian: disk (`files`) is the source of truth for adapter.exists, while
// `index` is the Vault file map consulted by getAbstractFileByPath. Both are async,
// which is what opens the window between the pre-check and create().
const makeVault = () => {
  const files = new Set();
  const index = new Map();
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  return {
    files,
    index,
    on: () => ({}),
    getAbstractFileByPath: p => index.get(p) ?? null,
    adapter: { exists: async p => { await tick(); return files.has(p); } },
    create: async p => {
      await tick();                                   // Obsidian awaits adapter.exists(path)
      if (files.has(p)) throw new Error('File already exists.');
      files.add(p);                                   // adapter.write(path, '')
      const file = { path: p, extension: 'md' };
      index.set(p, file);                             // index catches up
      return file;
    },
    process: async (file, fn) => fn(''),
  };
};
const plugin = vault => { const p = new FluxTimer(); p.app = { vault }; return p; };

let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

(async () => {
  // Two callers race on a path that does not exist yet (onload line 113, flushLogs,
  // the settings "记录文档" path, or the tracker bridge's ensureTask) — all of them
  // reach the same plugin instance, which is the only owner of the log file.
  await test('concurrent ensureLogFile calls resolve on one file', async () => {
    const vault = makeVault();
    const p = plugin(vault);
    const results = await Promise.allSettled([
      p.ensureLogFile('提示事项.md'),
      p.ensureLogFile('提示事项.md'),
    ]);
    const rejected = results.filter(r => r.status === 'rejected');
    assert.deepEqual(rejected.map(r => r.reason.message), [], 'no caller may see "File already exists."');
    assert.equal(results[0].value, results[1].value);
    assert.equal(vault.files.size, 1);
  });

  // Same plugin instance, as in the real vault: onload awaits ensureLogFile and
  // then flushLogs() ensures it again while the first create is still in flight.
  await test('ensureLogFile then flushLogs does not double-create', async () => {
    const vault = makeVault();
    const p = plugin(vault);
    const first = p.ensureLogFile('提示事项.md');
    const second = p.ensureLogFile('提示事项.md');
    await assert.doesNotReject(() => Promise.all([first, second]));
    assert.equal(vault.files.size, 1);
  });

  // The file exists on disk (external write, git checkout, sync) but the vault index
  // has not indexed it yet: create() would throw, so the index must be waited out.
  await test('adopts a file already on disk once the index catches up', async () => {
    const vault = makeVault();
    vault.files.add('提示事项.md');                    // on disk, unindexed
    setTimeout(() => vault.index.set('提示事项.md', { path: '提示事项.md', extension: 'md' }), 40);
    const file = await plugin(vault).ensureLogFile('提示事项.md');
    assert.equal(file.path, '提示事项.md');
    assert.equal(vault.files.size, 1);
  });

  // A non-Markdown binding path must still be rejected.
  await test('rejects a non-markdown binding path', async () => {
    const vault = makeVault();
    vault.index.set('附件', { path: '附件', extension: 'txt' });
    await assert.rejects(() => plugin(vault).ensureLogFile('附件'), /绑定路径不是 Markdown 文档/);
  });

  // Every caller in one tick (onload, flushLogs, settings, bridge ensureTask).
  await test('twenty concurrent callers still create exactly one file', async () => {
    const vault = makeVault();
    const p = plugin(vault);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => p.ensureLogFile('提示事项.md')));
    assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.message), []);
    assert.equal(new Set(results.map(r => r.value)).size, 1);
    assert.equal(vault.files.size, 1);
  });

  // A file that never appears in the index must fail loudly and boundedly, not hang
  // and not be reported as success.
  await test('still rejects when the index never catches up', async () => {
    const vault = makeVault();
    vault.files.add('孤儿.md');
    await assert.rejects(() => plugin(vault).ensureLogFile('孤儿.md'), /File already exists\./);
  });

  // A failure must not poison the queue: the next record still writes.
  await test('a failed call does not block the next one', async () => {
    const vault = makeVault();
    const p = plugin(vault);
    vault.files.add('孤儿.md');
    await assert.rejects(() => p.ensureLogFile('孤儿.md'), /File already exists\./);
    const file = await p.ensureLogFile('提示事项.md');
    assert.equal(file.path, '提示事项.md');
  });

  console.log(`PASS logfile race (${checks} checks)`);
})().catch(error => { console.error(error); process.exit(1); });
