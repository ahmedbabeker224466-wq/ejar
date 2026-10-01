# تشغيل «عقدي» على استضافة cPanel

هذا الدليل لمن لم يستخدم Node.js على cPanel من قبل. اتبع الخطوات بالترتيب.
الأسماء بالإنجليزية (مثل **Setup Node.js App**) هي كما تظهر لك في cPanel.

> **قبل أن تبدأ**
> - تحتاج استضافة cPanel فيها أداة **Setup Node.js App** (تظهر في قسم **Software**). إذا لم تجدها فاطلب من شركة الاستضافة تفعيلها.
> - تحتاج نطاقاً (دومين) مربوطاً بالاستضافة، وشهادة SSL مفعّلة (غالباً تُفعَّل تلقائياً عبر **AutoSSL** أو **SSL/TLS Status**).

---

## الخطوة 1: إنشاء قاعدة البيانات والمستخدم

1. من الصفحة الرئيسية في cPanel، في قسم **Databases**، اضغط **MySQL® Databases**.
2. **إنشاء القاعدة:** في أعلى الصفحة ستجد مربعاً بعنوان **Create New Database**. قبله يظهر اسم حسابك وشرطة سفلية، مثل `myaccount_`. اكتب `aqdi` واضغط **Create Database**. سيصبح الاسم الكامل `myaccount_aqdi`. انسخه واحفظه.
3. اضغط **Go Back** للرجوع.
4. **إنشاء المستخدم:** انزل إلى قسم **MySQL Users** ثم **Add New User**.
   - في **Username** اكتب `aqdiuser`. سيصبح الاسم الكامل مثلاً `myaccount_aqdiuser`.
   - اضغط **Password Generator** لتوليد كلمة مرور قوية، وانسخها واحفظها في مكان آمن.
   - اضغط **Create User** ثم **Go Back**.
5. **ربط المستخدم بالقاعدة:** انزل إلى **Add User To Database**. اختر المستخدم والقاعدة من القائمتين، واضغط **Add**.
6. ستظهر صفحة فيها مربعات صلاحيات. ضع علامة على **ALL PRIVILEGES** في الأعلى، ثم اضغط **Make Changes**.

الآن معك ثلاث قيم ستحتاجها لاحقاً: اسم القاعدة الكامل، واسم المستخدم الكامل، وكلمة المرور.

> لا تحتاج إنشاء الجداول بيدك. التطبيق ينشئ الجداول الـ 62 تلقائياً عند أول تشغيل.

---

## الخطوة 2: رفع ملفات التطبيق

المكان الموصى به للتطبيق هو مجلد **خارج** `public_html`، مثل `/home/myaccount/aqdi`، حتى لا يستطيع أحد فتح ملف `.env` من المتصفح.

اختر طريقة واحدة من هذه الطرق:

**الطريقة (أ): تلقائياً من GitHub (موصى بها)**

كل مرة تُحدَّث فيها `main` على GitHub وتنجح الاختبارات، يرفع GitHub الملفات المتغيرة إلى الاستضافة ويعيد تشغيل التطبيق.

1. في cPanel افتح **FTP Accounts** وأنشئ حساب FTP. في خانة **Directory** اكتب `aqdi` حتى يدخل الحساب مباشرة إلى مجلد التطبيق.
2. في GitHub افتح المستودع، ثم **Settings** ← **Secrets and variables** ← **Actions** ← **New repository secret**، وأضف:
   - `FTP_HOST`: عنوان السيرفر، مثل `ftp.yourdomain.sa`. تجده في cPanel في صفحة **FTP Accounts** عند الضغط على **Configure FTP Client**.
   - `FTP_USER`: اسم حساب FTP كاملاً، مثل `deploy@yourdomain.sa`.
   - `FTP_PASSWORD`: كلمة مرور حساب FTP.
   - (اختياري) `FTP_SERVER_DIR`: إذا كان حساب FTP لا يدخل مباشرة إلى مجلد التطبيق، ضع هنا المسار، مثل `./aqdi/`.
