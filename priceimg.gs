/**
 * ==============================================================================
 * منظومة كتالوج «سنتر عبد الله السويس» — مصنف priceimg
 * الملف: priceimg.gs
 * الإصدار: v5.2.0 (إصدار الإنتاج المستقر والآمن)
 * آخر تحديث: 2026-10-22
 * ==============================================================================
 * 
 * 🎯 الغرض والوظيفة المعمارية:
 *   المزامنة الآمنة للبيانات المالية والمخزنية الحية من ورقة (DATAIMP) مع البيانات
 *   التسويقية والإثرائية (الصور، الأوصاف، العلامات التجارية) في ورقة (priceimg).
 * 
 * 🛡️ التحسينات الجذرية والإصلاحات المعمارية في هذا الإصدار:
 *   1. [FIX-CRITICAL] القضاء التام على كارثة «المسح الدائري» (Circular Wipe)
 *      - تم إلغاء targetSheet.clear() المبكر الذي كان يُصفر ورقة priceimg
 *        قبل قراءة DATAIMP، مما كان يتسبب في إرجاع معادلات XLOOKUP لقيم فارغة ومحو كل الصور!
 *   2. [FIX-ALIGNMENT] الدمج الموجه بالمفتاح الفريد (Key-Based In-Memory Merge)
 *      - قراءة البيانات الحالية وبناء خريطة مرجعية في الذاكرة بـ «كود الصنف»
 *        لمنع أي انزلاق للصفوف (Row Misalignment) عند إعادة ترتيب المنتجات أو إضافة أصناف جديدة.
 *   3. [FIX-DRIVE-URLS] المحول الذكي لروابط Google Drive
 *      - تحويل روابط مشاركة درايف (drive.google.com/file/d/...) تلقائياً إلى روابط تدفق مباشر
 *        (lh3.googleusercontent.com/d/...) لتظهر بسلاسة في واجهات المتجر دون كسر.
 *   4. [FIX-CONCURRENCY] قفل التزامن البرمجي (LockService)
 *      - حماية عملية المزامنة بقفل برمجي يمنع تضارب العمليات المتزامنة عند تعدد المستخدمين.
 *   5. [FIX-FORMATTING] الحفاظ على التنسيقات وتفادي الترقيم العلمي للباركود
 *      - استخدام clearContents() بدلاً من clear() للحفاظ على ألوان الجدول وأبعاده،
 *        وتثبيت أكواد الأصناف النصية لمنع تحولها إلى أرقام علمية (مثل 6.81E+12).
 *   6. [UI-INTEGRATION] قائمة مخصصة في واجهة جداول بيانات جوجل (Custom UI Menu)
 *      - إضافة قائمة «سنتر عبد الله» لتشغيل المزامنة والتدقيق بنقرة واحدة من شريط الأدوات.
 * ==============================================================================
 */

const PRICEIMG_CONFIG = Object.freeze({
  VERSION: '5.2.0',
  SOURCE_SHEET_NAME: 'DATAIMP',
  TARGET_SHEET_NAME: 'priceimg',
  LOCK_TIMEOUT_MS: 15000,
  TOTAL_COLUMNS: 15,
  COLUMNS: {
    CODE: 0,        // A: كود الصنف (المفتاح الأساسي)
    NAME: 1,        // B: اسم الصنف
    CASH_PRICE: 2,  // C: سعر الكاش
    INST_PRICE: 3,  // D: سعر البيع قسط
    QTY: 4,         // E: الكمية
    AVAIL: 5,       // F: التوافر
    LAST_SYNC: 6,   // G: آخر تحديث
    IMAGE: 7,       // H: رابط الصورة
    SHORT_NAME: 8,  // I: اسم مختصر
    DESC: 9,        // J: الوصف
    CATEGORY: 10,   // K: التصنيف
    BRAND: 11,      // L: العلامة التجارية
    UNIT: 12,       // M: الوحدة
    STATUS: 13,     // N: حالة المنتج
    LAST_EDIT: 14   // O: آخر تعديل
  }
});

/**
 * إضافة قائمة التحكم الخاصة بسنتر عبد الله إلى شريط أدوات مصنف Google Sheets
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🏪 سنتر عبد الله السويس')
    .addItem('⚡ مزامنة وتحديث الأسعار بأمان (Safe Sync)', 'copyDataimpToPrice')
    .addSeparator()
    .addItem('🔍 فحص وتدقيق سلامة البيانات (Audit)', 'auditPriceimgData')
    .addItem('🧹 تنظيف الأكواد والمسافات الخفية (Sanitize)', 'sanitizeBarcodesAndText')
    .addToUi();
}

/**
 * الدالة الرئيسية: نسخ ومزامنة البيانات بأمان ومنع المسح الدائري وانزلاق الصفوف
 */
