/*
 * admin.js -- Franky's management view. Reached at  ?admin=<ADMIN_TOKEN>
 *
 * Interim (pre-auth) central list of every feature sheet: address, agent,
 * status, links. Agents never see this -- they only get a direct
 * ?p=<id> link. The token is a shared secret checked server-side
 * (Supabase edge function `list-projects`, or the Node server in dev);
 * it is NOT stored in the DB.
 *
 * Delete is a soft delete -> recycle bin. From the bin a sheet can be
 * restored or permanently removed; "Empty bin" purges everything.
 *
 * FSB.admin.mount(rootEl, token)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var toast = window.FSB.util.toast;
  var store = window.FSB.store;

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // keep the dev ?local=1 flag on every internally-generated link
  function devSuffix() {
    return /[?&]local=1\b/.test(window.location.search) ? '&local=1' : '';
  }
  function linkFor(id) {
    return window.location.origin + window.location.pathname +
      '?p=' + encodeURIComponent(id) + devSuffix();
  }
  function adminLinkFor(id, token) {
    return linkFor(id) + '&admin=' + encodeURIComponent(token);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Link copied 链接已复制'); },
        function () { prompt('Copy link:', text); });
    } else { prompt('Copy link:', text); }
  }

  // a button that needs a second click within 3s to fire (no browser modal)
  function armedButton(label, armedLabel, cls, run) {
    var b = el('button', { class: 'fsb-btn fsb-btn--sm ' + (cls || ''), text: label });
    var armed = false, t = null;
    b.addEventListener('click', function () {
      if (!armed) {
        armed = true; b.textContent = armedLabel;
        t = setTimeout(function () { armed = false; b.textContent = label; }, 3000);
        return;
      }
      clearTimeout(t); armed = false;
      b.disabled = true; b.textContent = '…';
      run(b, function () { b.disabled = false; b.textContent = label; });
    });
    return b;
  }

  function mount(root, token) {
    document.title = 'All Feature Sheets — FranVision';
    root.innerHTML = '';
    var wrap = el('div', { class: 'fsb-admin' });
    root.appendChild(wrap);

    var view = 'active';         // 'active' | 'trash'
    var rows = [];

    var titleEl = el('span', { text: 'All Feature Sheets · 全部' });
    var search = el('input', { id: 'fsb-admin-search', type: 'search', placeholder: 'Filter by address / agent 筛选…' });
    var binLink = el('button', { class: 'fsb-btn fsb-btn--ghost', text: 'Recycle bin 回收站' });
    var newBtn = el('button', { class: 'fsb-btn fsb-btn--primary', text: '+ New feature sheet 新建' });
    var emptyBtn = armedButton('Empty bin 清空回收站', 'Purge all? 确认清空', 'fsb-btn--danger', function (b, reset) {
      store.emptyTrash(token).then(function (n) {
        toast(n + ' permanently deleted 已彻底删除');
        load();
      }).catch(function (err) { reset(); toast('Failed 失败: ' + (err.message || err), 'error'); });
    });

    var actions = el('div', { class: 'fsb-admin-actions' }, [search, binLink, newBtn, emptyBtn]);
    var head = el('header', { class: 'fsb-admin-head' }, [
      el('div', { class: 'fsb-brand' }, [el('strong', { text: 'FranVision' }), titleEl]),
      actions,
    ]);
    var body = el('div', { class: 'fsb-admin-body', id: 'fsb-admin-body' }, [
      el('div', { class: 'fsb-admin-loading', text: 'Loading… 加载中…' }),
    ]);
    wrap.appendChild(head);
    wrap.appendChild(body);

    function reflectView() {
      var trash = view === 'trash';
      titleEl.textContent = trash ? ('Recycle bin · 回收站' + (rows.length ? ' (' + rows.length + ')' : ''))
        : 'All Feature Sheets · 全部';
      binLink.textContent = trash ? '← Back to sheets 返回列表' : 'Recycle bin 回收站';
      newBtn.hidden = trash;
      emptyBtn.hidden = !trash || !rows.length;
    }

    function render() {
      body.innerHTML = '';
      reflectView();
      var trash = view === 'trash';
      var q = (search.value || '').trim().toLowerCase();
      var shown = rows.filter(function (r) {
        if (!q) return true;
        return (r.address + ' ' + r.city + ' ' + (r.agents || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      });
      if (!shown.length) {
        body.appendChild(el('div', { class: 'fsb-admin-empty',
          text: rows.length ? 'No matches 无匹配'
            : trash ? 'Recycle bin is empty 回收站是空的' : 'No feature sheets yet 还没有 feature sheet' }));
        return;
      }
      var table = el('table', { class: 'fsb-admin-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Address 地址' }),
        el('th', { text: 'Agent 经纪' }),
        el('th', { text: 'Theme 主题' }),
        el('th', { text: trash ? 'Deleted 删除时间' : 'Status 状态' }),
        el('th', { text: trash ? '' : 'Updated 更新' }),
        el('th', { text: '' }),
      ])]));
      var tb = el('tbody');
      shown.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, [
          trash
            ? el('span', { class: 'fsb-admin-addr', text: r.address || '(untitled 未命名)' })
            : el('a', { class: 'fsb-admin-addr', href: adminLinkFor(r.id, token), text: r.address || '(untitled 未命名)' }),
          r.city ? el('div', { class: 'fsb-admin-sub', text: r.city }) : null,
        ]));
        tr.appendChild(el('td', { text: (r.agents || []).filter(Boolean).join(' & ') || '—' }));
        tr.appendChild(el('td', { text: r.theme || 'navy' }));
        if (trash) {
          tr.appendChild(el('td', { class: 'fsb-admin-time', text: fmtTime(r.deletedAt) }));
          tr.appendChild(el('td', { text: '' }));
        } else {
          tr.appendChild(el('td', {}, [
            el('span', { class: 'fsb-admin-status ' + (r.confirmed ? 'is-submitted' : 'is-draft'),
              text: r.confirmed ? 'Submitted 已提交' : 'Draft 草稿' }),
          ]));
          tr.appendChild(el('td', { class: 'fsb-admin-time', text: fmtTime(r.updatedAt) }));
        }
        tr.appendChild(el('td', { class: 'fsb-admin-rowact' }, trash ? trashRowActions(r) : activeRowActions(r)));
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      body.appendChild(table);
    }

    function drop(id) { rows = rows.filter(function (x) { return x.id !== id; }); render(); }

    function activeRowActions(r) {
      return [
        el('a', { class: 'fsb-btn fsb-btn--sm', href: adminLinkFor(r.id, token), text: 'Open 打开' }),
        el('button', { class: 'fsb-btn fsb-btn--sm fsb-btn--ghost', text: 'Copy agent link 复制经纪链接',
          onclick: function () { copy(linkFor(r.id)); } }),
        el('button', { class: 'fsb-btn fsb-btn--sm fsb-btn--ghost', text: 'Duplicate 复制新建',
          onclick: function () { duplicate(r, this); } }),
        el('button', { class: 'fsb-btn fsb-btn--sm fsb-btn--danger', text: 'Delete 删除',
          onclick: function () {
            var b = this; b.disabled = true;
            store.deleteProject(r.id).then(function () { drop(r.id); toast('Moved to bin 已移入回收站'); })
              .catch(function (err) { b.disabled = false; toast('Delete failed 删除失败: ' + (err.message || err), 'error'); });
          } }),
      ];
    }

    function trashRowActions(r) {
      return [
        el('button', { class: 'fsb-btn fsb-btn--sm', text: 'Restore 恢复',
          onclick: function () {
            var b = this; b.disabled = true;
            store.restoreProject(r.id).then(function () { drop(r.id); toast('Restored 已恢复'); })
              .catch(function (err) { b.disabled = false; toast('Restore failed 恢复失败: ' + (err.message || err), 'error'); });
          } }),
        armedButton('Delete forever 彻底删除', 'Confirm? 确认彻底删除', 'fsb-btn--danger', function (b, reset) {
          store.purgeProject(r.id).then(function () { drop(r.id); toast('Permanently deleted 已彻底删除'); })
            .catch(function (err) { reset(); toast('Failed 失败: ' + (err.message || err), 'error'); });
        }),
      ];
    }

    // duplicate a sheet -> jump straight into the new one
    function duplicate(r, btn) {
      btn.disabled = true;
      store.duplicateProject(r.id).then(function (project) {
        window.location.href = adminLinkFor(project.projectId, token);
      }).catch(function (err) {
        btn.disabled = false;
        toast('Duplicate failed 复制失败: ' + (err.message || err), 'error');
      });
    }

    function load() {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'fsb-admin-loading', text: 'Loading… 加载中…' }));
      var p = view === 'trash' ? store.listTrash(token) : store.listAllProjects(token);
      p.then(function (list) {
        rows = (list || []).slice();
        render();
      }).catch(function (err) {
        body.innerHTML = '';
        var msg = /401|unauthor|token/i.test(err.message || '')
          ? 'Wrong admin token 口令错误 — check the ?admin= value in the URL.'
          : 'Could not load 加载失败: ' + (err.message || err);
        body.appendChild(el('div', { class: 'fsb-admin-error', text: msg }));
      });
    }

    search.addEventListener('input', render);
    binLink.addEventListener('click', function () {
      view = view === 'trash' ? 'active' : 'trash';
      load();
    });
    newBtn.addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      store.createProject({ templateSystem: 'fsb-v2' }).then(function (project) {
        window.location.href = adminLinkFor(project.projectId, token);
      }).catch(function (err) {
        btn.disabled = false;
        toast('Create failed 新建失败: ' + (err.message || err), 'error');
      });
    });

    load();
  }

  window.FSB.admin = { mount: mount };
})();
