/* ============================================================
 * 自定义字段的纯规则层(对标 calibre library/field_metadata.py + 
 * db/backend.py 的 create_custom_column 校验段)
 *
 * 这一层回答两个问题,且只回答这两个(不碰 I/O、不碰数据库):
 *   1. 一个字段定义是否合法?(label / datatype / 多值 / 枚举选项)
 *   2. 用户给某个字段填的值,如何规范化成可入库的字符串?
 *
 * 为什么不照搬 calibre 的"每字段一张物理表"(custom_column_N):
 *   calibre 那么做是为几十万册书库的索引性能服务。本项目有一条更重要的
 *   不变量 —— **schema 只由 src/db/index.js 的 migrations 数组定义**,
 *   运行时 DDL 会让"库的结构"取决于"用户的操作历史",备份/恢复/自检
 *   都失去确定性。所以这里用「注册表 + 单张值表 + 约束」实现同样的语义:
 *   字段是数据,不是表。代价是值表会宽一点,收益是 schema 恒定可推演。
 *
 * datatype 取值沿用 calibre 的命名(便于回读其字段元数据):
 *   text         单行文本
 *   comments     长文本(简介类)
 *   int          整数
 *   float        小数
 *   bool         是/否
 *   date         日期 YYYY-MM-DD
 *   rating       评分 0~10(与本站 migrateV8 之后的量表一致)
 *   enumeration  枚举(取值必须来自 options)
 *   series       系列名(纯文本,预留与 series_index 组合的语义)
 *
 * is_multiple 仅对 text 有效 —— 与 calibre 同款收窄
 * (backend.py:1396 `is_multiple and datatype in ('text', 'composite')`,
 *  本项目不实现 composite,故只留 text)。
 * ============================================================ */

// datatype 白名单:与 migrateV11 的 CHECK 约束必须逐一对应,
// 改这里就要同步改迁移(反之亦然)—— test/custom-fields.test.js 钉死二者一致。
const DATATYPES = ['text', 'comments', 'int', 'float', 'bool', 'date', 'rating', 'enumeration', 'series'];

// 只有这些类型支持多值(与 calibre 的收窄策略一致)
const MULTIPLE_DATATYPES = ['text'];

// 各类型的长度上限:防止自定义字段变成无界存储
const MAX_LEN = {
  text: 200,
  comments: 4000,
  series: 200,
  enumeration: 200,
};

// label(机器名)规则,逐条对齐 calibre backend.py:1391 的判定:
//   · 非空
//   · 只含小写字母/数字/下划线(^\w*$,而 \w 含大写故需额外判小写)
//   · 首字符必须是字母
//   · 必须已经全小写
// 额外加一条 calibre 没有但本项目需要的:长度上限(它用表名,无长度顾虑)
const LABEL_RE = /^[a-z][a-z0-9_]*$/;
const LABEL_MAX_LEN = 40;

// 保留字:与 books 表既有列名、既有筛选参数冲突的 label 一律拒绝,
// 否则 `#author:xxx` 这类检索会与内置字段语义打架。
// 保留字:与内置字段/筛选参数同名的 label 一律拒绝。
//
// **注意 v12 起 series 不在此列**(有意为之):v12 加了内置 `series` 列,
// 而 calibre 同样允许存在一个 `#series` 自定义列 —— 两者靠前缀分属不同命名空间
// (`series:基地` 查内置列,`#series:基地` 查自定义字段),因此不构成歧义。
// 这里保留字的作用是**避免用户在表单里看到两个同名输入框**,
// 而 series 的情况恰恰相反:v11 时代(还没有内置系列列)建过 `#series` 的用户
// 不该因为升级而被判定为非法。保留字只在**新建字段**时校验,不影响存量字段。
const RESERVED_LABELS = new Set([
  'id', 'title', 'author', 'authors', 'author_sort', 'status', 'summary',
  'tags', 'tag', 'start_date', 'finish_date', 'cover', 'notes_url',
  'read_count', 'read_logs', 'created_at', 'updated_at',
  'publisher', 'pub_year', 'pubyear', 'isbn', 'rating', 'douban_id',
  'format', 'formats', 'file', 'files', 'q', 'sort', 'all', 'search', 'vl',
]);

// 多值字段的分隔符:入参允许中英文逗号/顿号/分号,内部统一用顿号输出。
// 与 core/book.js 的 splitAuthors 同思路(用户怎么敲都能拆开)。
const MULTI_SPLIT_RE = /[,，、;；]+/;
const MULTI_JOIN = '、';

/* ---------- 字段定义校验 ---------- */

