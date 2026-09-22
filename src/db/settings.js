/* ============================================================
 * 全局设置(数据访问层):心得仓库等,存 settings 表
 * ============================================================ */

const { db, getSetting, setSetting } = require('./index');

function getSettings() {
  return {
    notesRepo: getSetting('notes_repo'),
    notesBranch: getSetting('notes_branch') || 'main',
  };
}

// 校验并保存心得仓库设置;返回 { ok } 或 { ok: false, error }
function saveSettings(notesRepo, notesBranch) {
  const repo = String(notesRepo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const branch = String(notesBranch || '').trim() || 'main';
  if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { ok: false, error: '仓库格式应为 owner/repo,例如 yourname/reading-notes' };
  }
  setSetting('notes_repo', repo);
  setSetting('notes_branch', branch);
  return { ok: true, notesRepo: repo, notesBranch: branch };
}

module.exports = { getSettings, saveSettings };