3. بعد أول رفع ناجح، تابع الخطوة 3.

**الطريقة (ب): يدوياً مرة واحدة**

1. من GitHub اضغط **Code** ← **Download ZIP**.
2. في cPanel افتح **File Manager** وأنشئ مجلد `aqdi` في المجلد الرئيسي، بجانب `public_html` وليس داخله.
3. ادخل المجلد، واضغط **Upload** وارفع ملف ZIP، ثم اضغط عليه بالزر الأيمن واختر **Extract**.
4. تأكد أن `server.js` و `package.json` موجودان **مباشرة** داخل `aqdi`، وليسا داخل مجلد فرعي.

**الطريقة (ج): من داخل cPanel عبر Git Version Control**

في هذه الطريقة يسحب cPanel المستودع من GitHub بنفسه، ثم ينسخ الملفات إلى مجلد التطبيق حسب ملف `.cpanel.yml`.

1. في cPanel، في قسم **Files**، افتح **Git™ Version Control** واضغط **Create**.
2. املأ النموذج:
   - **Clone URL**: رابط المستودع من GitHub. إذا كان المستودع خاصاً (Private) فيحتاج cPanel إلى مفتاح SSH تضيفه في GitHub كـ Deploy key.
   - **Repository Path**: يجب أن يكون مجلداً **منفصلاً** عن مجلد التطبيق، مثل `/home/phillryi/aqdi-src`. لا تكتب هنا `/home/phillryi/aqdi`.
   - **Repository Name**: أي اسم، مثل `aqdi`.
3. اضغط **Create** وانتظر حتى ينتهي النسخ.
4. **مجلد التطبيق `aqdi` لا تملؤه بيدك.** تملؤه مهمة **Deploy HEAD Commit**:
   1. من قائمة المستودعات اضغط **Manage** بجانب المستودع، ثم افتح تبويب **Pull or Deploy**.
   2. اضغط **Update from Remote** لسحب آخر التحديثات من GitHub.
   3. اضغط **Deploy HEAD Commit**.
   4. عندها يقرأ cPanel ملف `.cpanel.yml` وينسخ الملفات من `/home/phillryi/aqdi-src` إلى `/home/phillryi/aqdi`، ثم يعيد تشغيل التطبيق عبر `tmp/restart.txt`.
   5. النسخ لا يحذف ولا يغيّر ملف `.env` ولا مجلدي `uploads` و `backups` في `aqdi`.
5. عند كل تحديث لاحق: كرر **Update from Remote** ثم **Deploy HEAD Commit**.

> **لماذا مجلدان؟** مجلد المستودع (`aqdi-src`) يحتوي نسخة Git الكاملة. أما مجلد التطبيق (`aqdi`) فهو ما يشغّله Node.js، وفيه ملف `.env` ومجلد `node_modules` الخاصان بالسيرفر. لو كانا نفس المجلد، لكانت ملفات Git والإعدادات السرية مختلطة، ولتعارض `node_modules` مع أداة **Setup Node.js App**.

> **مهم:** لا ترفع مجلد `node_modules` أبداً. cPanel يرفض إنشاء التطبيق إذا وجده، لأنه ينشئه بنفسه في الخطوة 5.

---

## الخطوة 3: إنشاء تطبيق Node.js