// 校验一个"新建/修改字段"请求。纯函数,永不抛异常给调用方 ——
// 返回 { ok, errors, values },errors 为人类可读的中文消息数组。
// 对标 calibre create_custom_column 的 fail-fast 校验(backend.py:1389-1394),
// 差别只在"用返回值而非异常"——本项目 HTTP 层统一按 errors 组 400 响应。
function parseColumnDef(body) {
  const errors = [];
  const src = body && typeof body === 'object' ? body : {};

  const label = String(src.label == null ? '' : src.label).trim().toLowerCase();
  const name = String(src.name == null ? '' : src.name).trim();
  const datatype = String(src.datatype == null ? '' : src.datatype).trim().toLowerCase();

  if (!label) {
    errors.push('字段标识(label)不能为空');
  } else if (label.length > LABEL_MAX_LEN) {
    errors.push(`字段标识不能超过 ${LABEL_MAX_LEN} 个字符`);
  } else if (!LABEL_RE.test(label)) {
    errors.push('字段标识只能用小写字母、数字、下划线,且必须以字母开头');
  } else if (RESERVED_LABELS.has(label)) {
    errors.push(`「${label}」是内置字段名,请换一个`);
  }

  if (!name) errors.push('字段名称不能为空');
  if (name.length > 60) errors.push('字段名称不能超过 60 个字符');

  if (!datatype) {
    errors.push('缺少字段类型');
  } else if (!DATATYPES.includes(datatype)) {
    errors.push(`不支持的字段类型「${datatype}」,可用:${DATATYPES.join(' / ')}`);
  }

  // is_multiple:只有 text 能多值。传了不支持多值的类型时明确报错,
  // 而不是静默忽略 —— 静默忽略会让用户以为多值生效了(calibre 是静默收窄的,
  // 这里刻意更严格:本项目的字段是用户手动管理的数据资产)。
  let isMultiple = src.is_multiple === true || src.is_multiple === 1 || src.is_multiple === '1';
  if (isMultiple && datatype && !MULTIPLE_DATATYPES.includes(datatype)) {
    errors.push(`「${datatype}」类型不支持多值(只有 text 可以)`);
    isMultiple = false;
  }

  // enumeration 必须有选项
  let options = [];
  if (datatype === 'enumeration') {
    options = parseOptions(src.options);
    if (!options.length) errors.push('枚举类型至少要提供一个可选值');
    if (options.length > 60) errors.push('枚举可选值最多 60 个');
  }

  return {
    ok: errors.length === 0,
    errors,
    values: { label, name, datatype, is_multiple: isMultiple ? 1 : 0, options },
  };
}

