'use strict';

// The platform area placeholder, plus join by code and the landlord and
// tenant areas (routes/portal.js). The office area lives in routes/office.js.
// Each page is guarded by a capability, so a user can only open the areas
// their role (or, for landlords and tenants, their links) allows.

const express = require('express');
const { requirePerm } = require('../middleware/permissions');
const { noStore } = require('../middleware/security');
const portalRoutes = require('./portal');

const router = express.Router();

const AREAS = [
  { path: '/platform', capability: 'platform.access', heading: 'لوحة إدارة المنصة' },
];

for (const area of AREAS) {
  router.get(area.path, noStore, requirePerm(area.capability), (req, res) => {
    res.render('pages/area', { title: area.heading, heading: area.heading });
  });
}

router.use(portalRoutes);

module.exports = router;
