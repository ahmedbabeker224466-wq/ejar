'use strict';

const express = require('express');
const db = require('../config/db');
const { riyadhNow } = require('../utils/time');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('pages/home', { title: 'عقدي' });
});

router.get('/health', async (req, res) => {
  const database = await db.ping();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    database: database ? 'reachable' : 'unreachable',
    riyadhTime: riyadhNow(),
  });
});

module.exports = router;