// 枚举选项:接受数组或分隔符串,去重去空,保持用户输入顺序
function parseOptions(input) {
  let arr;
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(MULTI_SPLIT_RE);
  else if (input == null) arr = [];
  else arr = [input];

  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const v = String(raw == null ? '' : raw).trim().slice(0, MAX_LEN.enumeration);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// 把 registry 行(数据库行)还原成"字段定义对象",options 从 JSON 解出来。
// 容错坏 JSON:字段定义坏掉不该让整个书架打不开(与既有 tags/read_logs 同纪律)。
//
// **幂等**:传入的既可能是数据库原始行(options 是 JSON 串),也可能是
// listColumns 已经转换过的定义对象(options 已是数组)。必须两种都受得住 ——
// normalizeValue / displayValue 都会对"已转换对象"再调一次本函数,
// 若不做幂等判断,JSON.parse(array) 会抛错并被 catch 成 options=[],
// 表现为"枚举选项凭空消失、枚举字段永远校验失败"(实测踩过)。
function columnFromRow(row) {
  if (!row) return null;

  // 已有 datatype 且 options 已是数组 → 是转换后的定义对象,原样返回
  if (Array.isArray(row.options)) {
    return {
      id: row.id,
      label: row.label,
      name: row.name,
      datatype: row.datatype,
      is_multiple: row.is_multiple ? 1 : 0,
      options: row.options.map((x) => String(x)).filter(Boolean),
      display_order: row.display_order || 0,
      mark_for_delete: row.mark_for_delete ? 1 : 0,
    };
  }

  let options = [];
  try {
    const parsed = JSON.parse(row.options || '[]');
    if (Array.isArray(parsed)) options = parsed.map((x) => String(x)).filter(Boolean);
  } catch { options = []; }
  return {
    id: row.id,
    label: row.label,
    name: row.name,
    datatype: row.datatype,
    is_multiple: row.is_multiple ? 1 : 0,
    options,
    display_order: row.display_order || 0,
    mark_for_delete: row.mark_for_delete ? 1 : 0,
  };
}

/* ---------- 值规范化(核心:每个类型一条规则) ---------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 规范化"用户给某个字段填的值"。
// 返回 { ok, value, error }:value 是入库用的字符串(统一 TEXT),
// 空值一律归一为 ''(表示"未填"),与 books 表既有列的空值约定一致。
//
// 设计取舍:类型不符**不抛异常也不静默截断**,而是返回 error 让上层拒绝 ——
// 自定义字段是用户自己定义的,填错必须明确告诉他哪里错(calibre 走 GUI 控件
// 约束类型,我们只有文本输入框,故校验责任落在此处)。
function normalizeValue(column, raw) {
  const col = columnFromRow(column);
  if (!col) return { ok: false, value: '', error: '字段不存在' };

  // 多值:text 专用,存 JSON 数组串(与 books.tags 的既有约定一致,
  // 检索侧可继续用 LIKE '%"值"%' 复用同一套匹配逻辑)
  if (col.is_multiple) {
    const parts = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(MULTI_SPLIT_RE);
    const out = [];
    const seen = new Set();
    for (const p of parts) {
      const v = String(p == null ? '' : p).trim().slice(0, MAX_LEN.text);
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    // 一条都没填 = 未填:统一归一为 ''(而不是 '[]'),这样全库只有
    // 一种"空"的表示 —— 仓储层据此删行、检索侧据此不命中,不必判两种空值
    if (!out.length) return { ok: true, value: '', error: '' };
    return { ok: true, value: JSON.stringify(out), error: '' };
  }

  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, value: '', error: '' };  // 空 = 未填,任何类型都合法

  switch (col.datatype) {
    case 'text':
      return { ok: true, value: s.slice(0, MAX_LEN.text), error: '' };
    case 'series':
      return { ok: true, value: s.slice(0, MAX_LEN.series), error: '' };
    case 'comments':
      return { ok: true, value: s.slice(0, MAX_LEN.comments), error: '' };
    case 'int': {
      const n = Number(s);
      if (!Number.isInteger(n)) return { ok: false, value: '', error: `${col.name} 应为整数` };
      return { ok: true, value: String(n), error: '' };
    }
    case 'float': {
      const n = Number(s);
      if (!Number.isFinite(n)) return { ok: false, value: '', error: `${col.name} 应为数字` };
      return { ok: true, value: String(n), error: '' };
    }
    case 'bool': {
      const t = s.toLowerCase();
      if (['1', 'true', 'yes', 'y', '是', '真'].includes(t)) return { ok: true, value: '1', error: '' };
      if (['0', 'false', 'no', 'n', '否', '假'].includes(t)) return { ok: true, value: '0', error: '' };
      return { ok: false, value: '', error: `${col.name} 应为「是」或「否」` };
    }
    case 'date':
      if (!DATE_RE.test(s)) return { ok: false, value: '', error: `${col.name} 日期格式应为 YYYY-MM-DD` };
      return { ok: true, value: s, error: '' };
    case 'rating': {
      const n = Number(s);
      if (!Number.isFinite(n) || n < 0) return { ok: false, value: '', error: `${col.name} 评分应为 0~10` };
      // 与内置 rating 同款:一位小数、封顶 10(migrateV8 之后的统一量表)
      return { ok: true, value: String(Math.min(10, Math.round(n * 10) / 10)), error: '' };
    }
    case 'enumeration': {
      const hit = col.options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!hit) {
        return { ok: false, value: '', error: `${col.name} 只能是:${col.options.join(' / ')}` };
      }
      return { ok: true, value: hit, error: '' };
    }
    default:
      return { ok: false, value: '', error: `不支持的字段类型「${col.datatype}」` };
  }
}

// 把某本书的"字段 label → 原始值"对象整体规范化。
// 返回 { ok, errors, values }:values 是 { label: 规范化字符串 }。
// 只处理传入的 label(局部更新语义由调用方决定),未识别的 label 收进
// errors 而不是静默丢弃 —— 静默丢弃会让"字段删了但前端还发着"这种
// 前后端不一致长期隐身。
function normalizeBookValues(columns, input) {
  const errors = [];
  const values = {};
  const byLabel = new Map(columns.map((c) => [c.label, c]));
  const src = input && typeof input === 'object' ? input : {};

  for (const [label, raw] of Object.entries(src)) {
    const col = byLabel.get(String(label));
    if (!col) {
      errors.push(`未知字段「${label}」`);
      continue;
    }
    const r = normalizeValue(col, raw);
    if (!r.ok) { errors.push(r.error); continue; }
    values[col.label] = r.value;
  }
  return { ok: errors.length === 0, errors, values };
}

// 值 → 展示用文本(详情页 / 列表)
function displayValue(column, stored) {
  const col = columnFromRow(column);
  if (!col) return '';
  const s = stored == null ? '' : String(stored);
  if (!s) return '';
  if (col.is_multiple) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.join(MULTI_JOIN) : s;
    } catch { return s; }
  }
  if (col.datatype === 'bool') return s === '1' ? '是' : '否';
  return s;
}

module.exports = {
  DATATYPES,
  MULTIPLE_DATATYPES,
  MAX_LEN,
  LABEL_MAX_LEN,
  MULTI_JOIN,
  RESERVED_LABELS,
  parseColumnDef,
  parseOptions,
  columnFromRow,
  normalizeValue,
  normalizeBookValues,
  displayValue,
};
