const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
const styles = fs.readFileSync(path.join(__dirname,'../styles.css'),'utf8');
(async () => {
 const browser = await chromium.launch({headless:true,channel:process.env.FLUXTIMER_BROWSER || 'chrome'});
 try {
  const page = await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:2});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<style>
   *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;--text-normal:#304058;--text-muted:#7b879a;--background-primary:#fff;--background-secondary:#f3f6fa;background:#fff}
   body.theme-dark{--text-normal:#eff5ff;--text-muted:#afc1de;--background-primary:#172239;--background-secondary:#1d304c;background:#172239}
   header{height:48px;padding:15px 24px;color:var(--text-muted);font-size:13px;border-bottom:1px solid #8881}#note{height:640px;width:100%;position:relative}.note-copy{padding:300px 80px 0;color:var(--text-muted)}h1{font-weight:500;color:var(--text-normal)}
   ${styles}</style><header>⌂ index / fluxtimer</header><main id="note"><div class="note-copy"><h1>留一点时间，给当下。</h1><p>fluxtimer · 专注于当前笔记</p></div></main><div id="other"></div>`);
  await page.evaluate(source => {
   window.notices=[];window.saved=[];window.intervals=[];window.events={};
   const nativeSetInterval=window.setInterval;window.setInterval=fn=>{window.intervals.push(fn);return 1;};
   class Plugin {
    async loadData(){return {sound:false};}async saveData(data){window.saved.push(data);}
    addSettingTab(){}addCommand(){}registerEvent(){}registerInterval(){}registerDomEvent(el,type,fn,options){el.addEventListener(type,fn,options);return fn;}
   }
   window.module={exports:{}};
   window.require=()=>({Plugin,PluginSettingTab:class {},Setting:class {},Notice:class {constructor(message){notices.push(message);}},Menu:class {addItem(){return this;}showAtMouseEvent(){}}});
   // Evaluate the actual distributable with host API shims; no Obsidian UI automation.
   (0,eval)(source);
   window.plugin=new module.exports();
   window.noteLeaf={view:{getViewType:()=> 'markdown',contentEl:document.querySelector('#note')}};
   plugin.app={vault:{on:()=>({}),getAbstractFileByPath:()=>({extension:'md'}),getMarkdownFiles:()=>[],process:async()=>{}},workspace:{activeLeaf:noteLeaf,getActiveViewOfType(){const v=this.activeLeaf?.view;return v?.getViewType?.()==='markdown'?v:null;},on:(name,fn)=>{events[name]=fn;return{};},onLayoutReady:fn=>fn()}};
   window.ready=plugin.onload();window.nativeSetInterval=nativeSetInterval;
  },source);
  await page.evaluate(()=>ready);
  const add=()=>page.getByRole('button',{name:'新增计时器（右键切换布局）',exact:true});
  await add().click();
  await page.getByRole('textbox',{name:'时长，输入分钟或分:秒，Enter 开始'}).fill('00:45');
  await page.getByRole('textbox',{name:'提醒名称'}).fill('阅读片刻');
  await page.getByRole('textbox',{name:'提醒名称'}).press('Enter');
  assert.equal(await page.locator('.ft-ring').count(),1);
  assert.equal(await page.locator('.ft-ring.is-seconds').count(),1);
  await add().click();
  await page.getByRole('textbox',{name:'提醒名称'}).fill('深度专注');
  const handle=page.getByRole('slider');const box=await handle.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+36,box.y+box.height/2,{steps:8});await page.mouse.up();
  assert.equal(await page.locator('.ft-ring').count(),2);
  assert.equal(await page.evaluate(()=>plugin.timers[1].selected),720);
  await page.locator('.ft-ring').nth(1).click();await page.getByRole('button',{name:'暂停或继续'}).click();
  assert.equal(await page.evaluate(()=>plugin.timers[1].state),'paused');
  await page.getByRole('button',{name:'延长五分钟'}).click();assert.equal(await page.evaluate(()=>plugin.timers[1].total),1020);
  await page.getByRole('button',{name:'暂停或继续'}).click();assert.equal(await page.evaluate(()=>plugin.timers[1].state),'running');
  // An outside pointer folds the opened ring; it swallows neither the click nor the focus.
  await page.mouse.click(12,620);
  assert.equal(await page.locator('.ft-detail').count(),0);
  assert.equal(await page.evaluate(()=>plugin.selectedId),null);
  await add().click();
  await page.getByRole('textbox',{name:'提醒名称'}).fill('未完成的输入');
  await page.evaluate(()=>{plugin.timers[0].deadline=Date.now()-1;plugin.tick();plugin.tick();});
  assert.equal(await page.locator('.ft-island').count(),1);assert.equal(await page.evaluate(()=>notices.length),1);
  assert.equal(await page.getByRole('textbox',{name:'提醒名称'}).inputValue(),'未完成的输入');
  assert.equal(await page.getByRole('textbox',{name:'提醒名称'}).evaluate(el=>el===document.activeElement),true);
  // The draft composer is deliberately exempt: an outside click keeps its typed input.
  await page.mouse.click(12,620);
  assert.equal(await page.locator('.ft-composer').count(),1);
  assert.equal(await page.getByRole('textbox',{name:'提醒名称'}).inputValue(),'未完成的输入');
  await page.getByRole('button',{name:'再计时 1 分钟',exact:true}).click();
  assert.equal(await page.locator('.ft-island').count(),0);assert.equal(await page.evaluate(()=>plugin.timers[0].total),60);
  // A cancelled pointer sequence does not create a timer.
  const cancelBox = await page.getByRole('slider').boundingBox();
  await page.mouse.move(cancelBox.x+10,cancelBox.y+10);await page.mouse.down();await page.mouse.move(cancelBox.x+40,cancelBox.y+10);
  await page.getByRole('slider').dispatchEvent('pointercancel');await page.mouse.up();
  await page.evaluate(()=>{plugin.cancelDrag();plugin.closePanel();});
  assert.equal(await page.locator('.ft-ring').count(),2);
  await add().click();await page.getByRole('textbox',{name:'时长，输入分钟或分:秒，Enter 开始'}).fill('181');
  await page.getByRole('textbox',{name:'时长，输入分钟或分:秒，Enter 开始'}).press('Enter');assert.equal(await page.locator('.ft-ring').count(),2);
  await page.getByRole('textbox',{name:'时长，输入分钟或分:秒，Enter 开始'}).fill('5');
  await page.getByRole('textbox',{name:'提醒名称'}).fill('休息一下');await page.getByRole('textbox',{name:'提醒名称'}).press('Enter');
  await page.evaluate(()=>{plugin.timers[0].deadline=Date.now()-1;plugin.tick();});
  await page.screenshot({animations:'disabled',path:'/tmp/fluxtimer-v2-light.png'});
  await page.evaluate(()=>document.body.classList.add('theme-dark'));
  await page.screenshot({animations:'disabled',path:'/tmp/fluxtimer-v2-dark.png'});
  await add().click();await page.screenshot({animations:'disabled',path:'/tmp/fluxtimer-v2-composer.png'});
  await page.evaluate(()=>{plugin.closePanel();plugin.setLayout('vertical');});
  const boxes=await page.locator('.ft-ring').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y};}));
  assert.equal(boxes[0].x,boxes[1].x);assert.notEqual(boxes[0].y,boxes[1].y);
  await page.screenshot({animations:'disabled',path:'/tmp/fluxtimer-v2-vertical.png'});
  await page.setViewportSize({width:320,height:700});
  await page.screenshot({animations:'disabled',path:'/tmp/fluxtimer-v2-narrow.png'});
  const overflow=await page.locator('.fluxtimer button, .fluxtimer input').evaluateAll(els=>els.filter(el=>{const r=el.getBoundingClientRect();return r.left<0||r.right>innerWidth;}).map(el=>el.className));
  assert.deepEqual(overflow,[],'controls must stay inside note width');
  await page.evaluate(()=>{plugin.app.workspace.activeLeaf={view:{getViewType:()=> 'canvas'}};plugin.mount();});
  assert.equal(await page.locator('.fluxtimer').count(),0);
  await page.evaluate(()=>{plugin.app.workspace.activeLeaf={view:{getViewType:()=> 'markdown',contentEl:document.querySelector('#other')}};plugin.mount();});
  assert.equal(await page.locator('#other .fluxtimer').count(),1);assert.equal(await page.locator('#note.fluxtimer-host').count(),0);
  await page.evaluate(()=>plugin.onunload());assert.equal(await page.locator('.fluxtimer').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS browser interactions, multi-timer isolation, draft focus, reminder extension, layouts, narrow width, remount and unload');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