function copyDataimpToPrice() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();

  try {
    // 1. تفعيل قفل التزامن لمنع التعارض بين العمليات
    lock.waitLock(PRICEIMG_CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    notifyUser(ss, '⚠️ السيرفر مشغول بعملية تحديث أخرى، يرجى المحاولة بعد لحظات.', true);
    return;
  }

  try {
    const sourceSheet = ss.getSheetByName(PRICEIMG_CONFIG.SOURCE_SHEET_NAME);
    if (!sourceSheet) {
      notifyUser(ss, '❌ الورقة المصدر غير موجودة: ' + PRICEIMG_CONFIG.SOURCE_SHEET_NAME, true);
      return;
    }

    // 2. قراءة البيانات الحية من DATAIMP في الذاكرة أولاً قبل المساس بورقة priceimg
    const sourceRange = sourceSheet.getDataRange();
    const sourceValues = sourceRange.getValues();
    if (sourceValues.length <= 1 || sourceValues[0].length === 0) {
      notifyUser(ss, '⚠️ الورقة المصدر فارغة أو لا تحتوي على صفوف صالحة.', true);
      return;
    }

    let targetSheet = ss.getSheetByName(PRICEIMG_CONFIG.TARGET_SHEET_NAME);
    const enrichmentMap = {};

    // 3. بناء خريطة مرجعية في الذاكرة للبيانات التسويقية والإثرائية السابقة مفهرسة بـ «كود الصنف»
    if (targetSheet && targetSheet.getLastRow() > 1) {
      const oldValues = targetSheet.getDataRange().getValues();
      for (let r = 1; r < oldValues.length; r++) {
        const row = oldValues[r];
        const rawCode = cleanBarcode(row[PRICEIMG_CONFIG.COLUMNS.CODE]);
        if (!rawCode) continue;

        enrichmentMap[rawCode] = {
          image: formatDriveImageUrl(row[PRICEIMG_CONFIG.COLUMNS.IMAGE]),
          shortName: String(row[PRICEIMG_CONFIG.COLUMNS.SHORT_NAME] || '').trim(),
          description: String(row[PRICEIMG_CONFIG.COLUMNS.DESC] || '').trim(),
          brand: String(row[PRICEIMG_CONFIG.COLUMNS.BRAND] || '').trim(),
          unit: String(row[PRICEIMG_CONFIG.COLUMNS.UNIT] || '').trim(),
          status: String(row[PRICEIMG_CONFIG.COLUMNS.STATUS] || '').trim(),
          lastEdit: row[PRICEIMG_CONFIG.COLUMNS.LAST_EDIT] || ''
        };
      }
    } else if (!targetSheet) {
      targetSheet = ss.insertSheet(PRICEIMG_CONFIG.TARGET_SHEET_NAME);
    }

    const currentTimestamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    let updatedRowsCount = 0;

    // 4. الدمج الذكي في الذاكرة: دمج الأرصدة والأسعار الحية مع الإثراء التسويقي المحفوظ
    const mergedValues = sourceValues.map(function(row, idx) {
      const newRow = row.slice();
      while (newRow.length < PRICEIMG_CONFIG.TOTAL_COLUMNS) {
        newRow.push('');
      }

      // معالجة صف الترويسة (Header)
      if (idx === 0) {
        newRow[PRICEIMG_CONFIG.COLUMNS.CODE] = 'كود الصنف';
        newRow[PRICEIMG_CONFIG.COLUMNS.NAME] = 'اسم الصنف';
        newRow[PRICEIMG_CONFIG.COLUMNS.CASH_PRICE] = 'سعر الكاش';
        newRow[PRICEIMG_CONFIG.COLUMNS.INST_PRICE] = 'سعر البيع قسط';
        newRow[PRICEIMG_CONFIG.COLUMNS.QTY] = 'الكمية';
        newRow[PRICEIMG_CONFIG.COLUMNS.AVAIL] = 'حالة التوفر بالمخزن';
        newRow[PRICEIMG_CONFIG.COLUMNS.LAST_SYNC] = 'آخر تحديث';
        newRow[PRICEIMG_CONFIG.COLUMNS.IMAGE] = 'رابط الصورة';
        newRow[PRICEIMG_CONFIG.COLUMNS.SHORT_NAME] = 'اسم مختصر';
        newRow[PRICEIMG_CONFIG.COLUMNS.DESC] = 'الوصف';
        newRow[PRICEIMG_CONFIG.COLUMNS.CATEGORY] = 'التصنيف';
        newRow[PRICEIMG_CONFIG.COLUMNS.BRAND] = 'العلامة التجارية';
        newRow[PRICEIMG_CONFIG.COLUMNS.UNIT] = 'الوحدة';
        newRow[PRICEIMG_CONFIG.COLUMNS.STATUS] = 'حالة المنتج';
        newRow[PRICEIMG_CONFIG.COLUMNS.LAST_EDIT] = 'آخر تعديل';
        return newRow;
      }

      const code = cleanBarcode(newRow[PRICEIMG_CONFIG.COLUMNS.CODE]);
      newRow[PRICEIMG_CONFIG.COLUMNS.CODE] = code;

      // ضبط حالة التوافر تلقائياً بناءً على رصيد المخزون الفعلي
      const qtyNum = Number(newRow[PRICEIMG_CONFIG.COLUMNS.QTY]) || 0;
      newRow[PRICEIMG_CONFIG.COLUMNS.AVAIL] = qtyNum > 0 ? 'متوفر بالمخزن' : 'نفد من المخزن';
      newRow[PRICEIMG_CONFIG.COLUMNS.STATUS] = qtyNum > 0 ? 'متوفر' : 'غير متوفر';

      // فحص ومعالجة رابط الصورة القادم من المصدر
      if (newRow[PRICEIMG_CONFIG.COLUMNS.IMAGE]) {
        newRow[PRICEIMG_CONFIG.COLUMNS.IMAGE] = formatDriveImageUrl(newRow[PRICEIMG_CONFIG.COLUMNS.IMAGE]);
      }

      // دمج وحماية بيانات الإثراء التسويقي السابقة للمنتج
      const saved = enrichmentMap[code];
      if (saved) {
        if (!newRow[PRICEIMG_CONFIG.COLUMNS.IMAGE] || String(newRow[PRICEIMG_CONFIG.COLUMNS.IMAGE]).includes('link removed')) {
          newRow[PRICEIMG_CONFIG.COLUMNS.IMAGE] = saved.image;
        }
        if (!newRow[PRICEIMG_CONFIG.COLUMNS.SHORT_NAME]) {
          newRow[PRICEIMG_CONFIG.COLUMNS.SHORT_NAME] = saved.shortName;
        }
        if (!newRow[PRICEIMG_CONFIG.COLUMNS.DESC]) {
          newRow[PRICEIMG_CONFIG.COLUMNS.DESC] = saved.description;
        }
        if (!newRow[PRICEIMG_CONFIG.COLUMNS.BRAND]) {
          newRow[PRICEIMG_CONFIG.COLUMNS.BRAND] = saved.brand;
        }
        if (!newRow[PRICEIMG_CONFIG.COLUMNS.UNIT]) {
          newRow[PRICEIMG_CONFIG.COLUMNS.UNIT] = saved.unit || 'قطعة';
        }
        newRow[PRICEIMG_CONFIG.COLUMNS.LAST_EDIT] = saved.lastEdit || currentTimestamp;
      } else {
        newRow[PRICEIMG_CONFIG.COLUMNS.LAST_EDIT] = currentTimestamp;
      }

      updatedRowsCount++;
      return newRow;
    });

    // 5. كتابة البيانات المدمجة بأمان فائق (مسح المحتوى فقط مع بقاء التنسيقات والأبعاد سليمة)
    targetSheet.clearContents();
    
    // ضبط تنسيق عمود الباركود كـ نص لمنع تحوله لأرقام علمية
    targetSheet.getRange(1, 1, mergedValues.length, 1).setNumberFormat('@');

    const targetRange = targetSheet.getRange(1, 1, mergedValues.length, mergedValues[0].length);
    targetRange.setValues(mergedValues);

    // نقل وتحديث تنسيقات الأعمدة الأساسية
    sourceRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_COLUMN_WIDTHS, false);

    const logMsg = `✅ تم تحديث ورقة ${PRICEIMG_CONFIG.TARGET_SHEET_NAME} بنجاح لـ ${updatedRowsCount} صنف دون أي انزلاق صفوف أو مسح دائري في: ${currentTimestamp}`;
    Logger.log(logMsg);
    notifyUser(ss, `✅ تم تحديث ${updatedRowsCount} صنف في ${PRICEIMG_CONFIG.TARGET_SHEET_NAME} بنجاح!`);

  } catch (err) {
    Logger.log('❌ خطأ أثناء تنفيذ copyDataimpToPrice: ' + err.toString());
    notifyUser(ss, '❌ فشل التحديث: ' + err.message, true);
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {
      /* تجاهل الخطأ عند فك القفل */
    }
  }
}

