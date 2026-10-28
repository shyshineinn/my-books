const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createAuthStore } = require('../src/db/auth');

test('资料书架同步始终私有，资源校验与续传、并发上传和快照 CAS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-state-http-'));
  const auth = createAuthStore(path.join(root, 'data', 'auth.json'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST:'127.0.0.1', PORT:'0', ADMIN_TOKEN:'', MYBOOKS_STORAGE_DIR:root,
      MYBOOKS_PUBLIC_READ:'true', MYBOOKS_SEED_DEMO:'false' }, stdio:['ignore','pipe','pipe'] });
  let log=''; child.stderr.on('data', data => { log += data; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer=setTimeout(() => reject(Error('启动超时 '+log)), 15000);
      child.once('exit', () => { clearTimeout(timer); reject(Error('服务器退出 '+log)); });
      child.stdout.on('data', data => { const match=String(data).match(/http:\/\/localhost:(\d+)/);
        if(match) { clearTimeout(timer); resolve('http://127.0.0.1:'+match[1]); } });
    });
    await auth.initialize('admin', 'integration-password');
    const login=await (await fetch(base+'/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:'admin',password:'integration-password'}) })).json();
    const headers={Authorization:'Bearer '+login.token}, jsonHeaders={...headers,'Content-Type':'application/json'};
    const stateUrl=base+'/api/sync/state';
    const body=crypto.randomBytes(90000), sha=crypto.createHash('sha256').update(body).digest('hex');
    const assetUrl=stateUrl+'/assets/'+sha+'.jpg';
    for(const [url,method] of [[stateUrl,'GET'],[stateUrl,'PUT'],[assetUrl,'GET'],[assetUrl,'HEAD'],[assetUrl,'PUT']]) {
      assert.equal((await fetch(url,{method})).status,401);
    }
    const initial=await (await fetch(stateUrl,{headers})).json();
    assert.equal(initial.revision,0); assert.equal(initial.data,null);
    const assetHeaders={...headers,'Content-Type':'application/octet-stream'};
    assert.equal((await fetch(assetUrl,{method:'PUT',headers:assetHeaders,body:Buffer.from('wrong')})).status,400);
    assert.equal((await fetch(assetUrl,{headers})).status,404);
    const uploads=await Promise.all([1,2,3].map(() => fetch(assetUrl,{method:'PUT',headers:assetHeaders,body})));
    for(const uploaded of uploads) { assert.equal(uploaded.status,200); assert.deepEqual(await uploaded.json(),{sha256:sha,size:body.length}); }
    const full=await fetch(assetUrl,{headers});
    assert.equal(full.headers.get('cache-control'),'private, no-store');
    assert.equal(full.headers.get('x-content-sha256'),sha);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),body);
    const etag='"sha256-'+sha+'"';
    const range=await fetch(assetUrl,{headers:{...headers,Range:'bytes=50000-','If-Range':etag}});
    assert.equal(range.status,206); assert.equal(range.headers.get('content-range'),'bytes 50000-89999/90000');
    assert.deepEqual(Buffer.from(await range.arrayBuffer()),body.subarray(50000));
    const head=await fetch(assetUrl,{method:'HEAD',headers});
    assert.equal(head.headers.get('etag'),etag); assert.equal(head.headers.get('content-length'),'90000');
    const data={schemaVersion:1,createdAt:1,sourceDeviceId:'android-a',bookIdentities:{},
      preferences:[{key:'avatar_path',type:'string',value:'asset://'+sha,updatedAt:1,deviceId:'android-a'}],
      assets:[{id:sha,kind:'avatar',ownerId:'profile',fileName:sha+'.jpg',sha256:sha,sizeBytes:body.length}]};
    for(const name of ['books','folders','bookFolderLinks','tags','annotationTags','bookTagLinks','readingRecords','bookmarks',
      'notes','tombstones','highlightRules','bookHighlightRuleStates','bookHighlightSettings','highlightRuleExclusions']) data[name]=[];
    const request={library_id:initial.library_id,expected_revision:0,data};
    const save=await fetch(stateUrl,{method:'PUT',headers:jsonHeaders,body:JSON.stringify(request)});
    assert.equal(save.status,200); assert.equal((await save.json()).revision,1);
    const conflict=await fetch(stateUrl,{method:'PUT',headers:jsonHeaders,body:JSON.stringify(request)});
    assert.equal(conflict.status,409); assert.equal((await conflict.json()).current.revision,1);
    const changes=await (await fetch(base+'/api/sync/changes',{headers})).json();
    assert.equal(changes.portable_sync,true); assert.equal(changes.portable_revision,1);
    assert.deepEqual((await (await fetch(stateUrl,{headers})).json()).data,data);
  } finally {
    child.kill(); if(child.exitCode===null) await once(child,'exit');
    if(path.dirname(root)!==path.resolve(os.tmpdir())) throw Error('拒绝清理非临时测试目录');
    fs.rmSync(root,{recursive:true,force:true});
  }
});
