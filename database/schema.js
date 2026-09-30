'use strict';

// Ordered CREATE TABLE IF NOT EXISTS statements, run by ensureSchema() at startup.
// A table appears after every table it references.
//
// Conventions
// - InnoDB, utf8mb4_unicode_ci, BIGINT UNSIGNED auto-increment id.
// - created_at / updated_at are TIMESTAMP (UTC). Other points in time are
//   DATETIME holding UTC; calendar dates are DATE ('YYYY-MM-DD').
// - Money is DECIMAL(12,2) with a CHAR(3) currency column, SAR by default.
// - ON DELETE CASCADE when a row cannot outlive its parent, SET NULL when it can
//   (those columns are therefore nullable).
// - Privacy: no column anywhere holds party names, ID/iqama numbers, IBAN,
//   meter/account numbers, full addresses or contract file contents.
// Requires MySQL 8.0.13+ or MariaDB 10.2+ (expression default on invites.expires_at).

const ID = 'id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY';
const TIMESTAMPS = [
  'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
  'updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
];
const MONEY = 'DECIMAL(12,2)';
const CURRENCY = "currency CHAR(3) NOT NULL DEFAULT 'SAR'";
const REF = 'BIGINT UNSIGNED';

const CONSTRAINT_LINE = /^(PRIMARY KEY|UNIQUE KEY|KEY|CONSTRAINT)\b/;

function table(name, lines, { id = true } = {}) {
  const columns = lines.filter((line) => !CONSTRAINT_LINE.test(line));
  const constraints = lines.filter((line) => CONSTRAINT_LINE.test(line));
  const body = [...(id ? [ID] : []), ...columns, ...TIMESTAMPS, ...constraints];
  return {
    name,
    sql:
      `CREATE TABLE IF NOT EXISTS \`${name}\` (\n  ${body.join(',\n  ')}\n)` +
      ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  };
}

/** Foreign key clause; onDelete is 'CASCADE' or 'SET NULL'. */
function fk(tableName, column, parent, onDelete) {
  return (
    `CONSTRAINT fk_${tableName}_${column} FOREIGN KEY (${column}) ` +
    `REFERENCES \`${parent}\` (id) ON DELETE ${onDelete}`
  );
}

