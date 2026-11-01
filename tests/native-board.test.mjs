import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeBoard, readNativeRegistration } from '../dist/main/native-board.js';

test('native view only launches its local registration; private pipes omit parent secrets and close cleanly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odm-native-test-'));
  const entry = path.join(root, 'view.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import {createInterface} from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const p=JSON.parse(line);
      if(p.type==='init') console.log(JSON.stringify({native:1,type:'ready'}));
      if(p.type==='message') console.log(JSON.stringify({native:1,type:'message',message:{odm:1,type:'tile',x:2,y:3,secretPresent:!!process.env.ODM_NATIVE_TEST_SECRET}}));
      if(p.type==='close'){fs.writeFileSync(${JSON.stringify(path.join(root,'closed'))},'closed');process.exit(0);}
    }`);
  const config = path.join(root, 'native.json');
  fs.writeFileSync(config, JSON.stringify({ addonId:'sample',viewId:'map',root,entry:'view.mjs',settings:{} }));
  const registration = readNativeRegistration(config);
  const packets=[];
  process.env.ODM_NATIVE_TEST_SECRET='must-not-reach-addon';
  const manager=new NativeBoard(registration,{node:process.execPath,parentWindow:'123',emit:(_owner,_id,p)=>packets.push(p)});
  try {
    assert.equal(await manager.open(7,{addonId:'unregistered',viewId:'map'}),null);
    const opened=await manager.open(7,{addonId:'sample',viewId:'map'});
    assert.ok(opened?.id);
    assert.throws(()=>manager.send(8,opened.id,{type:'snapshot'}),/Refused/);
    manager.send(7,opened.id,{odm:1,type:'snapshot',snapshot:{width:4,height:4}});
    for(let i=0;i<100&&!packets.length;i++) await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(packets[0],{odm:1,type:'tile',x:2,y:3,secretPresent:false});
    await assert.rejects(manager.close(8,opened.id),/Refused/);
    await Promise.all([manager.close(7,opened.id),manager.close(7,opened.id)]);
    assert.equal(fs.readFileSync(path.join(root,'closed'),'utf8'),'closed');
    assert.throws(()=>manager.send(7,opened.id,{}),/Refused/);
    const reopened=await manager.open(7,{addonId:'sample',viewId:'map'});
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
  fs.writeFileSync(path.join(root,'view.mjs'),`import {createInterface} from 'node:readline';
    for await(const line of createInterface({input:process.stdin})) {
      const p=JSON.parse(line);
      if(p.type==='init') process.stdout.write(JSON.stringify({native:1,type:'ready'})+'\\nnot-json\\n');
      if(p.type==='close') process.exit(0);
    }`);
  const config=path.join(root,'native.json');
  fs.writeFileSync(config,JSON.stringify({addonId:'sample',viewId:'map',root,entry:'view.mjs'}));
  const manager=new NativeBoard(readNativeRegistration(config),{node:process.execPath,parentWindow:'123',emit(){}});
  try {await assert.rejects(manager.open(7,{addonId:'sample',viewId:'map'}),/Native view/);}
  finally{await manager.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
