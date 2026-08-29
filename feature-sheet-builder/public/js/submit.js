/*
 * submit.js -- "Confirm & Submit" hands the finished sheet to the studio.
 *
 * Flow (Supabase backend only):
 *   1. build the 2-page print PDF in the browser (export-pdf.js)
 *   2. upload it to Storage: submissions/<projectId>.pdf
 *   3. call the `notify-submission` edge function -> emails the studio a
 *      summary + links (open project / download PDF)
 *
 * app.js calls FSB.submit.send(app) from confirmDesign(); if it rejects,
 * the design is NOT locked so the agent can retry. On the local dev
 * backend this is a silent no-op (nothing to email to).
 *
 * FSB.submit.send(app) -> Promise
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};

  function send(app) {
    var store = window.FSB.store;
    if (store.MODE !== 'supabase') {
      // dev backend: skip the email, let the confirm proceed.
      window.FSB.util.toast('Submitted (dev mode — no email sent)');
      return Promise.resolve();
    }

    app.setBusy('Preparing the print file… 正在生成打印文件…');
    return window.FSB.exportPdf.buildBlob(app)
      .then(function (blob) {
        app.setBusy('Uploading… 上传中…');
        return store.uploadSubmission(app.projectId, blob);
      })
      .then(function () {
        app.setBusy('Notifying the studio… 通知工作室…');
        return store.invokeFunction('notify-submission', { projectId: app.projectId });
      });
  }

  window.FSB.submit = { send: send };
})();
