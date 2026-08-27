// Run with: node pricing-adapter.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.
//
// This only checks that the adapter correctly delegates to the real
// pricing engine -- it must NEVER duplicate pricing/package logic, so
// there is intentionally no re-testing of pricing rules here (that's
// pricing/engine.test.js's job).

const assert = require('assert');
const adapter = require('./pricing-adapter.js');
const PricingEngine = require('../pricing/engine.js');
const PRICING_CONFIG = require('../pricing/pricing-config.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

test('calculatePrice delegates to the real engine with the real config', () => {
  const order = { propertyType: 'condo', photography: 'luxury', addons: { floor_plan: true } };
  const viaAdapter = adapter.calculatePrice(order);
  const viaEngineDirect = PricingEngine.calculatePrice(order, PRICING_CONFIG);
  assert.deepStrictEqual(viaAdapter, viaEngineDirect);
  assert.strictEqual(viaAdapter.status, 'ok');
});

test('re-exports centsToDisplay from the engine', () => {
  assert.strictEqual(adapter.centsToDisplay(24900), '$249.00');
});

test('re-exports the pricing config', () => {
  assert.strictEqual(adapter.config.taxRatePercent, 13);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
