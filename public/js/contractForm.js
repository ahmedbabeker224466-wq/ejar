// Contract form: live preview. All dates, deadlines, stages and amounts come
// from the server (POST /office/contracts/preview runs the real engine); this
// file only sends the form and shows the answer. Without JavaScript the
// "معاينة المواعيد" button shows the same panel after a page reload.
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('contract-form');
    var panel = document.getElementById('contract-preview');
    var warningsBox = document.getElementById('contract-warnings');
    var ackBox = document.getElementById('ack-box');
    if (!form || !panel || !window.fetch) return;

    var timer = null;
    var latest = 0;

    function field(name) {
      return panel.querySelector('[data-preview="' + name + '"]') || warningsBox.querySelector('[data-preview="' + name + '"]');
    }

    function money(n) {
      return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });
    }

    function setText(name, text) {
      var el = field(name);
      if (el) el.textContent = text;
    }

    function render(data) {
      var p = data.preview;
      panel.hidden = !p;
      if (p) {
        setText('termMonths', p.termMonths + ' شهراً');
        setText('startHijri', p.startHijri);
        setText('endHijri', p.endHijri);
        setText('noticeDeadline', p.noticeDeadline);
        setText('rentChangeDeadline', p.rentChangeDeadline);
        setText('stageLabel', p.stageLabel);
        var freeze = field('freeze');
        freeze.hidden = p.rentPolicy.reason !== 'riyadh_freeze';
        setText('freezeUntil', p.rentPolicy.freezeUntil || '');
        var list = field('schedule');
        list.textContent = '';
        p.schedule.forEach(function (item) {
          var li = document.createElement('li');
          var date = document.createElement('span');
          date.dir = 'ltr';
          date.textContent = item.due_date;
          var amount = document.createElement('strong');
          amount.textContent = money(item.amount) + ' ريال';
          li.appendChild(date);
          li.appendChild(amount);
          list.appendChild(li);
        });
        setText('scheduleSummary', p.scheduleCount + ' دفعة، المجموع ' + money(p.scheduleTotal) + ' ريال');
      }
      var warnings = data.warnings || [];
      var errors = Object.keys(data.errors || {}).map(function (k) { return data.errors[k]; });
      var messages = errors.concat(warnings.map(function (w) { return w.message_ar; }));
      var wl = field('warnings');
      wl.textContent = '';
      messages.forEach(function (m) {
        var li = document.createElement('li');
        li.textContent = m;
        wl.appendChild(li);
      });
      warningsBox.hidden = messages.length === 0;
      if (ackBox) ackBox.hidden = !data.needsAck;
    }

    function collect() {
      var data = {};
      new FormData(form).forEach(function (value, key) { data[key] = value; });
      return data;
    }

    function ready(data) {
      return data.start_date && data.end_date && data.annual_rent;
    }

    function refresh() {
      var data = collect();
      if (!ready(data)) return;
      var id = ++latest;
      fetch('/office/contracts/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) { if (json && id === latest) render(json); })
        .catch(function () { /* the server still checks everything on save */ });
    }

    form.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(refresh, 400);
    });
    form.addEventListener('change', function () {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    });
    var button = form.querySelector('[data-preview-button]');
    if (button) button.hidden = true;
    refresh();
  });
})();
