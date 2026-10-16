const fs = require('fs');
const path = require('path');

const versionFile = path.join(__dirname, '..', 'android', 'version.properties');

function parseProps(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key) continue;
    result[key.trim()] = rest.join('=').trim();
  }
  return result;
}

function writeProps(filePath, props, originalContent) {
  const lines = originalContent.split(/\r?\n/);
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const [key] = trimmed.split('=');
    const cleanKey = key.trim();
    if (Object.prototype.hasOwnProperty.call(props, cleanKey)) {
      seen.add(cleanKey);
      return `${cleanKey}=${props[cleanKey]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(props)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(filePath, `${nextLines.join('\n').trimEnd()}\n`, 'utf8');
}

function bumpVersionCode() {
  if (!fs.existsSync(versionFile)) {
    throw new Error(`Missing file: ${versionFile}`);
  }

  const raw = fs.readFileSync(versionFile, 'utf8');
  const props = parseProps(raw);
  const current = Number.parseInt(props.VERSION_CODE ?? '0', 10);

  if (!Number.isFinite(current) || current <= 0) {
    throw new Error('VERSION_CODE in android/version.properties must be a positive integer.');
  }

  const next = current + 1;
  props.VERSION_CODE = String(next);
  writeProps(versionFile, props, raw);

  console.log(`[version] Android VERSION_CODE bumped: ${current} -> ${next}`);
}

bumpVersionCode();