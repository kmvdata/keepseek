import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageFormattersFragment } from '../src/webview/input/usage/formatters';

type CostFormatter = (value: number, currency: string, hasData: boolean) => string;

const formatMetricCost = new Function(
  `${usageFormattersFragment.source}\nreturn formatMetricCost;`
)() as CostFormatter;

test('session cost truncates to exactly two decimal places without rounding', () => {
  assert.equal(formatMetricCost(0.129, '¥', true), '¥0.12');
  assert.equal(formatMetricCost(0.999, '¥', true), '¥0.99');
  assert.equal(formatMetricCost(1.005, '¥', true), '¥1.00');
  assert.equal(formatMetricCost(0.0000001, '¥', true), '¥0.00');
  assert.equal(formatMetricCost(0.29, '¥', true), '¥0.29');
});