1. من الصفحة الرئيسية في cPanel، في قسم **Software**، اضغط **Setup Node.js App**.
2. ستظهر صفحة فيها قائمة التطبيقات (فارغة الآن) وزر **CREATE APPLICATION**. اضغطه.
3. املأ النموذج:
   - **Node.js version**: اختر **20** (أي نسخة تبدأ بـ 20).
   - **Application mode**: اختر **Production**.
   - **Application root**: اكتب `aqdi`، وهو اسم المجلد من الخطوة 2.
   - **Application URL**: اختر نطاقك من القائمة، واترك الخانة التي بجانبه فارغة حتى يعمل التطبيق على الصفحة الرئيسية للنطاق.
   - **Application startup file**: اكتب `server.js`.
   - **Passenger log file** (إن ظهر): اكتب `/home/myaccount/aqdi/logs/app.log`، مع استبدال `myaccount` باسم حسابك. في هذا الملف ستقرأ رسائل التطبيق ورمز الدخول.
     قبل ذلك أنشئ مجلداً اسمه `logs` داخل `aqdi` من **File Manager** (زر **+ Folder**).
4. اضغط **CREATE** في أعلى اليمين.
5. ستعود لصفحة التطبيق، وسيظهر في الأعلى أمر يبدأ بـ `source /home/...`. هذا لمن يستخدم Terminal، ولن تحتاجه في هذا الدليل.

---

## الخطوة 4: إدخال متغيرات البيئة (الإعدادات السرية)

عندك طريقتان. **اختر واحدة فقط**، ولا تكرر نفس المتغير في المكانين.

**الطريقة الأسهل: ملف `.env`**

1. افتح **File Manager** ← مجلد `aqdi`.
2. اضغط **Settings** في أعلى اليمين، وفعّل **Show Hidden Files (dotfiles)**، ثم **Save**.
3. اضغط **+ File** وأنشئ ملفاً اسمه `.env`، ثم اضغط عليه بالزر الأيمن واختر **Edit**.
4. الصق المحتوى التالي بعد تعبئة القيم، ثم اضغط **Save Changes**:

```
NODE_ENV=production
APP_URL=https://yourdomain.sa
DB_HOST=localhost
DB_PORT=3306
DB_USER=myaccount_aqdiuser
DB_PASSWORD=كلمة مرور قاعدة البيانات
DB_NAME=myaccount_aqdi
JWT_SECRET=نص عشوائي طويل
SECRET_BOX_KEY=64 حرفاً من 0-9 و a-f
CRON_SECRET=نص عشوائي آخر
PLATFORM_ADMIN_PHONE=05XXXXXXXX
SMS_PROVIDER=console
CLAUDE_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-5
```

**الطريقة الثانية: من صفحة التطبيق**

في **Setup Node.js App** ← أيقونة القلم بجانب التطبيق ← قسم **Environment variables** ← **ADD VARIABLE**. أضف كل سطر مما سبق: الاسم في **Name** والقيمة في **Value**، ثم **DONE**، وفي النهاية **SAVE** في أعلى الصفحة.

**متغير للتجربة فقط: `REQUIRE_ADMIN_2FA`**

- قيمته الافتراضية `true`، أي أن مدير المنصة يحتاج تطبيق المصادقة عند الدخول.
- إذا وضعته `false` على جهازك أثناء التجربة، يدخل مدير المنصة برمز الجوال فقط، بشرط ألا يكون `NODE_ENV=production`.
- **للتجربة فقط. لا تضعه أبداً على السيرفر.**
- في Production يتم تجاهله تماماً ويبقى التحقق بخطوتين إلزامياً، ويكتب التطبيق سطر خطأ في السجل يقول إن الإعداد تم تجاهله.

