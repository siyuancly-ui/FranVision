/*
 * admin.js -- Franky's management view. Reached at  ?admin=<ADMIN_TOKEN>
 *
 * Interim (pre-auth) central list of every feature sheet: address, agent,
 * status, links. Agents never see this -- they only get a direct
 * ?p=<id> link. The token is a shared secret checked server-side
 * (Supabase edge function `list-projects`, or the Node server in dev);
 * it is NOT stored in the DB.
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
  function linkFor(id, token) {
    return window.location.origin + window.location.pathname + '?p=' + encodeURIComponent(id);
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

  function mount(root, token) {
    document.title = 'All Feature Sheets — FranVision';
    root.innerHTML = '';
    var wrap = el('div', { class: 'fsb-admin' });
    root.appendChild(wrap);

    var head = el('header', { class: 'fsb-admin-head' }, [
      el('div', { class: 'fsb-brand' }, [
        el('strong', { text: 'FranVision' }),
        el('span', { text: 'All Feature Sheets · 全部' }),
      ]),
      el('div', { class: 'fsb-admin-actions' }, [
        el('input', { id: 'fsb-admin-search', type: 'search', placeholder: 'Filter by address / agent 筛选…' }),
        el('button', { class: 'fsb-btn fsb-btn--primary', id: 'fsb-admin-new', text: '+ New feature sheet 新建' }),
      ]),
    ]);
    var body = el('div', { class: 'fsb-admin-body', id: 'fsb-admin-body' }, [
      el('div', { class: 'fsb-admin-loading', text: 'Loading… 加载中…' }),
    ]);
    wrap.appendChild(head);
    wrap.appendChild(body);

    var rows = [];

    function render(list) {
      body.innerHTML = '';
      var q = (document.getElementById('fsb-admin-search').value || '').trim().toLowerCase();
      var shown = list.filter(function (r) {
        if (!q) return true;
        return (r.address + ' ' + r.city + ' ' + (r.agents || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      });
      if (!shown.length) {
        body.appendChild(el('div', { class: 'fsb-admin-empty', text: list.length ? 'No matches 无匹配' : 'No feature sheets yet 还没有 feature sheet' }));
        return;
      }
      var table = el('table', { class: 'fsb-admin-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Address 地址' }),
        el('th', { text: 'Agent 经纪' }),
        el('th', { text: 'Theme 主题' }),
        el('th', { text: 'Status 状态' }),
        el('th', { text: 'Updated 更新' }),
        el('th', { text: '' }),
      ])]));
      var tb = el('tbody');
      shown.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', {}, [
          el('a', { class: 'fsb-admin-addr', href: adminLinkFor(r.id, token),
            text: r.address || '(untitled 未命名)' }),
          r.city ? el('div', { class: 'fsb-admin-sub', text: r.city }) : null,
        ]));
        tr.appendChild(el('td', { text: (r.agents || []).filter(Boolean).join(' & ') || '—' }));
        tr.appendChild(el('td', { text: r.theme || 'navy' }));
        tr.appendChild(el('td', {}, [
          el('span', { class: 'fsb-admin-status ' + (r.confirmed ? 'is-submitted' : 'is-draft'),
            text: r.confirmed ? 'Submitted 已提交' : 'Draft 草稿' }),
        ]));
        tr.appendChild(el('td', { class: 'fsb-admin-time', text: fmtTime(r.updatedAt) }));
        var actions = el('td', { class: 'fsb-admin-rowact' }, [
          el('a', { class: 'fsb-btn fsb-btn--sm', href: adminLinkFor(r.id, token), text: 'Open 打开' }),
          el('button', { class: 'fsb-btn fsb-btn--sm fsb-btn--ghost', text: 'Copy agent link 复制经纪链接',
            onclick: function () { copy(linkFor(r.id)); } }),
        ]);
        tr.appendChild(actions);
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      body.appendChild(table);
    }

    function load() {
      store.listAllProjects(token).then(function (list) {
        rows = (list || []).slice().sort(function (a, b) {
          return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        });
        render(rows);
      }).catch(function (err) {
        body.innerHTML = '';
        var msg = /401|unauthor|token/i.test(err.message || '')
          ? 'Wrong admin token 口令错误 — check the ?admin= value in the URL.'
          : 'Could not load 加载失败: ' + (err.message || err);
        body.appendChild(el('div', { class: 'fsb-admin-error', text: msg }));
      });
    }

    document.getElementById('fsb-admin-search').addEventListener('input', function () { render(rows); });
    document.getElementById('fsb-admin-new').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      store.createProject({ templateSystem: 'fsb-v2' }).then(function (project) {
        btn.disabled = false;
        var url = adminLinkFor(project.projectId, token);
        window.location.href = url; // jump straight into the new sheet
      }).catch(function (err) {
        btn.disabled = false;
        toast('Create failed 新建失败: ' + (err.message || err), 'error');
      });
    });

    load();
  }

  window.FSB.admin = { mount: mount };
})();
