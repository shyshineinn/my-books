const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createAuthStore } = require('../src/db/auth');
const { EMPTY_READING_DATA } = require('../src/core/mobile-reading');

test('公开书库下阅读同步仍私有，强校验续传与文件替换后重新下载', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-v3-http-'));
  const auth = createAuthStore(path.join(root, 'data', 'auth.json'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ADMIN_TOKEN: '', MYBOOKS_STORAGE_DIR: root,
      MYBOOKS_PUBLIC_READ: 'true', MYBOOKS_SEED_DEMO: 'false' }, stdio: ['ignore','pipe','pipe'] });
  let log=''; child.stderr.on('data',data=>{log+=data;});
  try {
    const base = await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('启动超时 '+log)),15000);
      child.once('exit',()=>{clearTimeout(timer);reject(Error('服务器退出 '+log));});
      child.stdout.on('data',data=>{const m=String(data).match(/http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});
    });
    await auth.initialize('admin','integration-password');
    const login=await (await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:'admin',password:'integration-password'})})).json();
    const headers={Authorization:'Bearer '+login.token};
    const jsonHeaders={...headers,'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/api/books')).status,200);
    assert.equal((await fetch(base+'/api/sync/changes')).status,401);
    const book=await (await fetch(base+'/api/books',{method:'POST',headers:jsonHeaders,body:JSON.stringify({title:'Sync'})})).json();
    const full=await (await fetch(base+'/api/v1/sync/changes',{headers})).json();
    assert.equal(full.sync_version,3);assert.equal(full.complete,true);
    const noChanges=await (await fetch(base+'/api/sync/changes?cursor='+full.cursor,{headers})).json();
    assert.deepEqual(noChanges.books,[]);assert.deepEqual(noChanges.reading,[]);
    assert.equal((await fetch(base+'/api/sync/changes?cursor=bad',{headers})).status,410);
    assert.equal((await fetch(base+'/api/sync/changes?q=filtered',{headers})).status,400);
    assert.equal((await fetch(base+'/api/sync/reading/'+book.id)).status,401);
    const empty=await (await fetch(base+'/api/sync/reading/'+book.id,{headers})).json();assert.equal(empty.revision,0);
    const data=EMPTY_READING_DATA();data.positions.push({format:'TXT',fileSha256:'',lastReadTime:123,readingProgress:.5,locatorJson:'{}',sourceDeviceId:'android-a'});
    const payload={library_id:full.library_id,expected_uuid:book.uuid,expected_revision:0,data};
    const saved=await fetch(base+'/api/sync/reading/'+book.id,{method:'PUT',headers:jsonHeaders,body:JSON.stringify(payload)});
    assert.equal(saved.status,200);assert.equal((await saved.json()).revision,1);
    const conflict=await fetch(base+'/api/sync/reading/'+book.id,{method:'PUT',headers:jsonHeaders,body:JSON.stringify(payload)});
    assert.equal(conflict.status,409);assert.equal((await conflict.json()).current.revision,1);
    const delta=await (await fetch(base+'/api/sync/changes?cursor='+full.cursor,{headers})).json();
    assert.equal(delta.books.length,0);assert.equal(delta.reading[0].revision,1);
    async function upload(bytes) {
      const form=new FormData();form.append('file',new Blob([bytes]),'book.txt');
      const response=await fetch(base+'/api/books/'+book.id+'/file',{method:'POST',headers,body:form});
      assert.equal(response.status,201);return (await response.json()).file;
    }
    const original=crypto.randomBytes(120000); const file=await upload(original);
    const detail=await (await fetch(base+'/api/books/'+book.id,{headers})).json();
    const url=base+detail.files[0].download_url;
    const publicFile=await fetch(url);assert.equal(publicFile.status,200);await publicFile.arrayBuffer();
    const first=await fetch(url,{headers}); const etag=first.headers.get('etag');
    assert.match(etag,/^"sha256-[a-f0-9]{64}"$/);
    assert.equal(first.headers.get('x-content-sha256'),crypto.createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(Buffer.from(await first.arrayBuffer()),original);
    const resumed=await fetch(url,{headers:{...headers,Range:'bytes=60000-','If-Range':etag}});
    assert.equal(resumed.status,206);assert.equal(resumed.headers.get('content-range'),'bytes 60000-119999/120000');
    assert.deepEqual(Buffer.from(await resumed.arrayBuffer()),original.subarray(60000));
    const replacement=crypto.randomBytes(original.length);const next=await upload(replacement);assert.equal(next.id,file.id);
    const restarted=await fetch(url,{headers:{...headers,Range:'bytes=60000-','If-Range':etag}});
    assert.equal(restarted.status,200);assert.notEqual(restarted.headers.get('etag'),etag);
    assert.deepEqual(Buffer.from(await restarted.arrayBuffer()),replacement);
    assert.equal((await fetch(url.replace('uuid='+book.uuid,'uuid=other'),{headers})).status,409);
    const invalid=await fetch(url,{headers:{...headers,Range:'bytes=999999-'}});assert.equal(invalid.status,416);await invalid.arrayBuffer();
  } finally {
    child.kill();if(child.exitCode===null)await once(child,'exit');
    if(path.dirname(root)!==path.resolve(os.tmpdir()))throw Error('拒绝清理非临时测试目录');
    fs.rmSync(root,{recursive:true,force:true});
  }
});