const TABLES = [
  // ---------------------------------------------------------------- ACCOUNTS
  table('users', [
    'phone VARCHAR(20) NOT NULL',
    'name VARCHAR(120) NULL',
    'email VARCHAR(190) NULL',
    "role ENUM('platform_admin','office_owner','office_manager','office_staff','landlord','tenant') NULL",
    'is_active TINYINT(1) NOT NULL DEFAULT 1',
    'phone_verified TINYINT(1) NOT NULL DEFAULT 0',
    "locale VARCHAR(10) NOT NULL DEFAULT 'ar'",
    'session_epoch INT NOT NULL DEFAULT 1',
    'twofa_secret VARBINARY(255) NULL',
    'twofa_enabled TINYINT(1) NOT NULL DEFAULT 0',
    'twofa_backup_codes JSON NULL', // HMAC hashes of unused backup codes
    'last_seen_at DATETIME NULL',
    'UNIQUE KEY uq_users_phone (phone)',
  ]),

  table('otp_codes', [
    'phone VARCHAR(20) NOT NULL',
    'code_hash CHAR(64) NOT NULL',
    "purpose ENUM('login','verify','recover') NOT NULL",
    'attempts TINYINT UNSIGNED NOT NULL DEFAULT 0',
    'expires_at DATETIME NOT NULL',
    'consumed_at DATETIME NULL',
    'ip VARCHAR(45) NULL', // for the per-IP request limit
    'KEY idx_otp_codes_phone_expires (phone, expires_at)',
    'KEY idx_otp_codes_ip_created (ip, created_at)',
  ]),

  table('user_sessions', [
    `user_id ${REF} NOT NULL`,
    'token_id CHAR(36) NOT NULL',
    'ip VARCHAR(45) NULL',
    'user_agent TEXT NULL',
    'expires_at DATETIME NOT NULL',
    'revoked_at DATETIME NULL',
    'UNIQUE KEY uq_user_sessions_token (token_id)',
    fk('user_sessions', 'user_id', 'users', 'CASCADE'),
  ]),

  table('user_devices', [
    `user_id ${REF} NOT NULL`,
    'fingerprint CHAR(64) NOT NULL',
    'os VARCHAR(60) NULL',
    'browser VARCHAR(60) NULL',
    'country CHAR(2) NULL',
    'first_seen_at DATETIME NOT NULL',
    'last_seen_at DATETIME NOT NULL',
    'UNIQUE KEY uq_user_devices_user_fp (user_id, fingerprint)',
    fk('user_devices', 'user_id', 'users', 'CASCADE'),
  ]),

  table('notification_prefs', [
    `user_id ${REF} NOT NULL`,
    "channel ENUM('site','email','whatsapp','telegram') NOT NULL",
    'event_type VARCHAR(50) NOT NULL',
    'enabled TINYINT(1) NOT NULL DEFAULT 1',
    'UNIQUE KEY uq_notification_prefs (user_id, channel, event_type)',
    fk('notification_prefs', 'user_id', 'users', 'CASCADE'),
  ]),

  // ----------------------------------------------------------------- MONEY (plans first: offices reference it)
  table('plans', [
    'code VARCHAR(30) NOT NULL',
    'name_ar VARCHAR(80) NOT NULL',
    `price_monthly ${MONEY} NOT NULL DEFAULT 0`,
    `price_yearly ${MONEY} NOT NULL DEFAULT 0`,
    CURRENCY,
    'max_contracts INT UNSIGNED NULL',
    'max_units INT UNSIGNED NULL',
    'max_members INT UNSIGNED NULL',
    'max_ai_reads_monthly INT UNSIGNED NULL',
    'features JSON NULL',
    'is_active TINYINT(1) NOT NULL DEFAULT 1',
    'sort_order INT NOT NULL DEFAULT 0',
    'UNIQUE KEY uq_plans_code (code)',
  ]),

  // ----------------------------------------------------------------- OFFICES
  table('offices', [
    'name VARCHAR(150) NOT NULL',
    'cr_number VARCHAR(30) NULL',
    'rega_license VARCHAR(30) NULL',
    'city VARCHAR(80) NOT NULL',
    'logo_path VARCHAR(255) NULL',
    'phone VARCHAR(20) NOT NULL',
    'whatsapp VARCHAR(20) NULL',
    'email VARCHAR(190) NULL',
    `owner_id ${REF} NULL`,
    `plan_id ${REF} NULL`,
    "status ENUM('trial','active','past_due','suspended') NOT NULL DEFAULT 'trial'",
    'trial_ends_at DATETIME NULL',
    'subscription_ends_at DATETIME NULL',
    fk('offices', 'owner_id', 'users', 'SET NULL'),
    fk('offices', 'plan_id', 'plans', 'SET NULL'),
  ]),

  table('office_members', [
    `office_id ${REF} NOT NULL`,
    `user_id ${REF} NOT NULL`,
    "role ENUM('office_owner','office_manager','office_staff') NOT NULL",
    'is_active TINYINT(1) NOT NULL DEFAULT 1',
    'joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
    'UNIQUE KEY uq_office_members (office_id, user_id)',
    fk('office_members', 'office_id', 'offices', 'CASCADE'),
    fk('office_members', 'user_id', 'users', 'CASCADE'),
  ]),

  table('office_branches', [
    `office_id ${REF} NOT NULL`,
    'name VARCHAR(120) NOT NULL',
    'city VARCHAR(80) NOT NULL',
    `manager_id ${REF} NULL`,
    fk('office_branches', 'office_id', 'offices', 'CASCADE'),
    fk('office_branches', 'manager_id', 'users', 'SET NULL'),
  ]),

  table('office_settings', [
    `office_id ${REF} NOT NULL`,
    'setting_key VARCHAR(80) NOT NULL',
    'setting_value TEXT NULL',
    'UNIQUE KEY uq_office_settings (office_id, setting_key)',
    fk('office_settings', 'office_id', 'offices', 'CASCADE'),
  ]),

  table('office_secrets', [
    `office_id ${REF} NOT NULL`,
    'secret_key VARCHAR(80) NOT NULL',
    'secret_value VARBINARY(2048) NOT NULL', // encrypted at rest
    'last4 VARCHAR(8) NULL',
    'UNIQUE KEY uq_office_secrets (office_id, secret_key)',
    fk('office_secrets', 'office_id', 'offices', 'CASCADE'),
  ]),

  // -------------------------------------------------------------- PROPERTIES
  table('landlords', [
    `office_id ${REF} NOT NULL`,
    `user_id ${REF} NULL`,
    // A nickname typed by the office, never copied from a contract.
    'label VARCHAR(120) NOT NULL',
    'city VARCHAR(80) NULL',
    'phone VARCHAR(20) NULL',
    'notes TEXT NULL',
    'is_active TINYINT(1) NOT NULL DEFAULT 1',
    'KEY idx_landlords_office (office_id)',
    fk('landlords', 'office_id', 'offices', 'CASCADE'),
    fk('landlords', 'user_id', 'users', 'SET NULL'),
  ]),

  table('buildings', [
    `office_id ${REF} NOT NULL`,
    `landlord_id ${REF} NOT NULL`,
    'name VARCHAR(120) NOT NULL',
    'city VARCHAR(80) NOT NULL',
    'district VARCHAR(80) NULL',
    'notes TEXT NULL',
    fk('buildings', 'office_id', 'offices', 'CASCADE'),
    fk('buildings', 'landlord_id', 'landlords', 'CASCADE'),
  ]),

  table('units', [
    `office_id ${REF} NOT NULL`,
    `landlord_id ${REF} NOT NULL`,
    `building_id ${REF} NULL`,
    'label VARCHAR(120) NOT NULL',
    "unit_type ENUM('apartment','villa','shop','office','warehouse','land','other') NOT NULL DEFAULT 'apartment'",
    'rooms TINYINT UNSIGNED NULL',
    'bathrooms TINYINT UNSIGNED NULL',
    'area_sqm DECIMAL(10,2) NULL',
    'floor_no SMALLINT NULL',
    'is_furnished TINYINT(1) NOT NULL DEFAULT 0',
    'city VARCHAR(80) NOT NULL',
    'district VARCHAR(80) NULL',
    `base_rent ${MONEY} NULL`,
    CURRENCY,
    "status ENUM('vacant','rented','maintenance') NOT NULL DEFAULT 'vacant'",
    'notes TEXT NULL',
    'KEY idx_units_office_status (office_id, status)',
    'KEY idx_units_landlord (landlord_id)',
    fk('units', 'office_id', 'offices', 'CASCADE'),
    fk('units', 'landlord_id', 'landlords', 'CASCADE'),
    fk('units', 'building_id', 'buildings', 'SET NULL'),
  ]),

  table('unit_photos', [
    `unit_id ${REF} NOT NULL`,
    'path VARCHAR(255) NOT NULL',
    'sort_order INT NOT NULL DEFAULT 0',
    'is_cover TINYINT(1) NOT NULL DEFAULT 0',
    fk('unit_photos', 'unit_id', 'units', 'CASCADE'),
  ]),

  table('unit_amenities', [
    `unit_id ${REF} NOT NULL`,
    'amenity VARCHAR(60) NOT NULL',
    fk('unit_amenities', 'unit_id', 'units', 'CASCADE'),
  ]),

  // --------------------------------------------------------------- CONTRACTS
  table('contracts', [
    `office_id ${REF} NOT NULL`,
    `landlord_id ${REF} NULL`,
    `unit_id ${REF} NULL`,
    'contract_number VARCHAR(40) NULL',
    'ejar_ref VARCHAR(40) NULL',
    'start_date DATE NOT NULL',
    'end_date DATE NOT NULL',
    'hijri_start VARCHAR(30) NULL',
    'hijri_end VARCHAR(30) NULL',
    `annual_rent ${MONEY} NOT NULL`,
    CURRENCY,
    "payment_frequency ENUM('monthly','quarterly','semiannual','annual') NULL",
    `deposit ${MONEY} NULL`,
    `commission ${MONEY} NULL`,
    'city VARCHAR(80) NULL',
    "status ENUM('calm','soon','urgent','deadline_passed','ended','renewed','terminated') NOT NULL DEFAULT 'calm'",
    'auto_renew TINYINT(1) NOT NULL DEFAULT 1',
    'notice_deadline DATE NULL',
    'rent_change_deadline DATE NULL',
    "source ENUM('ai','manual') NOT NULL DEFAULT 'manual'",
    'ai_confidence VARCHAR(20) NULL',
    'warnings JSON NULL',
    `created_by ${REF} NULL`,
    'KEY idx_contracts_office_end (office_id, end_date)',
    'KEY idx_contracts_office_status (office_id, status)',
    fk('contracts', 'office_id', 'offices', 'CASCADE'),
    fk('contracts', 'landlord_id', 'landlords', 'SET NULL'),
    fk('contracts', 'unit_id', 'units', 'SET NULL'),
    fk('contracts', 'created_by', 'users', 'SET NULL'),
  ]),

  table(
    'contract_members',
    [
      `contract_id ${REF} NOT NULL`,
      `user_id ${REF} NOT NULL`,
      "role ENUM('landlord','tenant') NOT NULL",
      'PRIMARY KEY (contract_id, user_id)',
      fk('contract_members', 'contract_id', 'contracts', 'CASCADE'),
      fk('contract_members', 'user_id', 'users', 'CASCADE'),
    ],
    { id: false },
  ),

  table('contract_payments', [
    `contract_id ${REF} NOT NULL`,
    `office_id ${REF} NOT NULL`,
    'due_date DATE NOT NULL',
    `amount ${MONEY} NOT NULL`,
    CURRENCY,
    "status ENUM('due','paid','late','waived') NOT NULL DEFAULT 'due'",
    'paid_at DATETIME NULL',
    'method VARCHAR(30) NULL',
    'receipt_no VARCHAR(40) NULL',
    'note VARCHAR(255) NULL',
    'KEY idx_contract_payments_office_due (office_id, due_date, status)',
    'KEY idx_contract_payments_contract (contract_id)',
    fk('contract_payments', 'contract_id', 'contracts', 'CASCADE'),
    fk('contract_payments', 'office_id', 'offices', 'CASCADE'),
  ]),

  table('contract_events', [
    `contract_id ${REF} NOT NULL`,
    `actor_id ${REF} NULL`,
    'event_type VARCHAR(50) NOT NULL',
    'details JSON NULL',
    fk('contract_events', 'contract_id', 'contracts', 'CASCADE'),
    fk('contract_events', 'actor_id', 'users', 'SET NULL'),
  ]),

  table('contract_notices', [
    `contract_id ${REF} NOT NULL`,
    "notice_type ENUM('non_renewal','rent_change') NOT NULL",
    `issued_by ${REF} NULL`,
    'issued_at DATETIME NOT NULL',
    'body TEXT NOT NULL',
    'printed_at DATETIME NULL',
    fk('contract_notices', 'contract_id', 'contracts', 'CASCADE'),
    fk('contract_notices', 'issued_by', 'users', 'SET NULL'),
  ]),

  table('contract_renewals', [
    `old_contract_id ${REF} NOT NULL`,
    `new_contract_id ${REF} NOT NULL`,
    `created_by ${REF} NULL`,
    fk('contract_renewals', 'old_contract_id', 'contracts', 'CASCADE'),
    fk('contract_renewals', 'new_contract_id', 'contracts', 'CASCADE'),
    fk('contract_renewals', 'created_by', 'users', 'SET NULL'),
  ]),

  // Supporting documents an office chooses to keep. Never the uploaded Ejar
  // contract file, which is read in memory and discarded.
  table('contract_documents', [
    `contract_id ${REF} NOT NULL`,
    `office_id ${REF} NOT NULL`,
    'path VARCHAR(255) NOT NULL',
    'label VARCHAR(120) NOT NULL',
    `uploaded_by ${REF} NULL`,
    fk('contract_documents', 'contract_id', 'contracts', 'CASCADE'),
    fk('contract_documents', 'office_id', 'offices', 'CASCADE'),
    fk('contract_documents', 'uploaded_by', 'users', 'SET NULL'),
  ]),

  // Metrics about AI reads only. Never a column holding contract content.
  table('extraction_jobs', [
    `office_id ${REF} NOT NULL`,
    `user_id ${REF} NULL`,
    "status ENUM('pending','success','failed') NOT NULL DEFAULT 'pending'",
    'duration_ms INT UNSIGNED NULL',
    'model VARCHAR(60) NULL',
    'confidence VARCHAR(20) NULL',
    'warning_count INT NOT NULL DEFAULT 0',
    'error_code VARCHAR(40) NULL',
    fk('extraction_jobs', 'office_id', 'offices', 'CASCADE'),
    fk('extraction_jobs', 'user_id', 'users', 'SET NULL'),
  ]),

  table('invites', [
    // 8 characters from an alphabet without 0 O 1 I L (services/inviteCode.js).
    'code CHAR(8) NOT NULL',
    "kind ENUM('landlord','tenant','staff') NOT NULL",
    `office_id ${REF} NOT NULL`,
    `landlord_id ${REF} NULL`,
    `contract_id ${REF} NULL`,
    'role_hint VARCHAR(30) NULL',
    `created_by ${REF} NULL`,
    `used_by ${REF} NULL`,
    'used_at DATETIME NULL',
    'expires_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL 30 DAY)',
    'UNIQUE KEY uq_invites_code (code)',
    'KEY idx_invites_office_kind (office_id, kind)',
    fk('invites', 'office_id', 'offices', 'CASCADE'),
    fk('invites', 'landlord_id', 'landlords', 'CASCADE'),
    fk('invites', 'contract_id', 'contracts', 'CASCADE'),
    fk('invites', 'created_by', 'users', 'SET NULL'),
    fk('invites', 'used_by', 'users', 'SET NULL'),
  ]),

  // ------------------------------------------------------------- MAINTENANCE
  table('vendors', [
    `office_id ${REF} NOT NULL`,
    'name VARCHAR(120) NOT NULL',
    'trade VARCHAR(60) NOT NULL',
    'phone VARCHAR(20) NOT NULL',
    'notes TEXT NULL',
    fk('vendors', 'office_id', 'offices', 'CASCADE'),
  ]),

  table('maintenance_requests', [
    `office_id ${REF} NOT NULL`,
    `unit_id ${REF} NOT NULL`,
    `contract_id ${REF} NULL`,
    `reported_by ${REF} NULL`,
    "category ENUM('plumbing','electrical','ac','appliances','structural','other') NOT NULL",
    'description TEXT NOT NULL',
    "priority ENUM('low','normal','high') NOT NULL DEFAULT 'normal'",
    "status ENUM('open','assigned','in_progress','done','cancelled') NOT NULL DEFAULT 'open'",
    `assigned_vendor_id ${REF} NULL`,
    `cost ${MONEY} NULL`,
    CURRENCY,
    'closed_at DATETIME NULL',
    'KEY idx_maintenance_requests_office_status (office_id, status)',
    fk('maintenance_requests', 'office_id', 'offices', 'CASCADE'),
    fk('maintenance_requests', 'unit_id', 'units', 'CASCADE'),
    fk('maintenance_requests', 'contract_id', 'contracts', 'SET NULL'),
    fk('maintenance_requests', 'reported_by', 'users', 'SET NULL'),
    fk('maintenance_requests', 'assigned_vendor_id', 'vendors', 'SET NULL'),
  ]),

  table('maintenance_messages', [
    `request_id ${REF} NOT NULL`,
    `sender_id ${REF} NULL`,
    'body TEXT NOT NULL',
    fk('maintenance_messages', 'request_id', 'maintenance_requests', 'CASCADE'),
    fk('maintenance_messages', 'sender_id', 'users', 'SET NULL'),
  ]),

  table('maintenance_photos', [
    `request_id ${REF} NOT NULL`,
    'path VARCHAR(255) NOT NULL',
    `uploaded_by ${REF} NULL`,
    fk('maintenance_photos', 'request_id', 'maintenance_requests', 'CASCADE'),
    fk('maintenance_photos', 'uploaded_by', 'users', 'SET NULL'),
  ]),

  // ---------------------------------------------------------------- LISTINGS
  table('listings', [
    `office_id ${REF} NOT NULL`,
    `unit_id ${REF} NOT NULL`,
    'title VARCHAR(160) NOT NULL',
    'description TEXT NOT NULL',
    `price ${MONEY} NOT NULL`,
    CURRENCY,
    'rega_ad_license VARCHAR(40) NULL',
    "status ENUM('draft','pending_review','published','hidden') NOT NULL DEFAULT 'draft'",
    'published_at DATETIME NULL',
    'views_count INT UNSIGNED NOT NULL DEFAULT 0',
    'KEY idx_listings_status_published (status, published_at)',
    fk('listings', 'office_id', 'offices', 'CASCADE'),
    fk('listings', 'unit_id', 'units', 'CASCADE'),
  ]),

  table('listing_inquiries', [
    `listing_id ${REF} NOT NULL`,
    `office_id ${REF} NOT NULL`,
    'name VARCHAR(120) NOT NULL',
    'phone VARCHAR(20) NOT NULL',
    'message TEXT NULL',
    "status ENUM('new','contacted','closed') NOT NULL DEFAULT 'new'",
    fk('listing_inquiries', 'listing_id', 'listings', 'CASCADE'),
    fk('listing_inquiries', 'office_id', 'offices', 'CASCADE'),
  ]),

  table('listing_views', [
    `listing_id ${REF} NOT NULL`,
    'day DATE NOT NULL',
    'views INT UNSIGNED NOT NULL DEFAULT 0',
    'UNIQUE KEY uq_listing_views (listing_id, day)',
    fk('listing_views', 'listing_id', 'listings', 'CASCADE'),
  ]),

  // ------------------------------------------------------------------- MONEY
  table('subscriptions', [
    `office_id ${REF} NOT NULL`,
    `plan_id ${REF} NULL`,
    "status ENUM('trialing','active','past_due','cancelled','expired') NOT NULL",
    "billing_cycle ENUM('monthly','yearly') NOT NULL",
    `price ${MONEY} NOT NULL`,
    CURRENCY,
    'started_at DATETIME NOT NULL',
    'ends_at DATETIME NULL',
    'auto_renew TINYINT(1) NOT NULL DEFAULT 1',
    fk('subscriptions', 'office_id', 'offices', 'CASCADE'),
    fk('subscriptions', 'plan_id', 'plans', 'SET NULL'),
  ]),

  table('subscription_invoices', [
    `office_id ${REF} NOT NULL`,
    `subscription_id ${REF} NULL`,
    'invoice_no VARCHAR(30) NOT NULL',
    `subtotal ${MONEY} NOT NULL`,
    `vat_amount ${MONEY} NOT NULL`,
    `total ${MONEY} NOT NULL`,
    CURRENCY,
    "status ENUM('unpaid','paid','void') NOT NULL DEFAULT 'unpaid'",
    'issued_at DATETIME NOT NULL',
    'paid_at DATETIME NULL',
    'pdf_path VARCHAR(255) NULL',
    'UNIQUE KEY uq_subscription_invoices_no (invoice_no)',
    fk('subscription_invoices', 'office_id', 'offices', 'CASCADE'),
    fk('subscription_invoices', 'subscription_id', 'subscriptions', 'SET NULL'),
  ]),

  table('platform_payments', [
    `office_id ${REF} NOT NULL`,
    `invoice_id ${REF} NULL`,
    "provider ENUM('moyasar','bank_transfer','manual') NOT NULL",
    'provider_ref VARCHAR(80) NULL',
    `amount ${MONEY} NOT NULL`,
    CURRENCY,
    "status ENUM('pending','paid','failed','refunded','expired') NOT NULL DEFAULT 'pending'",
    'raw_payload JSON NULL',
    `confirmed_by ${REF} NULL`,
    fk('platform_payments', 'office_id', 'offices', 'CASCADE'),
    fk('platform_payments', 'invoice_id', 'subscription_invoices', 'SET NULL'),
    fk('platform_payments', 'confirmed_by', 'users', 'SET NULL'),
  ]),

  table('promo_codes', [
    'code VARCHAR(30) NOT NULL',
    'percent TINYINT UNSIGNED NOT NULL',
    'max_uses INT UNSIGNED NULL',
    'used_count INT UNSIGNED NOT NULL DEFAULT 0',
    'expires_at DATETIME NULL',
    'is_active TINYINT(1) NOT NULL DEFAULT 1',
    'UNIQUE KEY uq_promo_codes_code (code)',
  ]),

  table('promo_usages', [
    `promo_id ${REF} NOT NULL`,
    `office_id ${REF} NOT NULL`,
    'used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
    'UNIQUE KEY uq_promo_usages (promo_id, office_id)',
    fk('promo_usages', 'promo_id', 'promo_codes', 'CASCADE'),
    fk('promo_usages', 'office_id', 'offices', 'CASCADE'),
  ]),

  // ------------------------------------------------ NOTIFICATIONS AND MESSAGING
  table('reminders', [
    `contract_id ${REF} NOT NULL`,
    `office_id ${REF} NOT NULL`,
    `user_id ${REF} NOT NULL`,
    "kind ENUM('rent_change_deadline','decision_deadline','end_30','end_7','payment_due','payment_late') NOT NULL",
    'remind_on DATE NOT NULL',
    'sent_at DATETIME NULL',
    "status ENUM('scheduled','sent','skipped','failed') NOT NULL DEFAULT 'scheduled'",
    'UNIQUE KEY uq_reminders (contract_id, user_id, kind, remind_on)',
    'KEY idx_reminders_remind_status (remind_on, status)',
    'KEY idx_reminders_office (office_id)',
    fk('reminders', 'contract_id', 'contracts', 'CASCADE'),
    fk('reminders', 'office_id', 'offices', 'CASCADE'),
    fk('reminders', 'user_id', 'users', 'CASCADE'),
  ]),

  table('notifications', [
    `user_id ${REF} NOT NULL`,
    'title VARCHAR(160) NOT NULL',
    'body TEXT NOT NULL',
    'link VARCHAR(255) NULL',
    'entity_type VARCHAR(50) NULL',
    'entity_id BIGINT UNSIGNED NULL',
    'read_at DATETIME NULL',
    'KEY idx_notifications_user_read (user_id, read_at)',
    fk('notifications', 'user_id', 'users', 'CASCADE'),
  ]),

  table('notification_log', [
    `user_id ${REF} NULL`,
    "channel ENUM('site','email','whatsapp','telegram','sms') NOT NULL",
    'template VARCHAR(60) NOT NULL',
    "status ENUM('sent','failed') NOT NULL",
    'provider_ref VARCHAR(120) NULL',
    'error VARCHAR(255) NULL',
    'attempts TINYINT UNSIGNED NOT NULL DEFAULT 1',
    fk('notification_log', 'user_id', 'users', 'SET NULL'),
  ]),

  table('message_templates', [
    // NULL office_id means the platform default.
    `office_id ${REF} NULL`,
    'code VARCHAR(60) NOT NULL',
    "channel ENUM('site','email','whatsapp','telegram','sms') NOT NULL",
    'body_ar TEXT NOT NULL',
    'KEY idx_message_templates_code (code, channel)',
    fk('message_templates', 'office_id', 'offices', 'CASCADE'),
  ]),

  table('conversations', [
    `office_id ${REF} NOT NULL`,
    'subject VARCHAR(160) NULL',
    `with_user_id ${REF} NOT NULL`,
    'last_message_at DATETIME NULL',
    fk('conversations', 'office_id', 'offices', 'CASCADE'),
    fk('conversations', 'with_user_id', 'users', 'CASCADE'),
  ]),

  table('messages', [
    `conversation_id ${REF} NOT NULL`,
    `sender_id ${REF} NULL`,
    'body TEXT NOT NULL',
    'read_at DATETIME NULL',
    fk('messages', 'conversation_id', 'conversations', 'CASCADE'),
    fk('messages', 'sender_id', 'users', 'SET NULL'),
  ]),

  table('tickets', [
    `office_id ${REF} NOT NULL`,
    `opened_by ${REF} NULL`,
    'subject VARCHAR(160) NOT NULL',
    "priority ENUM('low','normal','high') NOT NULL DEFAULT 'normal'",
    "status ENUM('open','pending','closed') NOT NULL DEFAULT 'open'",
    'ticket_no VARCHAR(20) NOT NULL',
    'first_response_at DATETIME NULL',
    'closed_at DATETIME NULL',
    'UNIQUE KEY uq_tickets_no (ticket_no)',
    fk('tickets', 'office_id', 'offices', 'CASCADE'),
    fk('tickets', 'opened_by', 'users', 'SET NULL'),
  ]),

  table('ticket_messages', [
    `ticket_id ${REF} NOT NULL`,
    `sender_id ${REF} NULL`,
    'body TEXT NOT NULL',
    'is_internal TINYINT(1) NOT NULL DEFAULT 0',
    fk('ticket_messages', 'ticket_id', 'tickets', 'CASCADE'),
    fk('ticket_messages', 'sender_id', 'users', 'SET NULL'),
  ]),

  table('contact_messages', [
    'name VARCHAR(120) NOT NULL',
    'phone VARCHAR(20) NOT NULL',
    'email VARCHAR(190) NULL',
    'message TEXT NOT NULL',
    'handled_at DATETIME NULL',
  ]),

  table('waitlist', [
    'contact VARCHAR(120) NOT NULL',
    "kind ENUM('office','landlord','tenant') NOT NULL",
    'city VARCHAR(80) NULL',
    'note VARCHAR(255) NULL',
  ]),

  // ------------------------------------------------- OPERATIONS AND CONTENT
  table('audit_logs', [
    `office_id ${REF} NULL`,
    `actor_id ${REF} NULL`,
    'action VARCHAR(60) NOT NULL',
    'entity_type VARCHAR(50) NOT NULL',
    'entity_id BIGINT UNSIGNED NULL',
    'before_json JSON NULL',
    'after_json JSON NULL',
    'ip VARCHAR(45) NULL',
    'KEY idx_audit_logs_office_created (office_id, created_at)',
    fk('audit_logs', 'office_id', 'offices', 'SET NULL'),
    fk('audit_logs', 'actor_id', 'users', 'SET NULL'),
  ]),

  table('staff_activity', [
    `user_id ${REF} NOT NULL`,
    `office_id ${REF} NOT NULL`,
    'minute_utc DATETIME NOT NULL',
    'page VARCHAR(120) NOT NULL',
    'ip VARCHAR(45) NULL',
    'UNIQUE KEY uq_staff_activity (user_id, minute_utc)',
    'KEY idx_staff_activity_office_minute (office_id, minute_utc)',
    fk('staff_activity', 'user_id', 'users', 'CASCADE'),
    fk('staff_activity', 'office_id', 'offices', 'CASCADE'),
  ]),

  table('office_tasks', [
    `office_id ${REF} NOT NULL`,
    'title VARCHAR(160) NOT NULL',
    `assigned_to ${REF} NULL`,
    'due_date DATE NULL',
    'entity_type VARCHAR(50) NULL',
    'entity_id BIGINT UNSIGNED NULL',
    "status ENUM('open','done') NOT NULL DEFAULT 'open'",
    `created_by ${REF} NULL`,
    fk('office_tasks', 'office_id', 'offices', 'CASCADE'),
    fk('office_tasks', 'assigned_to', 'users', 'SET NULL'),
    fk('office_tasks', 'created_by', 'users', 'SET NULL'),
  ]),

  table('internal_notes', [
    `office_id ${REF} NOT NULL`,
    'entity_type VARCHAR(50) NOT NULL',
    'entity_id BIGINT UNSIGNED NOT NULL',
    `author_id ${REF} NULL`,
    'body TEXT NOT NULL',
    fk('internal_notes', 'office_id', 'offices', 'CASCADE'),
    fk('internal_notes', 'author_id', 'users', 'SET NULL'),
  ]),

  table('blog_posts', [
    'slug VARCHAR(160) NOT NULL',
    'title_ar VARCHAR(200) NOT NULL',
    'excerpt_ar VARCHAR(500) NULL',
    'body_ar MEDIUMTEXT NOT NULL',
    'cover_path VARCHAR(255) NULL',
    "status ENUM('draft','published') NOT NULL DEFAULT 'draft'",
    'published_at DATETIME NULL',
    'views INT UNSIGNED NOT NULL DEFAULT 0',
    'UNIQUE KEY uq_blog_posts_slug (slug)',
  ]),

  table('testimonials', [
    `office_id ${REF} NULL`,
    'author_name VARCHAR(120) NOT NULL',
    'author_title VARCHAR(120) NULL',
    'body_ar TEXT NOT NULL',
    'rating TINYINT UNSIGNED NULL',
    "status ENUM('pending','approved','hidden') NOT NULL DEFAULT 'pending'",
    fk('testimonials', 'office_id', 'offices', 'SET NULL'),
  ]),

  table('faqs', [
    'question_ar VARCHAR(255) NOT NULL',
    'answer_ar TEXT NOT NULL',
    'sort_order INT NOT NULL DEFAULT 0',
    'is_active TINYINT(1) NOT NULL DEFAULT 1',
  ]),

  table('settings', [
    'setting_key VARCHAR(80) NOT NULL',
    'setting_value TEXT NULL',
    'is_secret TINYINT(1) NOT NULL DEFAULT 0',
    'UNIQUE KEY uq_settings_key (setting_key)',
  ]),

  // Aggregate counts only: never an IP address or a visitor identifier.
  // Dimension columns use '' for "unknown" instead of NULL, because MySQL
  // treats NULLs as distinct in a unique key and the daily upsert would
  // create duplicate rows.
  table('page_views', [
    'day DATE NOT NULL',
    'path VARCHAR(160) NOT NULL',
    "country VARCHAR(2) NOT NULL DEFAULT ''",
    "device VARCHAR(20) NOT NULL DEFAULT ''",
    "referrer_host VARCHAR(120) NOT NULL DEFAULT ''",
    'views INT UNSIGNED NOT NULL DEFAULT 0',
    'UNIQUE KEY uq_page_views (day, path, country, device, referrer_host)',
    'KEY idx_page_views_day (day)',
  ]),

  table('cron_runs', [
    'job_name VARCHAR(60) NOT NULL',
    'started_at DATETIME NOT NULL',
    'finished_at DATETIME NULL',
    'duration_ms INT UNSIGNED NULL',
    'processed INT NOT NULL DEFAULT 0',
    "status ENUM('running','ok','failed') NOT NULL DEFAULT 'running'",
    'error TEXT NULL',
  ]),

  table('backups', [
    'path VARCHAR(255) NOT NULL',
    'size_bytes BIGINT UNSIGNED NULL',
    "status ENUM('ok','failed') NOT NULL",
    'error TEXT NULL',
  ]),

  table('feature_flags', [
    'flag_key VARCHAR(60) NOT NULL',
    'is_enabled TINYINT(1) NOT NULL DEFAULT 0',
    'note VARCHAR(255) NULL',
    'UNIQUE KEY uq_feature_flags_key (flag_key)',
  ]),
];

// Columns and indexes added after a table first shipped. CREATE TABLE above
// already includes them for new databases; ensureSchema() adds them to older
// databases that are missing them.
const COLUMN_ADDITIONS = [
  { table: 'users', column: 'twofa_backup_codes', definition: 'JSON NULL AFTER twofa_enabled' },
  { table: 'otp_codes', column: 'ip', definition: 'VARCHAR(45) NULL AFTER consumed_at' },
];

const INDEX_ADDITIONS = [
  { table: 'otp_codes', index: 'idx_otp_codes_ip_created', columns: 'ip, created_at' },
];

module.exports = {
  TABLES,
  COLUMN_ADDITIONS,
  INDEX_ADDITIONS,
  statements: TABLES.map((t) => t.sql),
  tableNames: TABLES.map((t) => t.name),
};
