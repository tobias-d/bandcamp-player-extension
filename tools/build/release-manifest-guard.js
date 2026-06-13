const fs = require('fs');
const path = require('path');

const MANIFEST_CONTRACTS = {
  chrome: {
    browser: 'chrome',
    manifestVersion: 3,
    sourceManifestPath: 'src/manifest.json'
  },
  firefox: {
    browser: 'firefox',
    manifestVersion: 2,
    sourceManifestPath: 'src/manifest.firefox.json'
  },
  'firefox-dev': {
    browser: 'firefox',
    manifestVersion: 2,
    sourceManifestPath: 'src/manifest.firefox.dev.json'
  }
};

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function assertManifestVersion(manifest, expectedVersion, label) {
  if (manifest.manifest_version !== expectedVersion) {
    fail(`${label} must use manifest_version ${expectedVersion}; found ${manifest.manifest_version}`);
  }
}

function assertPackageVersion(manifest, packageVersion, label) {
  if (manifest.version !== packageVersion) {
    fail(`${label} version ${manifest.version} does not match package.json ${packageVersion}`);
  }
}

function assertChromeManifest(manifest, label) {
  assertManifestVersion(manifest, 3, label);

  if (!hasObject(manifest.background) || typeof manifest.background.service_worker !== 'string') {
    fail(`${label} must use a Chrome MV3 background.service_worker`);
  }

  if (Array.isArray(manifest.background.scripts)) {
    fail(`${label} must not use MV2 background.scripts`);
  }

  if (!Array.isArray(manifest.host_permissions)) {
    fail(`${label} must declare Chrome MV3 host_permissions separately from permissions`);
  }

  const hasHostPermissionInPermissions = Array.isArray(manifest.permissions)
    && manifest.permissions.some((permission) => typeof permission === 'string' && permission.includes('://'));
  if (hasHostPermissionInPermissions) {
    fail(`${label} must not place host match patterns inside Chrome MV3 permissions`);
  }

  if (
    !Array.isArray(manifest.web_accessible_resources)
    || !manifest.web_accessible_resources.every((entry) => {
      return hasObject(entry) && Array.isArray(entry.resources) && Array.isArray(entry.matches);
    })
  ) {
    fail(`${label} must use Chrome MV3 web_accessible_resources objects with resources and matches`);
  }
}

function assertFirefoxManifest(manifest, label, { production = true } = {}) {
  assertManifestVersion(manifest, 2, label);

  if (!hasObject(manifest.background) || !Array.isArray(manifest.background.scripts)) {
    fail(`${label} must use Firefox MV2 background.scripts`);
  }

  if (typeof manifest.background.service_worker === 'string') {
    fail(`${label} must not use Chrome MV3 background.service_worker`);
  }

  if ('host_permissions' in manifest) {
    fail(`${label} must keep Firefox MV2 host match patterns in permissions, not host_permissions`);
  }

  if (!Array.isArray(manifest.web_accessible_resources)) {
    fail(`${label} must use Firefox MV2 web_accessible_resources as a string array`);
  }

  const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
  if (!hasObject(gecko) || typeof gecko.id !== 'string' || !gecko.id.trim()) {
    fail(`${label} must include browser_specific_settings.gecko.id for Firefox release signing`);
  }

  if (production) {
    const requiredDataPermissions = gecko.data_collection_permissions
      && gecko.data_collection_permissions.required;
    if (!Array.isArray(requiredDataPermissions) || !requiredDataPermissions.includes('none')) {
      fail(`${label} must declare Firefox data_collection_permissions.required: ["none"]`);
    }
  }
}

function assertManifestContract(manifest, contractName, label, options = {}) {
  const contract = MANIFEST_CONTRACTS[contractName];
  if (!contract) {
    fail(`Unknown manifest contract: ${contractName}`);
  }

  if (contract.browser === 'chrome') {
    assertChromeManifest(manifest, label);
    return;
  }

  assertFirefoxManifest(manifest, label, options);
}

function verifySourceManifest(projectRoot, contractName, packageVersion) {
  const contract = MANIFEST_CONTRACTS[contractName];
  if (!contract) {
    fail(`Unknown manifest contract: ${contractName}`);
  }

  const manifestPath = path.resolve(projectRoot, contract.sourceManifestPath);
  const manifest = readJsonFile(manifestPath);
  const label = contract.sourceManifestPath;

  assertPackageVersion(manifest, packageVersion, label);
  assertManifestContract(manifest, contractName, label, {
    production: contractName !== 'firefox-dev'
  });
}

function verifyBuiltManifest(projectRoot, browser, packageVersion) {
  const manifestPath = path.resolve(projectRoot, 'dist', browser, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail(`Build output is missing manifest.json for ${browser}`);
  }

  const manifest = readJsonFile(manifestPath);
  const label = path.relative(projectRoot, manifestPath);

  assertPackageVersion(manifest, packageVersion, label);
  assertManifestContract(manifest, browser, label, { production: true });
}

module.exports = {
  verifyBuiltManifest,
  verifySourceManifest
};
