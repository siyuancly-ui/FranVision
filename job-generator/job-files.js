// FranVision Job Generator -- Job Info.txt + job.json writers.
//
// Pure "build the content" functions are separated from the fs write so
// the content logic stays testable without touching disk (same pattern
// as the other modules here).
//
// jobData shape (everything the UI collects, already validated):
// {
//   jobId, createdAt (ISO string), updatedAt (ISO string; == createdAt on
//     first creation, bumped when Create Job re-runs as an UPDATE of an
//     existing job -- see DESIGN-job-update.md),
//   clientName, photographerName, address, propertyType, shootDate,
//   order: { propertyType, photography, addons },   // same shape pricing-adapter/folder-builder use
//   price: <result of pricing-adapter.calculatePrice(order)>,
//   folderName, componentFolders: [...],
//   dropboxResult: <result of dropbox-sync.js#syncJobFolderToDropbox(), or
//                   undefined if that step was never attempted>,
//   commission: <result of commission-engine.js#computeCommission(), or
//                undefined if it was never computed (e.g. no photographer
//                entered yet)>,
// }
//
// Deliberately does NOT include the Shoot Notes text/images collected in
// the UI, or the calendar-file result -- see calendar-file.js. Neither is
// mirrored into Job Info.txt or job.json; their only purpose is the
// generated .ics file.

const fs = require('fs');
const path = require('path');
const { centsToDisplay, config } = require('./pricing-adapter.js');

// Fields that are allowed to be incomplete when a job is created (the
// info genuinely isn't known yet -- e.g. Virtual Staging photo count is
// often decided after the shoot), but need to be caught and filled in
// before the job is finalized/invoiced. Returns an array of human-
// readable strings; empty array means nothing is pending.
function computePendingConfirmation({ photographerName, order, dropboxResult }) {
  const pending = [];
  if (!photographerName || !String(photographerName).trim()) {
    pending.push('Photographer Name not filled in yet.');
  }
  const addons = (order && order.addons) || {};
  const stagingQty = Number(addons.virtual_staging_qty) || 0;
  if (addons.virtual_staging && stagingQty <= 0) {
    pending.push('Virtual Staging quantity not confirmed yet (currently priced at $0 for this line -- update before invoicing).');
  }
  // Dropbox sync is best-effort (see dropbox-sync.js) -- local job creation
  // always succeeds regardless, but a failed/skipped sync needs a human to
  // notice and either configure Dropbox or retry it manually.
  if (dropboxResult && !dropboxResult.success) {
    pending.push('Dropbox sync did not complete -- retry manually: ' + dropboxResult.error);
  }
  return pending;
}

function serviceSelectionSummary(price) {
  if (!price || price.status !== 'ok') return '(no valid pricing selection)';
  return price.lineItems.map((li) => li.label).join(', ');
}

// Renders the "Commission Breakdown:" section for Job Info.txt. Entirely
// independent from the client-facing pricing section above it -- reads
// only jobData.commission (see commission-engine.js), never jobData.price.
function buildCommissionLines(commission) {
  const lines = ['Commission Breakdown:'];
  if (!commission) {
    lines.push('  (not calculated -- Photographer not entered yet)');
    return lines;
  }
  if (commission.exempt) {
    lines.push('  ' + (commission.photographer || 'Photographer') + ' is commission-exempt -- $0.');
    return lines;
  }
  const checkedItems = commission.allItems.filter((item) => item.checked);
  if (!checkedItems.length && !commission.travelCents) {
    lines.push('  (no commission items selected)');
    return lines;
  }
  checkedItems.forEach((item) => {
    lines.push('  ' + item.label.padEnd(40) + centsToDisplay(item.amountCents));
  });
  if (commission.travelCents) {
    lines.push('  ' + 'Travel'.padEnd(40) + centsToDisplay(commission.travelCents));
  }
  lines.push('  ' + '-'.repeat(50));
  lines.push('  ' + 'Total Commission'.padEnd(40) + centsToDisplay(commission.totalCents));
  return lines;
}

