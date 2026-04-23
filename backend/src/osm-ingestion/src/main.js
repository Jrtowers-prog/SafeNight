/**
 * main.js — Entry point for OSM ingestion service.
 */

require('dotenv').config();

const { startServer } = require('./server');
const { startScheduler } = require('./scheduler');

startServer();
startScheduler();
