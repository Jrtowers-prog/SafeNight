const fs = require('fs');
const path = require('path');

function readAndroidVersionProps() {
  const versionFile = path.join(__dirname, 'android', 'version.properties');
  let versionCode = 1;
  let versionName = '1.0.0';

  try {
    const raw = fs.readFileSync(versionFile, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      const value = rest.join('=').trim();
      if (key === 'VERSION_CODE') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) versionCode = parsed;
      }
      if (key === 'VERSION_NAME' && value) {
        versionName = value;
      }
    }
  } catch {
    // Fallback to defaults if file is missing or unreadable
  }

  return { versionCode, versionName };
}

module.exports = ({ config }) => {
  const { versionCode, versionName } = readAndroidVersionProps();

  return {
    ...config,
    version: versionName,
    ios: {
      ...config.ios,
      buildNumber: versionName,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSLocationWhenInUseUsageDescription:
          'We use your location to show nearby routes and help you navigate safely.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'SafeNight needs background location access to keep navigating and sharing your location with your Safety Circle even when the app is in the background.',
        NSLocationAlwaysUsageDescription:
          'SafeNight needs background location access to continue navigation and live location sharing.',
        UIBackgroundModes: ['location', 'fetch'],
      },
    },
    android: {
      ...config.android,
      versionCode,
      permissions: Array.from(
        new Set([
          ...(config.android?.permissions ?? []),
          'ACCESS_FINE_LOCATION',
          'ACCESS_COARSE_LOCATION',
          'ACCESS_BACKGROUND_LOCATION',
          'FOREGROUND_SERVICE',
          'FOREGROUND_SERVICE_LOCATION',
        ])
      ),
    },
  };
};
