// FranVision Job Generator -- Job Info.txt + job.json writers.
//
// Pure "build the content" functions are separated from the fs write so
// the content logic stays testable without touching disk (same pattern
// as the other modules here).
//
// jobData shape (everything the UI collects, already validated):
// {
//   jobId, createdAt (ISO string),
//   clientName, photographerName, address, propertyType, shootDate,
//   order: { propertyType, photography, addons },   // same shape pricing-adapter/folder-builder use
//   price: <result of pricing-adapter.calculatePrice(order)>,
//   folderName, componentFolders: [...],
// }

const fs = require('fs');
const path = require('path');
const { centsToDisplay, config } = require('./pricing-adapter.js');

// Fields that are allowed to be incomplete when a job is created (the
// info genuinely isn't known yet -- e.g. Virtual Staging photo count is
// often decided after the shoot), but need to be caught and filled in
// before the job is finalized/invoiced. Returns an array of human-
// readable strings; empty array means nothing is pending.
function computePendingConfirmation({ photographerName, order }) {
  const pending = [];
  if (!photographerName || !String(photographerName).trim()) {
    pending.push('Photographer Name not filled in yet.');
  }
  const addons = (order && order.addons) || {};
  const stagingQty = Number(addons.virtual_staging_qty) || 0;
  if (addons.virtual_staging && stagingQty <= 0) {
    pending.push('Virtual Staging quantity not confirmed yet (currently priced at $0 for this line -- update before invoicing).');
  }
  return pending;
}

function serviceSelectionSummary(price) {
  if (!price || price.status !== 'ok') return '(no valid pricing selection)';
  return price.lineItems.map((li) => li.label).join(', ');
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
    lines.push('  ' + 'Subtotal'.padEnd(40) + centsToDisplay(p.subtotalCents + (p.manualAdjustmentCents || 0)));
    lines.push('  ' + ('HST (' + config.taxRatePercent + '%)').padEnd(40) + centsToDisplay(p.hstCents));
    lines.push('  ' + 'Total'.padEnd(40) + centsToDisplay(p.totalCents));
  } else {
    lines.push('  ' + (p && p.reason ? p.reason : 'No valid pricing.'));
  }
  const pending = computePendingConfirmation(jobData);
  if (pending.length) {
    lines.push('');
    lines.push('⚠ Needs follow-up before invoicing:');
    pending.forEach((msg) => lines.push('  - ' + msg));
  }
  lines.push('');
  lines.push('Created: ' + jobData.createdAt);
  lines.push('');
  return lines.join('\n');
}

function buildJobJson(jobData) {
  const p = jobData.price;
  return {
    jobId: jobData.jobId,
    createdAt: jobData.createdAt,
    client: { name: jobData.clientName },
    photographer: { name: jobData.photographerName },
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

module.exports = { buildJobInfoText, buildJobJson, writeJobFiles, computePendingConfirmation };