**كيف تولّد `JWT_SECRET` و `SECRET_BOX_KEY` و `CRON_SECRET`؟**
- **من كمبيوترك:** إن كان عليه Node.js فشغّل هذا الأمر ثلاث مرات، وانسخ كل ناتج لمتغير:
  ```
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **بدون Node.js:** استخدم أي مولّد كلمات مرور لـ `JWT_SECRET` و `CRON_SECRET` (40 حرفاً أو أكثر). لكن `SECRET_BOX_KEY` يجب أن يكون **64 حرفاً بالضبط** من الأرقام والحروف `a` إلى `f` فقط.

> **تحذير:** لا تغيّر `SECRET_BOX_KEY` بعد أن يفعّل أحد التحقق بخطوتين، وإلا لن يستطيع الدخول.
> لا تشارك هذه القيم مع أحد، ولا تضعها في GitHub.

---

## الخطوة 5: تثبيت المكتبات (npm install)

1. ارجع إلى **Setup Node.js App** واضغط أيقونة القلم بجانب التطبيق.
2. انزل قليلاً. ستجد زر **Run NPM Install** (يظهر فقط إذا وجد cPanel ملف `package.json` في مجلد التطبيق).
3. اضغطه وانتظر حتى تظهر رسالة نجاح. قد يستغرق ذلك دقيقة أو دقيقتين.

> كرر هذه الخطوة فقط عندما يتغير ملف `package.json`، أي عند إضافة مكتبة جديدة. التحديثات العادية لا تحتاجها.

---

## الخطوة 6: تشغيل التطبيق وإعادة تشغيله

- **أول تشغيل:** في صفحة التطبيق اضغط **START APP**، أو **RESTART** إن كان يعمل.
- **إعادة التشغيل لاحقاً:** بعد تعديل `.env`، أو إذا أردت إعادة التشغيل لأي سبب، اختر أياً من هذه الطرق:
  1. زر **RESTART** في صفحة التطبيق.
  2. أو من **File Manager**: أنشئ داخل مجلد `aqdi` مجلداً اسمه `tmp`، وداخله ملفاً اسمه `restart.txt`. كل مرة تعدّل هذا الملف وتحفظه يُعاد تشغيل التطبيق عند أول زيارة بعدها.
  3. أو في صفحة التطبيق، من **Run JS script**، اختر `restart` واضغط **Run JS script**.
- **النشر التلقائي من GitHub (الطريقة أ)** يعيد التشغيل بنفسه بعد كل رفع.

---

## الخطوة 7: التأكد أن كل شيء يعمل

1. **فحص الحالة:** افتح `https://yourdomain.sa/health`. يجب أن ترى سطراً فيه:
   - `"status":"ok"` و `"database":"reachable"`: كل شيء سليم.
   - `"status":"maintenance"`: هناك إعداد ناقص. انتقل للخطوة التالية.
2. **ملف السجل:** افتح `aqdi/logs/app.log` (أو `stderr.log` داخل مجلد `aqdi` في بعض الاستضافات). ستجد في أعلاه مربعاً بعنوان `Aqdi self-check` يوضح:
   - `Environment`: هل هناك متغير ناقص؟ يكتب اسمه، مثل `MISSING JWT_SECRET`.
   - `Database`: هل الاتصال بقاعدة البيانات ناجح؟
   - `Schema`: عدد الجداول، ويجب أن يكون `62/62`.
   - `SMS driver`: يكتب `console` أثناء التجربة.
   - `Status`: `SERVING` تعني أن الموقع يعمل. `MAINTENANCE PAGE` تعني أن الزوار يرون صفحة صيانة، ويكتب السبب بجانبها.
3. **الصفحة الرئيسية:** افتح `https://yourdomain.sa`. يجب أن تظهر «منصة عقدي قيد الإنشاء».

**أخطاء شائعة**

| ما يظهر في السجل | الحل |
|---|---|
| `ER_ACCESS_DENIED_ERROR` | اسم المستخدم أو كلمة المرور في `.env` غير صحيحة. تأكد أنك كتبت الاسم **كاملاً** مع البادئة `myaccount_`. |
| `ER_BAD_DB_ERROR` | اسم قاعدة البيانات غير صحيح، أو المستخدم غير مربوط بها (الخطوة 1، النقطة 5). |
| `MISSING ...` | متغير ناقص في `.env`. أضفه ثم أعد التشغيل. |
| `INVALID SECRET_BOX_KEY` | يجب أن يكون 64 حرفاً بالضبط من 0-9 و a-f. |
| لا يظهر شيء في السجل | اضغط **RESTART** ثم افتح الموقع مرة واحدة، ثم أعد فتح ملف السجل. |

