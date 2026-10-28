const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const assetNamePattern = /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max;
const arrayNames = ['preferences','books','folders','bookFolderLinks','tags','annotationTags','bookTagLinks',
  'readingRecords','bookmarks','notes','tombstones','assets','highlightRules','bookHighlightRuleStates',
  'bookHighlightSettings','highlightRuleExclusions'];

function validatePortableState(data, db) {
  if (!object(data) || Buffer.byteLength(JSON.stringify(data)) > MAX_STATE_BYTES || data.schemaVersion !== 1 ||
      !integer(data.createdAt) || !text(data.sourceDeviceId, 200) || !object(data.bookIdentities) ||
      Object.keys(data).some((key) => !['schemaVersion','createdAt','sourceDeviceId','bookIdentities',...arrayNames].includes(key))) return false;
  if (arrayNames.some((key) => !Array.isArray(data[key]) || data[key].length > 50000)) return false;
  // 阅读位置与标注继续走逐本 CAS 接口，不能被资料/书架快照覆盖。
  if (['readingRecords','bookmarks','notes','highlightRules','bookHighlightRuleStates','bookHighlightSettings'].some((key) => data[key].length)) return false;
  const unique = (items, key) => new Set(items.map(key)).size === items.length;
  const safeTree = (value, depth = 0) => {
    if (depth > 12) return false;
    if (typeof value === 'string') return value.length <= 1024 * 1024;
    if (typeof value === 'number') return Number.isFinite(value);
    if (value === null || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.every((item) => safeTree(item, depth + 1));
    return object(value) && Object.entries(value).every(([key, item]) =>
      !['__proto__','constructor','prototype'].includes(key) && safeTree(item, depth + 1));
  };
  if (!safeTree(data)) return false;
  const preferenceTypes = new Set(['boolean','int','long','float','double','string','string_set','deleted']);
  for (const p of data.preferences) {
    if (!object(p) || !text(p.key) || !preferenceTypes.has(p.type) || typeof p.value !== 'string' ||
        !integer(p.updatedAt) || !text(p.deviceId, 200) ||
        /^(webdav_|mybooks_|authorized_)|password|access_token|api_key|secret_key/i.test(p.key)) return false;
  }
  if (!unique(data.preferences, (p) => p.key)) return false;
  const books = new Set();
  for (const book of data.books) {
    if (!object(book) || !/^mybooks-[1-9][0-9]*$/.test(book.id) || !Number.isSafeInteger(Number(book.id.slice(8))) ||
        !text(data.bookIdentities[book.id], 200) || book.bodyAssetId !== null ||
        typeof book.title !== 'string' || typeof book.author !== 'string' ||
        !['EPUB','PDF','TXT','MOBI','CBZ','MARKDOWN'].includes(book.format) ||
        !['lastReadTime','createdAt','metadataUpdatedAt','remoteFileSize'].every((key) => integer(book[key])) ||
        typeof book.readingProgress !== 'number' || !Number.isFinite(book.readingProgress) || book.readingProgress < 0 || book.readingProgress > 1 ||
        typeof book.isFavorite !== 'boolean' || typeof book.isCloudOnly !== 'boolean' ||
        (book.locatorJson !== null && typeof book.locatorJson !== 'string')) return false;
    const row = db.prepare('SELECT uuid FROM books WHERE id=?').get(Number(book.id.slice(8)));
    if (!row || row.uuid !== data.bookIdentities[book.id]) return false;
    books.add(book.id);
  }
  if (books.size !== data.books.length || Object.keys(data.bookIdentities).some((id) => !books.has(id))) return false;
  const folderIds = new Set();
  const tagIds = new Set();
  for (const [key, ids] of [['folders', folderIds], ['tags', tagIds]]) {
    for (const row of data[key]) {
      if (!object(row) || !text(row.id) || !text(row.name) || !text(row.normalizedName) ||
          !integer(row.createdAt) || !integer(row.updatedAt) ||
          (row.parentId != null && !text(row.parentId)) || ids.has(row.id)) return false;
      ids.add(row.id);
    }
    const parents = new Map(data[key].map((row) => [row.id, row.parentId]));
    const done = new Set();
    for (const id of ids) {
      const visiting = new Set(); let next = id;
      while (next != null && parents.has(next) && !done.has(next)) {
        if (visiting.has(next)) return false;
        visiting.add(next); next = parents.get(next);
      }
      for (const visited of visiting) done.add(visited);
    }
    if (key === 'folders' && data.folders.some((row) => row.parentId != null && !ids.has(row.parentId))) return false;
  }
  for (const key of ['bookFolderLinks','bookTagLinks','highlightRuleExclusions']) {
    if (data[key].some((item) => !object(item) || !books.has(item.bookId))) return false;
  }
  if (data.bookFolderLinks.some((row) => !folderIds.has(row.folderId) || !integer(row.updatedAt)) ||
      data.bookTagLinks.some((row) => !tagIds.has(row.tagId) || !integer(row.updatedAt))) return false;
  if (!unique(data.bookFolderLinks, (row) => row.bookId) || !unique(data.bookTagLinks, (row) => `${row.bookId}:${row.tagId}`)) return false;
  if (data.annotationTags.some((row) => !object(row) || !text(row.name) || row.name !== row.name.trim() || !integer(row.updatedAt) || typeof row.isDeleted !== 'boolean') ||
      !unique(data.annotationTags, (row) => row.name)) return false;
  if (data.tombstones.some((row) => !object(row) || !['folder','tag','book_folder','book_tag'].includes(row.namespace) ||
      !text(row.itemId, 1024) || !text(row.deviceId, 200) || !integer(row.deletedAt)) ||
      !unique(data.tombstones, (row) => `${row.namespace}:${row.itemId}`)) return false;
  if (data.assets.length > 4096 || !unique(data.assets, (a) => a.id)) return false;
  const assets = new Set();
  for (const asset of data.assets) {
    if (!object(asset) || !/^[a-f0-9]{64}(?:-[a-f0-9]{16})?$/.test(asset.id) || !assetNamePattern.test(asset.fileName) ||
        asset.sha256 !== asset.fileName.split('.')[0] || (asset.id !== asset.sha256 && !asset.id.startsWith(asset.sha256 + '-')) ||
        !integer(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > MAX_ASSET_BYTES ||
        !['avatar','font','reader_background','book_cover','folder_cover'].includes(asset.kind) || !text(asset.ownerId)) return false;
    const stored = db.prepare('SELECT * FROM mobile_portable_assets WHERE file_name=?').get(asset.fileName);
    if (!stored || stored.sha256 !== asset.sha256 || stored.size_bytes !== asset.sizeBytes) return false;
    assets.add(asset.id);
  }
  if (data.books.some((book) => book.coverAssetId !== null && !assets.has(book.coverAssetId))) return false;
  if (data.folders.some((folder) => !object(folder) || (folder.coverPath != null &&
      (typeof folder.coverPath !== 'string' || !folder.coverPath.startsWith('asset://') || !assets.has(folder.coverPath.slice(8)))))) return false;
  for (const p of data.preferences) {
    for (const match of p.value.matchAll(/asset:\/\/([a-f0-9]{64}(?:-[a-f0-9]{16})?)/g)) if (!assets.has(match[1])) return false;
  }
  return true;
}
module.exports = { MAX_STATE_BYTES, MAX_ASSET_BYTES, assetNamePattern, validatePortableState };
