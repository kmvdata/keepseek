const { isDeepStrictEqual } = require('node:util');

function assertPackagedConfiguration(packagedManifest, sourceManifest, runtimeIdentity) {
  const namespace = /exports\.KEEPSEEK_CONFIGURATION_NAMESPACE\s*=\s*['"]([^'"]+)['"]/u.exec(runtimeIdentity)?.[1];
  if (!namespace) throw new Error('VSIX runtime is missing its configuration namespace.');
  const configuration = packagedManifest.contributes?.configuration;
  if (!isDeepStrictEqual(configuration, sourceManifest.contributes?.configuration)) {
    throw new Error('VSIX configuration registration does not match package.json. Rebuild the VSIX.');
  }
  const nodes = Array.isArray(configuration) ? configuration : [configuration];
  const properties = Object.assign({}, ...nodes.map(node => node?.properties ?? {}));
  for (const key of ['selectedSourceId', 'selectedModelId']) {
    if (properties[`${namespace}.${key}`]?.type !== 'string') {
      throw new Error(`VSIX does not register the runtime setting ${namespace}.${key}.`);
    }
  }
  if (Object.keys(properties).some(key => !key.startsWith(`${namespace}.`))) {
    throw new Error('VSIX configuration keys and runtime namespace do not match.');
  }
}

module.exports = { assertPackagedConfiguration };