---

## الخطوة 8: فحص الموقع من الجوال (بدون دخول cPanel)

`https://yourdomain.sa/health/detail` يعرض الفحص الكامل بصيغة JSON، لكنه يحتاج **ترويسة (Header)** اسمها `X-Cron-Secret`، وقيمتها هي `CRON_SECRET` من ملف `.env`. بدونها تظهر رسالة `forbidden`.

المتصفح العادي لا يرسل ترويسات، لذا استخدم:
- **على iPhone:** تطبيق **Shortcuts**. أنشئ اختصاراً فيه إجراء **Get Contents of URL**، وأضف تحت **Headers** الاسم `X-Cron-Secret` والقيمة.
- **على Android:** تطبيق مثل **HTTP Shortcuts**، وبنفس الطريقة.

**فحص إضافي مهم مرة واحدة:** في النتيجة ستجد `"yourIp"`. قارنه بعنوان IP جوالك الحقيقي (افتح موقعاً مثل whatismyip من نفس الجوال).
- إذا تطابقا: حد المحاولات لكل عنوان IP يعمل كما يجب.
- إذا ظهر `127.0.0.1`: أخبرني، لأن السيرفر لا يمرر عنوان الزائر. في هذه الحالة يبقى الحد لكل رقم جوال فعالاً.

---

## الخطوة 9: رسائل SMS الحقيقية (لاحقاً)

أثناء التجربة، `SMS_PROVIDER=console` يكتب رمز الدخول في ملف السجل بدل إرساله. ابحث في السجل عن `[SMS-CONSOLE]` لتجد الرمز.

عندما يصبح لديك حساب رسائل، غيّر في `.env` ثم أعد التشغيل:
- **Unifonic:** `SMS_PROVIDER=unifonic` و `SMS_API_KEY` (قيمة AppSid) و `SMS_SENDER` (اسم المرسل المعتمد).
- **Msegat:** `SMS_PROVIDER=msegat` و `SMS_USERNAME` و `SMS_API_KEY` و `SMS_SENDER`.

> لا تترك `console` بعد الإطلاق: الرموز ستبقى في السجل ولن تصل للمستخدمين.

## الخطوة 10: قراءة العقود بالذكاء الاصطناعي (اختياري)

- `CLAUDE_API_KEY`: مفتاح Claude API من console.anthropic.com. إذا تركته فارغاً تبقى الميزة مطفأة، وتظهر للمكاتب رسالة "قراءة العقد بالذكاء الاصطناعي غير مفعّلة، أدخل البيانات يدوياً"، ويعمل الإدخال اليدوي كالمعتاد.
- `CLAUDE_MODEL`: اسم النموذج. إذا تركته فارغاً يُستخدم `claude-sonnet-4-5`.
- لا يُحفظ الملف المرفوع في أي مكان: يبقى في الذاكرة أثناء القراءة فقط. ولا تُكتب في السجل الأسماء ولا الأرقام المقروءة.
- عدد القراءات الشهرية لكل باقة في عمود `max_ai_reads_monthly` في جدول `plans`. قاعدة البيانات الجديدة تبدأ بـ 10 قراءات للتجربة. إذا كانت قاعدتك قديمة وتريد 10 للتجربة فنفّذ في phpMyAdmin:
  `UPDATE plans SET max_ai_reads_monthly = 10 WHERE code = 'trial';`
- بعد إضافة المفتاح أعد تشغيل التطبيق (الخطوة 6).

---

## ملاحظة: تغييرات قاعدة البيانات التي تُطبَّق تلقائياً

عند كل تشغيل يفحص التطبيق الجداول، ويضيف أي عمود ناقص فقط (لا يحذف ولا يغيّر بيانات).
لا تحتاج تنفيذ شيء بيدك. هذه قائمة ما قد يُنفَّذ على الخادم، لتعرفه إن رأيته في السجل:

