'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
const {Server,utils}=require('ssh2');
async function create(work) {
  const clients=new Set(),children=new Set(),shellInput=[],commands=[];
  const privateKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
  const bash=process.platform==='win32'?['C:/Program Files/Git/bin/bash.exe','C:/Program Files/Git/usr/bin/bash.exe'].find(p=>fs.existsSync(p)):'/bin/bash';
  const local=value=>{const p=path.resolve(work,String(value).replace(/^\/workspace\/?/,''));if(p!==work&&!p.startsWith(work+path.sep))throw Object.assign(Error('outside fixture'),{code:'EACCES'});return p;};
  const attrs=stat=>({mode:stat.mode,uid:0,gid:0,size:stat.size,atime:Math.floor(stat.atimeMs/1000),mtime:Math.floor(stat.mtimeMs/1000)});
  function sftpServer(sftp){
    const handles=new Map();let serial=0;const S=utils.sftp.STATUS_CODE;
    const status=(id,error)=>sftp.status(id,error?error.code==='ENOENT'?S.NO_SUCH_FILE:error.code==='EACCES'?S.PERMISSION_DENIED:S.FAILURE:S.OK);
    const on=(event,fn)=>sftp.on(event,(id,...args)=>{try{fn(id,...args);}catch(e){status(id,e);}});
    on('REALPATH',(id,p)=>{if(p==='.')sftp.name(id,[{filename:'/home/fixture',longname:'home',attrs:attrs(fs.statSync(work))}]);else {const full=local(p);fs.realpathSync(full);sftp.name(id,[{filename:'/workspace'+path.relative(work,full).replace(/\\/g,'/').replace(/^(.+)/,'/$1'),longname:p,attrs:attrs(fs.statSync(full))}]);}});
    for(const method of ['STAT','LSTAT'])on(method,(id,p)=>sftp.attrs(id,attrs(fs[method==='STAT'?'statSync':'lstatSync'](local(p)))));
    on('OPENDIR',(id,p)=>{const handle=Buffer.from(String(++serial)),full=local(p);handles.set(handle.toString(),{files:fs.readdirSync(full).map(filename=>({filename,longname:filename,attrs:attrs(fs.lstatSync(path.join(full,filename)))}))});sftp.handle(id,handle);});
    on('READDIR',(id,handle)=>{const h=handles.get(handle.toString());if(!h.files.length)return sftp.status(id,S.EOF);sftp.name(id,h.files.splice(0,100));});
    on('OPEN',(id,p,flags,a)=>{const fd=fs.openSync(local(p),utils.sftp.flagsToString(flags),a.mode||0o644),handle=Buffer.from(String(++serial));handles.set(handle.toString(),{fd});sftp.handle(id,handle);});
    on('FSTAT',(id,h)=>sftp.attrs(id,attrs(fs.fstatSync(handles.get(h.toString()).fd))));
    on('READ',(id,h,offset,length)=>{const buffer=Buffer.alloc(length),n=fs.readSync(handles.get(h.toString()).fd,buffer,0,length,offset);if(n)sftp.data(id,buffer.subarray(0,n));else sftp.status(id,S.EOF);});
    on('WRITE',(id,h,offset,data)=>{fs.writeSync(handles.get(h.toString()).fd,data,0,data.length,offset);status(id);});
    on('CLOSE',(id,h)=>{const item=handles.get(h.toString());if(item?.fd!=null)fs.closeSync(item.fd);handles.delete(h.toString());status(id);});
    on('MKDIR',(id,p,a)=>{fs.mkdirSync(local(p),{mode:a.mode||0o755});status(id);});
    on('RENAME',(id,oldName,newName)=>{fs.renameSync(local(oldName),local(newName));status(id);});
    on('REMOVE',(id,p)=>{fs.unlinkSync(local(p));status(id);});
    on('SETSTAT',(id,p,a)=>{if(a.mode!=null)fs.chmodSync(local(p),a.mode);status(id);});
    sftp.on('EXTENDED',(id)=>sftp.status(id,S.OP_UNSUPPORTED));
    sftp.on('close',()=>{for(const h of handles.values())if(h.fd!=null)try{fs.closeSync(h.fd);}catch{}});
  }
  const server=new Server({hostKeys:[privateKey]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>ctx.username==='fixture'&&ctx.method==='password'&&ctx.password==='fixture-password'?ctx.accept():ctx.reject());
    client.on('ready',()=>client.on('session',accept=>{
      const session=accept();session.on('pty',accept=>accept());session.on('window-change',(accept)=>accept?.());session.on('sftp',accept=>sftpServer(accept()));
      session.on('shell',accept=>{const stream=accept();stream.write('REMOTE_SHELL_READY\r\n');stream.on('data',data=>{shellInput.push(String(data));stream.write(data);});});
      session.on('exec',(accept,_reject,info)=>{
        commands.push(info.command);const stream=accept();
        if(info.command.includes('new Function')){stream.stderr.write('bash: node: command not found\n');stream.exit(127);stream.end();return;}
        const child=spawn(bash,['-c',info.command],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(child);
        stream.on('data',b=>child.stdin.write(b));stream.on('end',()=>child.stdin.end());child.stdin.on('error',()=>{});
        child.stdout.on('data',b=>{if(!stream.destroyed)stream.write(b);});child.stderr.on('data',b=>{if(!stream.destroyed)stream.stderr.write(b);});
        child.on('close',code=>{children.delete(child);if(!stream.destroyed){stream.exit(code||0);stream.end();}});child.on('error',()=>{stream.exit(1);stream.end();});stream.on('close',()=>child.kill());
      });
    }));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {port:server.address().port,shellInput,commands,async close(){for(const c of children)c.kill();for(const c of clients)c.end();await new Promise(r=>server.close(r));}};
}
module.exports={create};