/**
 * فحص وتدقيق سلامة البيانات في ورقة priceimg
 */
function auditPriceimgData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(PRICEIMG_CONFIG.TARGET_SHEET_NAME);
  if (!sheet) {
    notifyUser(ss, '❌ الورقة غير موجودة: ' + PRICEIMG_CONFIG.TARGET_SHEET_NAME, true);
    return;
  }

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    notifyUser(ss, '⚠️ الورقة فارغة.', true);
    return;
  }

  const seenCodes = new Set();
  const duplicates = [];
  let missingImages = 0;
  let zeroPrices = 0;
  let missingCodes = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const code = cleanBarcode(row[PRICEIMG_CONFIG.COLUMNS.CODE]);
    const cash = Number(row[PRICEIMG_CONFIG.COLUMNS.CASH_PRICE]) || 0;
    const img = String(row[PRICEIMG_CONFIG.COLUMNS.IMAGE] || '').trim();

    if (!code) {
      missingCodes++;
    } else if (seenCodes.has(code)) {
      duplicates.push(code);
    } else {
      seenCodes.add(code);
    }

    if (!img) missingImages++;
    if (cash <= 0) zeroPrices++;
  }

  const report = [
    `📊 تقرير فحص ورقة ${PRICEIMG_CONFIG.TARGET_SHEET_NAME} (الإصدار v${PRICEIMG_CONFIG.VERSION}):`,
    `• إجمالي الأصناف المفحوصة: ${values.length - 1}`,
    `• أصناف بدون باركود: ${missingCodes}`,
    `• باركودات مكررة: ${duplicates.length}`,
    `• أصناف بدون صور: ${missingImages}`,
    `• أصناف بسعر كاش صفري أو مفقود: ${zeroPrices}`
  ].join('\n');

  Logger.log(report);
  SpreadsheetApp.getUi().alert('تقرير فحص البيانات', report, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * تنظيف الأكواد والمسافات الخفية ومحارف اتجاه النص
 */
function sanitizeBarcodesAndText() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(PRICEIMG_CONFIG.TARGET_SHEET_NAME);
  if (!sheet) return;

  const range = sheet.getDataRange();
  const values = range.getValues();
  let modified = false;

  for (let r = 1; r < values.length; r++) {
    const rawCode = values[r][PRICEIMG_CONFIG.COLUMNS.CODE];
    const clean = cleanBarcode(rawCode);
    if (rawCode !== clean) {
      values[r][PRICEIMG_CONFIG.COLUMNS.CODE] = clean;
      modified = true;
    }
  }

  if (modified) {
    sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
    notifyUser(ss, '✅ تم تنظيف أكواد الباركود بنجاح.');
  } else {
    notifyUser(ss, '✓ جميع الأكواد نظيفة ولا تحتاج لتعديل.');
  }
}

/**
 * تنظيف وتطبيع كود الصنف (الباركود)
 */
function cleanBarcode(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/[\u200E\u200F\u061C\u202A-\u202E\s]/g, '') // إزالة محارف الاتجاه والمسافات
    .trim();
}

/**
 * تحويل روابط مشاركة Google Drive إلى روابط صور مباشرة تعمل داخل المتصفح
 */
function formatDriveImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  const match = trimmed.match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|id=)([a-zA-Z0-9_-]{25,})/);
  if (match && match[1]) {
    return `https://lh3.googleusercontent.com/d/${match[1]}`;
  }
  return trimmed;
}

/**
 * إشعار المستخدم داخل واجهة مصنف جوجل شيتس
 */
function notifyUser(ss, msg, isError) {
  try {
    ss.toast(msg, isError ? 'تنبيه' : 'سنتر عبد الله', 5);
  } catch (e) {
    Logger.log(msg);
  }
}
