const EMPTY_READING_DATA = () => ({ positions: [], bookmarks: [], notes: [], reading_records: [], tombstones: [] });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

// 阅读器坐标与样式按安卓格式原样保存；仅允许声明的标量字段，拒绝任意嵌套负载。
function validateReadingData(data) {
  if (!object(data) || Buffer.byteLength(JSON.stringify(data)) > 4 * 1024 * 1024) return false;
  const keys = ['positions', 'bookmarks', 'notes', 'reading_records', 'tombstones'];
  if (Object.keys(data).some((key) => !keys.includes(key))) return false;
  if (keys.some((key) => !Array.isArray(data[key]) || data[key].length > 10000)) return false;
  const unique = (items, key) => new Set(items.map(key)).size === items.length;
  for (const p of data.positions) {
    if (!object(p) || !['EPUB','PDF','TXT','MOBI','CBZ','MARKDOWN'].includes(p.format) ||
        !integer(p.lastReadTime) || typeof p.readingProgress !== 'number' ||
        !Number.isFinite(p.readingProgress) || p.readingProgress < 0 || p.readingProgress > 1 ||
        !text(p.sourceDeviceId) || (p.fileSha256 !== '' && !/^[a-f0-9]{64}$/.test(p.fileSha256)) ||
        (p.locatorJson !== null && (typeof p.locatorJson !== 'string' || p.locatorJson.length > 65536)) ||
        Object.keys(p).some((k) => !['format','fileSha256','lastReadTime','readingProgress','locatorJson','sourceDeviceId'].includes(k))) return false;
  }
  if (!unique(data.positions, (p) => `${p.format}:${p.fileSha256}`)) return false;
  const common = ['syncId','chapterIndex','createdAt','updatedAt','isStale','tagsJson','format','fileSha256'];
  const fields = {
    bookmarks: [...common, 'position','locatorJson','title','remark'],
    notes: [...common, 'startPosition','endPosition','startLocatorJson','endLocatorJson','selectedText',
      'note','color','type','isNote','origin','sourceRuleId','sourceMatchKey','styleSnapshotJson'],
  };
  for (const name of ['bookmarks', 'notes']) {
    for (const item of data[name]) {
      if (!object(item) || !text(item.syncId) || !integer(item.createdAt) || !integer(item.updatedAt) ||
          !integer(item.chapterIndex) || Object.keys(item).some((key) => !fields[name].includes(key)) ||
          Object.values(item).some((v) => v !== null && !['string','number','boolean'].includes(typeof v)) ||
          Object.values(item).some((v) => typeof v === 'string' && v.length > 100000) ||
          Object.values(item).some((v) => typeof v === 'number' && !Number.isFinite(v))) return false;
      if (item.format !== undefined && !['EPUB','PDF','TXT','MOBI','CBZ','MARKDOWN'].includes(item.format)) return false;
      if (item.fileSha256 !== undefined && (typeof item.fileSha256 !== 'string' || item.fileSha256 !== '' && !/^[a-f0-9]{64}$/.test(item.fileSha256))) return false;
    }
    if (!unique(data[name], (item) => item.syncId)) return false;
  }
  for (const record of data.reading_records) {
    if (!object(record) || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || !text(record.sourceDeviceId) ||
        ['duration','startTime','endTime','updatedAt'].some((key) => !integer(record[key])) ||
        Object.keys(record).some((key) => !['date','sourceDeviceId','duration','startTime','endTime','updatedAt'].includes(key))) return false;
  }
  if (!unique(data.reading_records, (r) => `${r.date}:${r.sourceDeviceId}`)) return false;
  for (const tombstone of data.tombstones) {
    if (!object(tombstone) || !['bookmark','note'].includes(tombstone.namespace) || !text(tombstone.itemId) ||
        !text(tombstone.deviceId) || !integer(tombstone.deletedAt) ||
        Object.keys(tombstone).some((key) => !['namespace','itemId','deviceId','deletedAt'].includes(key))) return false;
  }
  if (!unique(data.tombstones, (t) => `${t.namespace}:${t.itemId}`)) return false;
  for (const [name, namespace] of [['bookmarks','bookmark'], ['notes','note']]) {
    const deleted = new Set(data.tombstones.filter((t) => t.namespace === namespace).map((t) => t.itemId));
    if (data[name].some((item) => deleted.has(item.syncId))) return false;
  }
  return true;
}
module.exports = { EMPTY_READING_DATA, validateReadingData };