function buildJobInfoText(jobData) {
  const p = jobData.price;
  const lines = [];
  lines.push('FranVision Job Info');
  lines.push('===================');
  lines.push('');
  lines.push('Job ID:        ' + jobData.jobId);
  lines.push('Client:        ' + jobData.clientName);
  lines.push('Photographer:  ' + jobData.photographerName);
  lines.push('Address:       ' + jobData.address);
  lines.push('Property Type: ' + jobData.propertyType);
  lines.push('Shoot Date:    ' + jobData.shootDate);
  lines.push('');
  lines.push('Selected Services:');
  lines.push('  ' + serviceSelectionSummary(p));
  lines.push('');
  lines.push('Pricing Breakdown:');
  if (p && p.status === 'ok') {
    p.lineItems.forEach((li) => {
      lines.push('  ' + li.label.padEnd(40) + centsToDisplay(li.amountCents));
    });
    if (p.manualAdjustmentCents) {
      lines.push('  ' + 'Manual adjustment'.padEnd(40) + centsToDisplay(p.manualAdjustmentCents));
    }
    lines.push('  ' + '-'.repeat(50));
    lines.push('  ' + 'Subtotal'.padEnd(40) + centsToDisplay(p.finalSubtotalCents));
    lines.push('  ' + ('HST (' + config.taxRatePercent + '%)').padEnd(40) + centsToDisplay(p.hstCents));
    lines.push('  ' + 'Total'.padEnd(40) + centsToDisplay(p.totalCents));
  } else {
    lines.push('  ' + (p && p.reason ? p.reason : 'No valid pricing.'));
  }
  lines.push('');
  lines.push(...buildCommissionLines(jobData.commission));
  const pending = computePendingConfirmation(jobData);
  if (pending.length) {
    lines.push('');
    lines.push('⚠ Needs follow-up before invoicing:');
    pending.forEach((msg) => lines.push('  - ' + msg));
  }
  lines.push('');
  lines.push('Created: ' + jobData.createdAt);
  if (jobData.updatedAt && jobData.updatedAt !== jobData.createdAt) {
    lines.push('Updated: ' + jobData.updatedAt);
  }
  lines.push('');
  return lines.join('\n');
}

// Builds job.json's "commission" field in the exact shape requested:
// { items: [...], travel_cents, total_cents }. Independent of jobData.price
// -- reads only jobData.commission (see commission-engine.js). Defaults to
// the all-zero shape when commission was never computed (e.g. no
// Photographer entered yet) rather than omitting the key, so downstream
// tooling can always rely on job.json having a `commission` object.
function buildCommissionJson(commission) {
  if (!commission) return { items: [], travel_cents: 0, total_cents: 0 };
  const items = commission.exempt ? [] : commission.allItems
    .filter((item) => item.checked)
    .map(({ id, label, amountCents }) => ({ id, label, amountCents }));
  return { items, travel_cents: commission.travelCents || 0, total_cents: commission.totalCents || 0 };
}

function buildJobJson(jobData) {
  const p = jobData.price;
  return {
    jobId: jobData.jobId,
    createdAt: jobData.createdAt,
    updatedAt: jobData.updatedAt || jobData.createdAt,
    client: { name: jobData.clientName },
    // Flat string, not an object -- the Photographer Commission module
    // (commission-engine.js) keys directly off this same value.
    photographer: jobData.photographerName || '',
    commission: buildCommissionJson(jobData.commission),
    property: { address: jobData.address, propertyType: jobData.propertyType },
    shootDate: jobData.shootDate,
    services: jobData.order,
    pricing: p && p.status === 'ok' ? {
      status: p.status,
      lineItems: p.lineItems,
      subtotalCents: p.subtotalCents,
      manualAdjustmentCents: p.manualAdjustmentCents,
      finalSubtotalCents: p.finalSubtotalCents,
      hstCents: p.hstCents,
      totalCents: p.totalCents,
      taxRatePercent: config.taxRatePercent,
    } : { status: p ? p.status : 'invalid', reason: p ? p.reason : 'No pricing computed.' },
    folders: {
      jobFolderName: jobData.folderName,
      componentFolders: jobData.componentFolders,
    },
    // Recorded so a failed/skipped sync can be found and retried later
    // without re-deriving it from scratch -- see dropbox-sync.js.
    dropbox: jobData.dropboxResult || null,
    pendingConfirmation: computePendingConfirmation(jobData),
  };
}

function writeJobFiles(jobFolderAbsolutePath, jobData) {
  const infoPath = path.join(jobFolderAbsolutePath, 'Job Info.txt');
  const jsonPath = path.join(jobFolderAbsolutePath, 'job.json');
  fs.writeFileSync(infoPath, buildJobInfoText(jobData), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(buildJobJson(jobData), null, 2), 'utf8');
  return { infoPath, jsonPath };
}

module.exports = { buildJobInfoText, buildJobJson, writeJobFiles, computePendingConfirmation, buildCommissionJson, buildCommissionLines };
