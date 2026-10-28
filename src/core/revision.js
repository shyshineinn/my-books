// 新客户端使用 revision + uuid；旧客户端的时间戳条件仍可继续使用。
function checkBookPrecondition(row, body = {}, ifMatch = '') {
  if (Object.hasOwn(body, 'expected_revision') &&
      (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1)) {
    return { ok: false, code: 'VALIDATION', error: 'expected_revision 必须是正整数' };
  }
  if (Object.hasOwn(body, 'expected_uuid') &&
      (typeof body.expected_uuid !== 'string' || !body.expected_uuid.trim())) {
    return { ok: false, code: 'VALIDATION', error: 'expected_uuid 必须是非空字符串' };
  }
  const expectedDate = String(body.expected_updated_at || ifMatch || '').replace(/^"|"$/g, '').trim();
  const conflict = (body.expected_uuid !== undefined && body.expected_uuid !== row.uuid)
    || (body.expected_revision !== undefined ? body.expected_revision !== row.revision
      : expectedDate && expectedDate !== row.updated_at);
  return conflict ? { ok: false, code: 'CONFLICT', error: '书籍已在服务器更新，请处理冲突后再保存' } : { ok: true };
}
module.exports = { checkBookPrecondition };
