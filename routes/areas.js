'use strict';

// Placeholder home pages for each role area. Each one is guarded by a
// capability, so a user can only open the areas their role allows.

const express = require('express');
const { requirePerm } = require('../middleware/permissions');
const { noStore } = require('../middleware/security');

const router = express.Router();

const AREAS = [
  { path: '/platform', capability: 'platform.access', heading: 'لوحة إدارة المنصة' },
  { path: '/office', capability: 'contracts', heading: 'لوحة المكتب' },
  { path: '/landlord', capability: 'own.units', heading: 'صفحة المالك' },
  { path: '/tenant', capability: 'own.contract', heading: 'صفحة المستأجر' },
];

for (const area of AREAS) {
  router.get(area.path, noStore, requirePerm(area.capability), (req, res) => {
    res.render('pages/area', { title: area.heading, heading: area.heading });
  });
}

module.exports = router;
