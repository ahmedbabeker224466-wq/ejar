'use strict';

// The platform admin area (routes/admin.js), plus join by code and the landlord and
// tenant areas (routes/portal.js) and notifications (routes/notifications.js). The office area lives in routes/office.js.
// Each page is guarded by a capability, so a user can only open the areas
// their role (or, for landlords and tenants, their links) allows.

const express = require('express');
const portalRoutes = require('./portal');
const notificationRoutes = require('./notifications');
const maintenanceRoutes = require('./maintenance');
const messageRoutes = require('./messages');
const reportRoutes = require('./reports');
const billingRoutes = require('./billing');
const adminRoutes = require('./admin');
const publicListings = require('./publicListings');
const siteRoutes = require('./site');

const router = express.Router();

router.use(adminRoutes);
router.use(publicListings);
router.use(siteRoutes);
router.use(billingRoutes.webhook);
router.use(portalRoutes);
router.use(notificationRoutes);
router.use(maintenanceRoutes.portal);
router.use(maintenanceRoutes.photos);
router.use(messageRoutes.portal);
router.use(reportRoutes.portal);

module.exports = router;