| منذ | الأمر | يظهر في السجل |
|---|---|---|
| المصادقة | `ALTER TABLE users ADD COLUMN twofa_backup_codes JSON NULL AFTER twofa_enabled` | `Added column users.twofa_backup_codes` |
| المصادقة | `ALTER TABLE otp_codes ADD COLUMN ip VARCHAR(45) NULL AFTER consumed_at` | `Added column otp_codes.ip` |
| الملّاك ورموز الدعوة | `ALTER TABLE invites ADD COLUMN revoked_at DATETIME NULL AFTER used_at` | `Added column invites.revoked_at` |
| العقود | `ALTER TABLE contracts ADD COLUMN tenant_label VARCHAR(120) NULL AFTER unit_id` | `Added column contracts.tenant_label` |
| العقود | `ALTER TABLE contracts ADD COLUMN terminated_at DATETIME NULL AFTER rent_change_deadline` | `Added column contracts.terminated_at` |
| العقود | `ALTER TABLE contracts ADD COLUMN terminated_reason VARCHAR(255) NULL AFTER terminated_at` | `Added column contracts.terminated_reason` |
| العقود | `ALTER TABLE contracts ADD COLUMN renewed_at DATETIME NULL AFTER terminated_reason` | `Added column contracts.renewed_at` |
| العقود | `ALTER TABLE contracts ADD COLUMN renewed_to_id BIGINT UNSIGNED NULL AFTER renewed_at` | `Added column contracts.renewed_to_id` |
| العقود | `ALTER TABLE contracts ADD COLUMN renewed_from_id BIGINT UNSIGNED NULL AFTER renewed_to_id` | `Added column contracts.renewed_from_id` |
| صفحات المالك والمستأجر | `ALTER TABLE contract_payments ADD COLUMN reported_at DATETIME NULL AFTER paid_at` | `Added column contract_payments.reported_at` |
| صفحات المالك والمستأجر | `ALTER TABLE contract_payments ADD COLUMN reported_by BIGINT UNSIGNED NULL AFTER reported_at` | `Added column contract_payments.reported_by` |
| صفحات المالك والمستأجر | `ALTER TABLE contract_payments MODIFY COLUMN status ENUM('due','paid','late','waived','tenant_reported') NOT NULL DEFAULT 'due'` | `Added tenant_reported to contract_payments.status` |

كل أمر يُنفَّذ مرة واحدة فقط، وفقط إذا كان العمود (أو القيمة الجديدة في القائمة) غير موجود. أمر `MODIFY COLUMN` يضيف قيمة جديدة لقائمة الحالات، ولا يغيّر أي صف موجود.

تحديث المباني والوحدات لم يضف أي تغيير على قاعدة البيانات. تحديث العقود أضاف الأعمدة الستة أعلاه، ولم يضف جداول جديدة. تحديث قراءة العقود بالذكاء الاصطناعي أضاف جدولاً واحداً جديداً: `ai_reads_usage` (عدد القراءات لكل مكتب في كل شهر)، فأصبحت الجداول 60. يُنشأ تلقائياً بأمر `CREATE TABLE IF NOT EXISTS` عند التشغيل. تحديث صفحات المالك والمستأجر أضاف جدولين: `contract_decisions` (قرار المالك بشأن التجديد) و`contract_requests` (طلبات المستأجر، مثل تخفيض الإيجار)، فأصبحت الجداول 62، إضافة إلى العمودين والقيمة الجديدة أعلاه.

## ملاحظة: HTTPS

ملف تعريف الدخول (Cookie) يعمل عبر `https://` فقط في وضع Production. إذا فتحت الموقع عبر `http://` فلن يكتمل تسجيل الدخول.

في cPanel افتح **Domains** وفعّل **Force HTTPS Redirect** لنطاقك، حتى يُحوَّل كل زائر إلى `https` تلقائياً.
