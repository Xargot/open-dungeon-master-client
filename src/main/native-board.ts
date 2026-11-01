import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn, execFile, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import type {BrowserWindow} from 'electron';
import {nativeLayout} from '../shared/native-board';

const MAX_PACKET = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
interface Registration {addonId: string; viewId: string; root: string; entry: string; settings: object}

export function readNativeRegistration(file?: string): Registration | null {
  if (!file) return null;
  try {
    if (fs.statSync(file).size > 16384) throw Error();
    const r = JSON.parse(fs.readFileSync(file,'utf8')) as Registration;
    if (!ID.test(r.addonId) || !ID.test(r.viewId) || typeof r.root !== 'string' || !path.isAbsolute(r.root)
      || typeof r.entry !== 'string' || path.isAbsolute(r.entry) || !r.entry.endsWith('.mjs')) throw Error();
    const root = fs.realpathSync(r.root), entry = fs.realpathSync(path.resolve(root,r.entry));
    const relative = path.relative(root,entry);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) throw Error();
    const settings = r.settings ?? {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || JSON.stringify(settings).length > 4096) throw Error();
    return {addonId:r.addonId,viewId:r.viewId,root,entry,settings};
  } catch { throw new Error('Invalid local native registration.'); }
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Native view timed out.')),ms);})])
    .finally(()=>clearTimeout(timer));
}

type Active = {id:string; owner:number; child:ChildProcessWithoutNullStreams; exited:Promise<void>; stopped:boolean; closing:boolean; closed?:Promise<void>; layout?:unknown};
export class NativeBoard {
  private active: Active | null = null;
  private ownerRevision = 0;
  constructor(private registration: Registration | null, private options: {
    node:string; parentWindow:string; emit:(owner:number,id:string,packet:unknown)=>void; reload?:(owner:number)=>void;
  }) {}

  async open(owner:number,key:{addonId:string;viewId:string}):Promise<{id:string}|null> {
    const r=this.registration;
    if (!r || key?.addonId!==r.addonId || key?.viewId!==r.viewId) return null;
    const revision=this.ownerRevision;
    if (this.active?.closing) await this.active.closed;
    if (revision!==this.ownerRevision) throw Error('Native view stopped during startup.');
    if (this.active) throw Error('A native view is already open.');
    const env:NodeJS.ProcessEnv={ELECTRON_RUN_AS_NODE:'1'};
    for(const name of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']) {
      if(process.env[name]) env[name]=process.env[name];
    }
    const child=spawn(this.options.node,[r.entry],{cwd:r.root,env,windowsHide:true,stdio:'pipe'});
    let resolveReady:()=>void, rejectReady:(error:Error)=>void;
    const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    let resolveExited:()=>void;
    const exited=new Promise<void>(resolve=>{resolveExited=resolve;});
    const active:Active={id:randomUUID(),owner,child,exited,stopped:false,closing:false};
    this.active=active;
    child.once('close',()=>{
      active.stopped=true;
      resolveExited();
      if(active.closing && this.active===active) this.active=null;
    });
    const fail=()=> {
      rejectReady(Error('Native view stopped.'));
      if(!active.closing) this.options.emit(owner,active.id,{odm:1,type:'error',message:'Native view stopped.'});
      void this.close(owner,active.id).catch(()=>{});
    };
    child.on('error',fail);
    child.on('close',()=>{if(!active.closing) fail();});
    child.stdin.on('error',fail);
    // Drain diagnostics without retaining potentially sensitive addon output.
    child.stderr.on('data',()=>{});
    const decoder=new StringDecoder('utf8');
    let buffer='';
    child.stdout.on('data',(chunk:Buffer)=>{
      buffer+=decoder.write(chunk);
      if(Buffer.byteLength(buffer)>MAX_PACKET) { fail(); return; }
      let end:number;
      while((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end); buffer=buffer.slice(end+1);
        try {
          const p=JSON.parse(line);
          if(p.native!==1) { fail();return; }
          if(p.type==='ready') resolveReady();
          else if(p.type==='reload') { if(this.active===active && !active.closing) this.options.reload?.(owner); }
          else if(p.type==='message' && p.message && typeof p.message==='object') this.options.emit(owner,active.id,p.message);
          else { fail();return; }
        } catch { fail();return; }
      }
    });
    this.write(active,{native:1,type:'init',parentWindow:this.options.parentWindow,settings:r.settings});
    try {
      await deadline(ready,15000);
      if (active.closing || this.active !== active) throw Error('Native view stopped during startup.');
      return {id:active.id};
    }
    catch(error) { await this.close(owner,active.id); throw error; }
  }

