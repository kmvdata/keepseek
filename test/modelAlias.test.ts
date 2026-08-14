import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveModelDisplayName, resolveSourceModelDisplayName } from '../src/accounts/modelAlias';

test('model display name uses alias, fetched name, built-in label, then id', () => {
  assert.equal(resolveModelDisplayName({
    id: 'model-id',
    alias: ' My Daily Model ',
    fetchedName: 'Provider Name',
    label: 'Built-in Label'
  }), 'My Daily Model');
  assert.equal(resolveModelDisplayName({
    id: 'model-id',
    alias: ' ',
    fetchedName: ' Provider Name ',
    label: 'Built-in Label'
  }), 'Provider Name');
  assert.equal(resolveModelDisplayName({
    id: 'model-id',
    fetchedName: '',
    label: ' Built-in Label '
  }), 'Built-in Label');
  assert.equal(resolveModelDisplayName({ id: ' model-id ' }), 'model-id');
});

test('source model display resolution reads nicknames and fetched names by model id', () => {
  const source = {
    models: [{ id: 'alpha', name: 'Alias Alpha' }],
    modelCache: {
      fetchedAt: 123,
      models: [
        { id: 'alpha', name: 'Fetched Alpha' },
        { id: 'beta', name: 'Fetched Beta' }
      ]
    }
  };
  assert.equal(resolveSourceModelDisplayName(source, 'alpha', 'Built-in Alpha'), 'Alias Alpha');
  assert.equal(resolveSourceModelDisplayName(source, 'beta', 'Built-in Beta'), 'Fetched Beta');
  assert.equal(resolveSourceModelDisplayName(source, 'gamma', 'Built-in Gamma'), 'Built-in Gamma');
  assert.equal(resolveSourceModelDisplayName(source, 'delta'), 'delta');
});
