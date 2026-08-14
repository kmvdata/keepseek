import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveAccountModelDisplayName,
  resolveModelDisplayName
} from '../src/accounts/modelAlias';

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

test('account model display resolution reads aliases and fetched names by model id', () => {
  const account = {
    modelAliases: { alpha: 'Alias Alpha' },
    modelCache: {
      fetchedAt: 123,
      models: [
        { id: 'alpha', name: 'Fetched Alpha' },
        { id: 'beta', name: 'Fetched Beta' }
      ]
    }
  };
  assert.equal(resolveAccountModelDisplayName(account, 'alpha', 'Built-in Alpha'), 'Alias Alpha');
  assert.equal(resolveAccountModelDisplayName(account, 'beta', 'Built-in Beta'), 'Fetched Beta');
  assert.equal(resolveAccountModelDisplayName(account, 'gamma', 'Built-in Gamma'), 'Built-in Gamma');
  assert.equal(resolveAccountModelDisplayName(account, 'delta'), 'delta');
});
