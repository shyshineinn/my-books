/* ============================================================
 * LRU 缓存(基于 Map 的插入序):修掉 notesCache/imgCache
 * "只增不减、长期运行吃内存"的债务(借鉴 calibre srv/content.py
 * 的缓存生命周期管理思想,落成内存上限 + 命中可观测)。
 *
 * 行为:
 *   · get(key) 命中时把条目提到"最新"位,并返回值
 *   · set(key, value) 写入时若超容量,淘汰"最旧"位条目
 *   · size / stats() 供观测
 * ============================================================ */

class LruCache {
  constructor(capacity = 100) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity 必须为正整数');
    this.capacity = capacity;
    this.map = new Map(); // Map 迭代序 = 插入序;重 set 即置顶
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get(key) {
    if (!this.map.has(key)) { this.misses += 1; return undefined; }
    const value = this.map.get(key);
    this.map.delete(key);   // 摘掉再重插 = 移到最新位
    this.map.set(key, value);
    this.hits += 1;
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      // 淘汰最旧:Map 首个键
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions += 1;
    }
    this.map.set(key, value);
    return value;
  }

  has(key) { return this.map.has(key); }

  get size() { return this.map.size; }

  stats() { return { size: this.size, capacity: this.capacity, hits: this.hits, misses: this.misses, evictions: this.evictions }; }
}

module.exports = { LruCache };
