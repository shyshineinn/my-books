const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, inTransaction } = require('../src/db/index');
const books = require('../src/db/books');
const { parseBook } = require('../src/core/book');
const { getSyncChanges, getReadingState, putReadingState, pruneSyncChanges } = require('../src/db/sync-v3');
const { EMPTY_READING_DATA, validateReadingData } = require('../src/core/mobile-reading');
const temporary = [];
function fixture() { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mybooks-v3-')); temporary.push(dir); return openDb(dir); }
after(() => temporary.forEach((dir) => fs.rmSync(dir,{recursive:true,force:true})));
const add = (db, title='Book') => books.addBook(parseBook({title}).values,null,db);

test('增量游标包含初始视图、变化、删除、恢复；空增量不会丢失既有书目', () => {
  const db=fixture(); try {
    const a=add(db), b=add(db,'Other'); const full=getSyncChanges(db);
    assert.equal(full.complete,true); assert.equal(full.books.length,2);
    assert.deepEqual(getSyncChanges(db,full.cursor).books,[]);
    books.touchBook(a.id,db);
    let delta=getSyncChanges(db,full.cursor);
    assert.equal(delta.complete,false); assert.deepEqual(delta.books.map(x=>x.id),[a.id]);
    books.softDeleteBook(db,b.id); books.purgeBook(db,b.id);
    delta=getSyncChanges(db,delta.cursor);
    assert.equal(delta.deleted[0].uuid,b.uuid);
    books.softDeleteBook(db,a.id); const deleted=getSyncChanges(db,delta.cursor);
    books.restoreBook(db,a.id);
    const restored=getSyncChanges(db,deleted.cursor);
    assert.equal(restored.books[0].uuid,a.uuid); assert.deepEqual(restored.deleted,[]);
  } finally {db.close();}
});
test('游标拒绝其他书库、未来序号及备份恢复后的检查点复用', () => {
  const db=fixture();try {
    add(db);const full=getSyncChanges(db);const decoded=JSON.parse(Buffer.from(full.cursor,'base64url').toString());
    for(const replacement of [{...decoded,library_id:'other'}, {...decoded,seq:decoded.seq+1}, {...decoded,checkpoint:'reused-sequence'}]) {
      assert.throws(()=>getSyncChanges(db,Buffer.from(JSON.stringify(replacement)).toString('base64url')), {code:'CURSOR_RESET'});
    }
    assert.throws(()=>getSyncChanges(db,''),{code:'CURSOR_RESET'});
    assert.throws(()=>getSyncChanges(db,['a','b']),{code:'CURSOR_RESET'});
  }finally{db.close();}
});
test('变更日志可限量清理，过期游标回退完整视图而不是漏掉变化', () => {
  const db=fixture();try {
    const empty=getSyncChanges(db).cursor;
    const a=add(db);const old=getSyncChanges(db).cursor;
    for(let i=0;i<5;i++)books.touchBook(a.id,db);
    pruneSyncChanges(db,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_changes').get().n,2);
    assert.throws(()=>getSyncChanges(db,old),{code:'CURSOR_RESET'});
    assert.throws(()=>getSyncChanges(db,empty),{code:'CURSOR_RESET'});
    assert.equal(getSyncChanges(db).books[0].id,a.id);
  }finally{db.close();}
});
test('事务回滚不会留下可见变更；文件/标识符更新会出现在增量中', () => {
  const db=fixture();try {
    const book=add(db),cursor=getSyncChanges(db).cursor;
    assert.throws(()=>inTransaction(db,()=>{books.touchBook(book.id,db);throw Error('rollback');}));
    assert.deepEqual(getSyncChanges(db,cursor).books,[]);
    db.prepare("INSERT INTO book_identifiers(book,type,value) VALUES(?,'test','new')").run(book.id);
    assert.equal(getSyncChanges(db,cursor).books[0].id,book.id);
  }finally{db.close();}
});
test('阅读数据独立版本、CAS 冲突、身份校验与增量提示不污染书目 revision', () => {
  const db=fixture();try {
    const book=add(db),full=getSyncChanges(db);const data=EMPTY_READING_DATA();
    data.positions.push({format:'EPUB',fileSha256:'',lastReadTime:100,readingProgress:.4,locatorJson:'{}',sourceDeviceId:'device-a'});
    data.bookmarks.push({syncId:'bookmark-a',chapterIndex:0,position:.2,locatorJson:null,title:'Mark',remark:'',
      createdAt:1,updatedAt:2,tagsJson:'["标签"]',isStale:false,format:'EPUB',fileSha256:''});
    data.notes.push({syncId:'note-a',chapterIndex:0,startPosition:1,endPosition:2,startLocatorJson:null,endLocatorJson:null,
      selectedText:'quote',note:'note',color:'#ffff00',createdAt:1,updatedAt:2,type:'highlight',isNote:true,
      origin:'manual',sourceRuleId:null,sourceMatchKey:null,styleSnapshotJson:null,tagsJson:'[]',isStale:false,
      format:'EPUB',fileSha256:''});
    data.reading_records.push({date:'2026-10-28',sourceDeviceId:'device-a',duration:50,startTime:1,endTime:51,updatedAt:51});
    const input={library_id:full.library_id,expected_uuid:book.uuid,expected_revision:0,data};
    const saved=putReadingState(db,book.id,input);assert.equal(saved.status,200);assert.equal(saved.revision,1);
    const conflict=putReadingState(db,book.id,input);assert.equal(conflict.status,409);assert.equal(conflict.current.revision,1);
    assert.equal(putReadingState(db,book.id,{...input,expected_uuid:'other'}).status,409);
    assert.equal(putReadingState(db,book.id,{...input,library_id:'other'}).status,409);
    assert.equal(books.getBook(book.id,db).revision,book.revision);
    const delta=getSyncChanges(db,full.cursor);assert.equal(delta.books.length,0);assert.equal(delta.reading[0].revision,1);
    assert.deepEqual(getReadingState(db,book).data,data);
  }finally{db.close();}
});
test('阅读删除记录长期保留，重复或含非有限进度的负载会被拒绝', () => {
  const db=fixture();try {
    const book=add(db),full=getSyncChanges(db),data=EMPTY_READING_DATA();
    data.tombstones.push({namespace:'note',itemId:'note-one',deletedAt:123,deviceId:'device-a'});
    assert.equal(putReadingState(db,book.id,{library_id:full.library_id,expected_uuid:book.uuid,expected_revision:0,data}).status,200);
    assert.deepEqual(getReadingState(db,book).data.tombstones,data.tombstones);
    assert.equal(validateReadingData({...data,tombstones:[...data.tombstones,...data.tombstones]}),false);
    assert.equal(validateReadingData({...data,positions:[{format:'PDF',fileSha256:'',lastReadTime:1,readingProgress:Infinity,locatorJson:null,sourceDeviceId:'a'}]}),false);
    books.softDeleteBook(db,book.id);
    assert.equal(putReadingState(db,book.id,{library_id:full.library_id,expected_uuid:book.uuid,expected_revision:1,data}).status,404);
    const deletedCursor=getSyncChanges(db).cursor;
    books.restoreBook(db,book.id);
    assert.equal(getReadingState(db,book).revision,1);
    assert.equal(getSyncChanges(db,deletedCursor).reading[0].revision,1);
  }finally{db.close();}
});
