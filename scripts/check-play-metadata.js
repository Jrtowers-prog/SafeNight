#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();

const filesToScan = [
  'app.json',
  'public/manifest.json',
  'src/config/seo.ts',
  'app/+html.tsx',
];

const bannedPatterns = [
  /\b#1\b/i,
  /\bbest\b/i,
  /\btop\b/i,
  /\bleading\b/i,
  /\bfirst\b/i,
  /\bnew\b/i,
  /\bdiscount\b/i,
  /\bsale\b/i,
  /\bfree\b/i,
  /million\s+downloads?/i,
  /aggregateRating/i,
  /ratingValue/i,
  /ratingCount/i,
  /testimonial/i,
  /award/i,
  /accolade/i,
];

function lineMatches(line) {
  return bannedPatterns.filter((pattern) => pattern.test(line));
}

let totalFindings = 0;

for (const relativePath of filesToScan) {
  const absPath = path.join(root, relativePath);
  if (!fs.existsSync(absPath)) {
    continue;
  }

  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const matches = lineMatches(line);
    if (matches.length === 0) return;

    totalFindings += matches.length;
    const labels = matches.map((m) => m.toString()).join(', ');
    console.error(`${relativePath}:${index + 1}: matched ${labels}`);
    console.error(`  ${line.trim()}`);
  });
}

if (totalFindings > 0) {
  console.error(`\nPlay metadata check failed with ${totalFindings} potential issue(s).`);
  process.exit(1);
}

console.log('Play metadata check passed: no risky policy terms found.');
