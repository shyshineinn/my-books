const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDb } = require('../src/db/index');
const books = require('../src/db/books');
const { parseBook } = require('../src/core/book');
const { getPortableState, putPortableState } = require('../src/db/mobile-portable');
const { getSyncChanges } = require('../src/db/sync-v3');
const { validatePortableState } = require('../src/core/mobile-portable');
const directories = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-portable-')); directories.push(root); return openDb(root); }
after(() => directories.forEach((dir) => { if (path.dirname(dir) !== path.resolve(os.tmpdir())) throw Error('非测试临时目录'); fs.rmSync(dir, { recursive: true, force: true }); }));
const empty = () => ({ schemaVersion:1,createdAt:1,sourceDeviceId:'device-a',bookIdentities:{},preferences:[],books:[],folders:[],
  bookFolderLinks:[],tags:[],annotationTags:[],bookTagLinks:[],readingRecords:[],bookmarks:[],notes:[],tombstones:[],assets:[],
  highlightRules:[],bookHighlightRuleStates:[],bookHighlightSettings:[],highlightRuleExclusions:[] });
const input = (db, data, revision=0) => ({ library_id:getPortableState(db).library_id,expected_revision:revision,data });
test('v18 初始状态与能力声明独立于书目版本', () => {
  const db=fixture();try { const state=getPortableState(db);assert.equal(state.revision,0);assert.equal(state.data,null);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,22);const changes=getSyncChanges(db);assert.equal(changes.portable_sync,true);assert.equal(changes.portable_revision,0);
  }finally{db.close();}
});
test('资料设置快照使用 CAS，拒绝旧版本及其他书库，保持已确认内容', () => {
  const db=fixture();try {const data=empty();data.preferences.push({key:'nickname',type:'string',value:'Reader',updatedAt:1,deviceId:'a'});
    const saved=putPortableState(db,input(db,data));assert.equal(saved.status,200);assert.equal(saved.revision,1);assert.equal(saved.data.preferences[0].value,'Reader');
    const conflict=putPortableState(db,input(db,empty()));assert.equal(conflict.status,409);assert.equal(conflict.current.revision,1);
    assert.equal(putPortableState(db,{...input(db,empty(),1),library_id:'other'}).code,'IDENTITY_CHANGED');assert.equal(getPortableState(db).data.preferences[0].value,'Reader');
    assert.equal(getSyncChanges(db).portable_revision,1);
  }finally{db.close();}
});
test('拒绝凭据、坏类型、阅读记录混入与无声明资源', () => {
  const db=fixture();try {const credential=empty();credential.preferences.push({key:'webdav_password',type:'string',value:'test',updatedAt:1,deviceId:'a'});assert.equal(putPortableState(db,input(db,credential)).status,400);
    for(const change of [data=>data.notes.push({}),data=>data.preferences.push({key:'theme',type:'unknown',value:'x',updatedAt:0,deviceId:'a'}),data=>data.preferences.push({key:'background',type:'string',value:'asset://'+'a'.repeat(64),updatedAt:1,deviceId:'a'})]){
      const data=empty();change(data);assert.equal(validatePortableState(data,db),false);
    }assert.equal(getPortableState(db).revision,0);
  }finally{db.close();}
});
test('资源必须先校验上传登记，声明校验和与大小必须匹配', () => {
  const db=fixture();try {const data=empty(),sha='a'.repeat(64),id=sha+'-'+'b'.repeat(16);
    data.assets.push({id,kind:'avatar',ownerId:'profile',fileName:sha+'.jpg',sha256:sha,sizeBytes:4});data.preferences.push({key:'avatar_path',type:'string',value:'asset://'+id,updatedAt:1,deviceId:'a'});
    assert.equal(validatePortableState(data,db),false);db.prepare('INSERT INTO mobile_portable_assets VALUES(?,?,?,?)').run(sha+'.jpg',sha,4,'now');
    assert.equal(validatePortableState(data,db),true);data.assets[0].sizeBytes=5;assert.equal(validatePortableState(data,db),false);
  }finally{db.close();}
});
test('书架链接必须匹配书目 UUID，并拒绝父子循环和越界链接', () => {
  const db=fixture();try {const book=books.addBook(parseBook({title:'Book'}).values,null,db),id='mybooks-'+book.id,data=empty();data.bookIdentities[id]=book.uuid;
    data.books.push({id,title:'Book',author:'',format:'EPUB',lastReadTime:0,readingProgress:0,locatorJson:null,createdAt:1,isFavorite:true,isCloudOnly:false,isPinned:false,metadataUpdatedAt:1,bodyAssetId:null,coverAssetId:null,remoteLibraryKey:null,remoteFileName:null,remoteFileSize:0,remoteFileSha256:null});
    data.folders.push({id:'f',name:'Folder',normalizedName:'folder',parentId:null,createdAt:1,updatedAt:1,coverPath:null});data.bookFolderLinks.push({bookId:id,folderId:'f',updatedAt:1});assert.equal(validatePortableState(data,db),true);
    data.bookIdentities[id]='reused';assert.equal(validatePortableState(data,db),false);data.bookIdentities[id]=book.uuid;
    data.folders[0].parentId='f';assert.equal(validatePortableState(data,db),false);data.folders[0].parentId=null;data.bookFolderLinks[0].folderId='missing';assert.equal(validatePortableState(data,db),false);
  }finally{db.close();}
});
module.exports = { empty };
