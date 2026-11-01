import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NativeBoard, bindNativeBoardWindow, readNativeRegistration } from '../dist/main/native-board.js';

test('a reloaded or crashed page ends the native view it can no longer close', () => {
  const contents = new EventEmitter();
  let closed = 0;
  const parent = Object.assign(new EventEmitter(), { webContents: contents, close: () => { closed++; } });
  let disposed = 0, refreshed = 0;
  bindNativeBoardWindow(parent, { refreshLayout: () => { refreshed++; }, dispose: async () => { disposed++; } });
  parent.emit('moved');
  assert.equal(refreshed, 1);
  contents.emit('did-navigate', {}, 'file:///index.html');
  assert.equal(disposed, 1, 'a reload must not leave the child running behind a new page');
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(disposed, 2, 'a crashed page must not leave the child running');
  assert.equal(closed, 0);
});

test('native view only launches its local registration; private pipes omit parent secrets and close cleanly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odm-native-test-'));
  const entry = path.join(root, 'view.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import {createInterface} from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const p=JSON.parse(line);
      if(p.type==='init') console.log(JSON.stringify({native:1,type:'ready'}));
      if(p.type==='message' && p.message.type==='request-reload') console.log(JSON.stringify({native:1,type:'reload'}));
      else if(p.type==='message') console.log(JSON.stringify({native:1,type:'message',message:{odm:1,type:'tile',x:2,y:3,secretPresent:!!process.env.ODM_NATIVE_TEST_SECRET}}));
      if(p.type==='close'){fs.writeFileSync(${JSON.stringify(path.join(root,'closed'))},'closed');process.exit(0);}
    }`);
  const config = path.join(root, 'native.json');
  fs.writeFileSync(config, JSON.stringify({ addonId:'sample',viewId:'map',root,entry:'view.mjs',settings:{} }));
  const registration = readNativeRegistration(config);
  const packets=[];
  process.env.ODM_NATIVE_TEST_SECRET='must-not-reach-addon';
  const reloads=[];
  const manager=new NativeBoard(registration,{node:process.execPath,parentWindow:'123',emit:(_owner,_id,p)=>packets.push(p),reload:owner=>reloads.push(owner)});
  try {
    assert.equal(await manager.open(7,{addonId:'unregistered',viewId:'map'}),null);
    const opened=await manager.open(7,{addonId:'sample',viewId:'map'});
    assert.ok(opened?.id);
    assert.throws(()=>manager.send(8,opened.id,{type:'snapshot'}),/Refused/);
    manager.send(7,opened.id,{odm:1,type:'snapshot',snapshot:{width:4,height:4}});
    for(let i=0;i<100&&!packets.length;i++) await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(packets[0],{odm:1,type:'tile',x:2,y:3,secretPresent:false});
    manager.send(7,opened.id,{type:'request-reload'});
    for(let i=0;i<100&&!reloads.length;i++) await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(reloads,[7],'a native reload reaches its owning page');
    const layout={bounds:{x:0,y:0,width:100,height:80},occlusions:[],visible:true,scale:1};
    manager.layout(7,opened.id,layout);
    const stdin=manager.active.child.stdin;
    Object.defineProperty(stdin,'writableLength',{configurable:true,get:()=>5*1024*1024});
    assert.throws(()=>manager.layout(7,opened.id,layout),/not reading/);
    assert.doesNotThrow(()=>manager.refreshLayout(),'a window move must not throw in the main process');
    delete stdin.writableLength;
    await assert.rejects(manager.close(8,opened.id),/Refused/);
    const closing=Promise.all([manager.close(7,opened.id),manager.close(7,opened.id)]);
    const reopening=manager.open(7,{addonId:'sample',viewId:'map'});
    await closing;
    assert.equal(fs.readFileSync(path.join(root,'closed'),'utf8'),'closed');
    assert.throws(()=>manager.send(7,opened.id,{}),/Refused/);
    const reopened=await reopening;
    assert.ok(reopened?.id);
    await manager.close(7,reopened.id);
    fs.writeFileSync(config,JSON.stringify({addonId:'sample',viewId:'map',root,entry:'../outside.mjs'}));
    assert.throws(()=>readNativeRegistration(config),/native registration/i);
  } finally {
    delete process.env.ODM_NATIVE_TEST_SECRET;
    await manager.dispose();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('a renderer that fails during readiness cannot return a stale usable session', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'odm-native-race-'));
  fs.writeFileSync(path.join(root,'view.mjs'),String.raw`import fs from 'node:fs'; import {createInterface} from 'node:readline';
    for await(const line of createInterface({input:process.stdin})) {
      const p=JSON.parse(line);
      if(p.type==='init') {
        fs.writeFileSync(${JSON.stringify(path.join(root,'ready-written'))},'ready then malformed');
        process.stdout.write(JSON.stringify({native:1,type:'ready'})+'\nnot-json\n');
      }
      if(p.type==='close') process.exit(0);
    }`);
  const config=path.join(root,'native.json');
  fs.writeFileSync(config,JSON.stringify({addonId:'sample',viewId:'map',root,entry:'view.mjs'}));
  const manager=new NativeBoard(readNativeRegistration(config),{node:process.execPath,parentWindow:'123',emit(){}});
  try {
    await assert.rejects(manager.open(7,{addonId:'sample',viewId:'map'}),/Native view/);
    assert.equal(fs.readFileSync(path.join(root,'ready-written'),'utf8'),'ready then malformed');
  }
  finally{await manager.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('a process that cannot spawn releases its registration after close', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'odm-native-spawn-'));
  fs.writeFileSync(path.join(root,'view.mjs'),'');
  const config=path.join(root,'native.json');
  fs.writeFileSync(config,JSON.stringify({addonId:'sample',viewId:'map',root,entry:'view.mjs'}));
  const manager=new NativeBoard(readNativeRegistration(config),{node:path.join(root,'missing-node.exe'),parentWindow:'123',emit(){}});
  try {
    await assert.rejects(manager.open(7,{addonId:'sample',viewId:'map'}));
    assert.equal(manager.active,null);
  } finally {
    await manager.dispose();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('a failed force kill retains the child and permits close to be retried', {skip:process.platform!=='win32'}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'odm-native-stuck-'));
  fs.writeFileSync(path.join(root,'view.mjs'),`import {createInterface} from 'node:readline';
    for await(const line of createInterface({input:process.stdin})) {
      const p=JSON.parse(line);
      if(p.type==='init') console.log(JSON.stringify({native:1,type:'ready'}));
    }`);
  const config=path.join(root,'native.json');
  fs.writeFileSync(config,JSON.stringify({addonId:'sample',viewId:'map',root,entry:'view.mjs'}));
  const manager=new NativeBoard(readNativeRegistration(config),{node:process.execPath,parentWindow:'123',emit(){}});
  let pid, childExited;
  try {
    const opened=await manager.open(7,{addonId:'sample',viewId:'map'});
    pid=manager.active.child.pid;
    childExited=new Promise(resolve=>manager.active.child.once('close',resolve));
    t.mock.method(childProcess,'execFile',(_file,_args,_options,callback)=>callback(new Error('taskkill refused')));
    await assert.rejects(manager.close(7,opened.id),/Native view timed out/);
    assert.equal(manager.active?.child.pid,pid,'the live child must remain owned');
    await assert.rejects(manager.open(7,{addonId:'sample',viewId:'map'}),/already open/);
    process.kill(pid,'SIGKILL');
    await manager.close(7,opened.id);
    assert.equal(manager.active,null);
  } finally {
    t.mock.restoreAll();
    if(pid) { try { process.kill(pid,'SIGKILL'); } catch {} }
    if(childExited) await childExited;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
