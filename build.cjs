// Bundle with the Obsidian-provided require so obsidian/CodeMirror resolve in all modules.
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const source = read('main.source.js');
const i18n = read('i18n.cjs');
const vendor = read('vendor/task-time-tracker.cjs');
const bridge = read('tracker-bridge.cjs');
// The vendor picks its string table once (`hr`) from Obsidian's locale; expose a setter so
// fluxtimer's language setting also drives it. Fail loudly if a vendor update renames these.
if (!vendor.includes('var hr=pr()==="es"?gt:dt;')) throw new Error('vendor string table not found; update the language hook in build.cjs');
const langHook = `\n;module.exports.__ftSetLang = lang => { hr = lang === 'zh' ? Object.assign({}, dt, TTT_ZH) : lang === 'es' ? gt : dt; };\n`;
const bundle = `${source}\n${i18n}\nfunction loadTrackerBridge(hostRequire) {\nconst vendor = {exports:{}};\n(function(require,module,exports){\n${vendor}${langHook}\n})(hostRequire,vendor,vendor.exports);\nconst bridge = {exports:{}};\n(function(require,module,exports){\n${bridge}\n})(name => name === './vendor/task-time-tracker.cjs' ? vendor.exports : hostRequire(name),bridge,bridge.exports);\nreturn bridge.exports;\n}\n`;
fs.writeFileSync(path.join(__dirname, 'main.js'), bundle);
