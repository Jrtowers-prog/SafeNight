/**
 * scheduler.js — Daily cron to run the ingestion pipeline.
 */

const cron = require('node-cron');
const { runPipeline } = require('./pipeline');
const { INGESTION_SCHEDULE } = require('./config');

function startScheduler() {
  console.log(`[scheduler] Daily ingestion scheduled: ${INGESTION_SCHEDULE}`);

  cron.schedule(INGESTION_SCHEDULE, async () => {
    console.log('[scheduler] Triggering daily ingestion...');
    try {
      await runPipeline();
    } catch (err) {
      console.error('[scheduler] Ingestion failed:', err.message);
    }
  });

  // Also run once on startup if dataset is missing
  const { PUBLISH_DIR } = require('./pipeline');
  const fs = require('fs');
  const path = require('path');

  const metaPath = path.join(PUBLISH_DIR, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    console.log('[scheduler] No dataset found — triggering initial ingestion');
    runPipeline().catch((err) => {
      console.error('[scheduler] Initial ingestion failed:', err.message);
    });
  }
}

module.exports = { startScheduler };
