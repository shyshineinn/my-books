/* ============================================================
 * 通用弹窗原语(全站公共)
 * 打开/关闭、滚动锁定、背景点击关闭、Tab 焦点陷阱。
 * 依赖 base.js($/$$);加载顺序在 common.js 之前。
 * Escape 的分层协调(菜单/搜索/扫码)留在 common.js。
 * ============================================================ */

let modalReturnFocus = null;

function visibleModal() {
  return $$('.modal').find((m) => !m.classList.contains('hidden')) || null;
}

function modalFocusables(modal) {
  return [...modal.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.offsetParent !== null);
}

function openModal(sel) {
  if (!visibleModal()) modalReturnFocus = document.activeElement;
  $(sel).classList.remove('hidden');
  document.body.classList.add('modal-open');
  setTimeout(() => {
    const modal = visibleModal();
    if (!modal || modal.contains(document.activeElement)) return;
    const first = modalFocusables(modal)[0];
    if (first) first.focus({ preventScroll: true });
  }, 0);
}

function closeModals() {
  $$('.modal').forEach((m) => m.classList.add('hidden'));
  document.body.classList.remove('modal-open');
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target && typeof target.focus === 'function' && document.contains(target)) {
    target.focus({ preventScroll: true });
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modal = visibleModal();
  if (!modal) return;
  const list = modalFocusables(modal);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (!modal.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

$$('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) closeModals(); });
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModals();
});
