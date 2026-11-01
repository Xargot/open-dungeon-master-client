import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {NativeBoard} from '../dist/main/native-board.js';

const require=createRequire(import.meta.url);

function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'odm-native-reload-'));
  const entry=path.join(root,'view.mjs');
  fs.writeFileSync(entry,`import {createInterface} from 'node:readline';
    for await(const line of createInterface({input:process.stdin})) {
      const p=JSON.parse(line);
      if(p.type==='init') setTimeout(()=>console.log(JSON.stringify({native:1,type:'ready'})),40);
      if(p.type==='message'&&p.message.type==='fixture-reload') console.log(JSON.stringify({native:1,type:'reload'}));
      if(p.type==='close') setTimeout(()=>process.exit(0),80);
    }`);
  const ipc=new EventEmitter(),handlers=new Map();
  ipc.handle=(name,handler)=>handlers.set(name,handler);
  const contents=Object.assign(new EventEmitter(),{id:7,send(){}});
  contents.reload=()=>{
    contents.emit('did-start-navigation',{url:'file:///shell.html',isSameDocument:false,isMainFrame:true});
    contents.emit('reload-requested');
  };
  const parent=Object.assign(new EventEmitter(),{
    webContents:contents,isDestroyed:()=>false,getNativeWindowHandle:()=>Buffer.alloc(8),
  });
  const event={sender:contents,senderFrame:{parent:null,url:'file:///shell.html'}};
  let manager;
  const dependencies={
    electron:{ipcMain:ipc},
    './native-board':{
      readNativeRegistration:()=>({addonId:'sample',viewId:'map',root,entry,settings:{}}),
      NativeBoard:class extends NativeBoard {constructor(...args){super(...args);manager=this;}},
    },
    './servers':{LOCAL_SERVER_ID:'local'},
    './home-feed':{createDesktopHomeFeed:()=>({})},
    './offer-notices':{createDesktopOfferNotices:()=>({})},
    './app-icon':{appIconPath:()=>''},
    './public-url-sync':{createPublicUrlSync:()=>async()=>{}},
    '../shared/story-memory':{storyMemorySupported:()=>false},
  };
  const exports={};
  vm.runInNewContext(fs.readFileSync(new URL('../dist/main/ipc.js',import.meta.url),'utf8'),{
    exports,require:id=>id.startsWith('node:')?require(id):(dependencies[id]??{}),
    process:{...process,platform:'win32',env:{}},Buffer,console,
    setInterval:()=>({unref(){}}),
  });
  const statusSource={onStatus(){}};
  exports.registerIpc({
    store:{},local:statusSource,tunnel:statusSource,localAi:statusSource,updater:statusSource,
    window:{dialogParent:()=>parent,isMainSender:sender=>sender===contents,
      isShellPage:e=>e.sender===contents&&e.senderFrame.parent===null},
  });
  const call=(name,...args)=>handlers.get(name)(event,...args);
  const mount=()=>ipc.emit('game:mounted',event,'local');
  return {contents,call,mount,event,manager,
    async cleanup(){await manager.dispose();fs.rmSync(root,{recursive:true,force:true});}};
}

test('Ctrl+R releases the old native board, revokes its mount, and allows immediate re-entry',async()=>{
  const s=setup();
  try {
    s.mount();
    const first=await s.call('native-board:open',{addonId:'sample',viewId:'map'});
    // Frame loads and same-document navigation must not interrupt the board.
    s.contents.emit('did-start-navigation',{url:'https://frame.invalid/',isSameDocument:false,isMainFrame:false});
    s.call('native-board:send',first.id,{odm:1,type:'scene'});
    s.contents.emit('did-start-navigation',{url:'file:///shell.html#hash',isSameDocument:true,isMainFrame:true});
    s.call('native-board:send',first.id,{odm:1,type:'scene'});
    s.contents.emit('did-start-navigation',{url:'file:///shell.html',isSameDocument:false,isMainFrame:true});
    assert.throws(()=>s.call('native-board:send',first.id,{}),/Refused/);
    assert.throws(()=>s.call('native-board:open',{addonId:'sample',viewId:'map'}),/Refused/);
    s.mount();
    const next=await s.call('native-board:open',{addonId:'sample',viewId:'map'});
    assert.notEqual(next.id,first.id);
    await assert.rejects(s.call('native-board:close',first.id),/Refused/);
    s.call('native-board:send',next.id,{odm:1,type:'scene'});
  } finally {await s.cleanup();}
});

test('renderer failure releases its board and clears local-game authority',async()=>{
  const s=setup();
  try {
    s.mount();
    await s.call('native-board:open',{addonId:'sample',viewId:'map'});
    s.contents.emit('render-process-gone',{}, {reason:'crashed'});
    assert.throws(()=>s.call('native-board:open',{addonId:'sample',viewId:'map'}),/Refused/);
    s.mount();
    assert.ok((await s.call('native-board:open',{addonId:'sample',viewId:'map'})).id);
  } finally {await s.cleanup();}
});

test('reloading during native startup cancels that session and permits a fresh one',async()=>{
  const s=setup();
  try {
    s.mount();
    const opening=s.call('native-board:open',{addonId:'sample',viewId:'map'});
    const rejected=assert.rejects(opening,/Native view/);
    s.contents.emit('did-start-navigation',{url:'file:///shell.html',isSameDocument:false,isMainFrame:true});
    s.mount();
    const next=s.call('native-board:open',{addonId:'sample',viewId:'map'});
    await rejected;
    assert.ok((await next).id);
  } finally {await s.cleanup();}
});

test('a second reload cancels re-entry queued behind the previous shutdown',async()=>{
  const s=setup();
  const reload=()=>s.contents.emit('did-start-navigation',{url:'file:///shell.html',isSameDocument:false,isMainFrame:true});
  try {
    s.mount();
    await s.call('native-board:open',{addonId:'sample',viewId:'map'});
    reload();
    s.mount();
    const stale=s.call('native-board:open',{addonId:'sample',viewId:'map'});
    const rejected=assert.rejects(stale,/Native view/);
    reload();
    await rejected;
    s.mount();
    assert.ok((await s.call('native-board:open',{addonId:'sample',viewId:'map'})).id);
  } finally {await s.cleanup();}
});

test('Ctrl+R from the native child reloads its own local shell and allows re-entry',async()=>{
  const s=setup();
  try {
    s.mount();
    const first=await s.call('native-board:open',{addonId:'sample',viewId:'map'});
    const reload=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Native shortcut did not reload the shell.')),1500);
      s.contents.once('reload-requested',()=>{clearTimeout(timeout);resolve();});
    });
    s.call('native-board:send',first.id,{type:'fixture-reload'});
    await reload;
    assert.throws(()=>s.call('native-board:send',first.id,{}),/Refused/);
    s.mount();
    assert.notEqual((await s.call('native-board:open',{addonId:'sample',viewId:'map'})).id,first.id);
  } finally {await s.cleanup();}
});
