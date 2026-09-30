'use strict';

module.exports = function notFound(req, res) {
  res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
};