  private owned(owner:number,id:string):Active {
    if(!this.active || this.active.owner!==owner || this.active.id!==id || this.active.closing) throw Error('Refused.');
    return this.active;
  }
  private write(active:Active,packet:unknown):void {
    const line=JSON.stringify(packet);
    if(!line || Buffer.byteLength(line)>MAX_PACKET) throw Error('Native packet too large.');
    if(active.child.stdin.writableLength>MAX_PACKET) throw Error('Native view is not reading.');
    active.child.stdin.write(line+'\n');
  }
  send(owner:number,id:string,packet:unknown):void { this.write(this.owned(owner,id),{native:1,type:'message',message:packet}); }
  layout(owner:number,id:string,raw:unknown):void {
    const active=this.owned(owner,id),layout=nativeLayout(raw);
    if(!layout) throw Error('Invalid native layout.');
    active.layout=layout;
    this.write(active,{native:1,type:'layout',...layout});
  }
  refreshLayout():void {
    const active=this.active;
    // Called from window move and resize listeners, where a throw is an
    // uncaught main-process error: a child that stopped reading keeps its
    // last layout instead.
    try { if(active?.layout && !active.closing) this.layout(active.owner,active.id,active.layout); }
    catch { /* The page's next layout or close reaches the same refusal. */ }
  }
  async close(owner:number,id:string):Promise<void> {
    const active=this.active;
    if(!active) return;
    if(active.owner!==owner || active.id!==id) throw Error('Refused.');
    if(active.closed) { await active.closed;return; }
    active.closing=true;
    active.closed=(async()=>{
    try {
      if(active.child.exitCode===null && !active.child.stdin.destroyed) this.write(active,{native:1,type:'close'});
      await deadline(active.exited,5000);
    } catch {
      if(active.child.exitCode===null) {
        if(process.platform==='win32' && active.child.pid) {
          await new Promise<void>(resolve=>execFile('taskkill',['/PID',String(active.child.pid),'/T','/F'],{windowsHide:true},()=>resolve()));
        } else active.child.kill('SIGKILL');
        await deadline(active.exited,5000);
      }
    } finally { if(active.stopped && this.active===active) this.active=null; }
    })();
    try { await active.closed; }
    catch(error) {
      // A failed force kill must not release a still-running child or cache a rejected close.
      if(!active.stopped) active.closed=undefined;
      throw error;
    }
  }
  async dispose():Promise<void> { this.ownerRevision++; if(this.active) await this.close(this.active.owner,this.active.id); }
}

// Ties the board to the window it draws in. A reload (View > Reload) or a
// crashed page drops the only copy of the session id, so nothing could close
// the child: its window stayed drawn over the shell and every later open was
// refused as already open. The window's own navigation and crash end it.
export function bindNativeBoardWindow(parent: BrowserWindow, board: Pick<NativeBoard,'refreshLayout'|'dispose'>): void {
  const refresh = () => board.refreshLayout();
  parent.on('move', refresh);
  parent.on('moved', refresh);
  parent.on('resized', refresh);
  let closing = false;
  parent.on('close', (event) => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void board.dispose().catch(() => {}).finally(() => parent.close());
  });
  const end = () => { void board.dispose().catch(() => {}); };
  parent.webContents.on('did-navigate', end);
  parent.webContents.on('render-process-gone', end);
}
