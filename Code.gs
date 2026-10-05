// ================================================================
// Code.gs - كتالوج سنتر عبدالله
// الإصدار: 4.3.0
// آخر تحديث: 2026-10-05
// التغييرات:
//   - توحيد عنوان عمود القسط إلى 'سعر البيع قسط'
//   - دعم كامل لهيكل قاعدة البيانات الجديد
// ================================================================

const SERVER_VERSION = '4.3.0';
const SHEET_ID = '1ev1AhcQmnhwYQuU5QV2drdGdiUW6zY6eXz4QabmFOMc';
const SHEET_NAME = 'Menu';
const CACHE_KEY = 'catalog_v43_items';
const CACHE_EXPIRY = 600;
const CACHE_CHUNK_BYTES = 80000;
const MAX_LIMIT = 1000;
const MAX_PAYLOAD_BYTES = 100000;

// العناوين الإلزامية - متوافقة مع الجدول
const REQUIRED_HEADERS = [
  'كود الصنف',
  'اسم الصنف',
  'سعر الكاش',
  'سعر البيع قسط',      // ← العنوان الصحيح
  'الكمية',
  'التوافر'
];

// العناوين الاختيارية
const OPTIONAL_HEADERS = [
  'رابط الصورة'
];

// ================================================================
// [1] استجابات JSON
// ================================================================
function jsonOK(data, total, fromCache, lastUpdate) {
  return ContentService
    .createTextOutput(JSON.stringify({
      success: true,
      version: SERVER_VERSION,
      data: data || [],
      total: total || 0,
      lastUpdate: lastUpdate || '',
      fromCache: !!fromCache,
      timestamp: Date.now()
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message, code) {
  return ContentService
    .createTextOutput(JSON.stringify({
      success: false,
      version: SERVER_VERSION,
      error: String(message || 'خطأ غير معروف'),
      code: code || 'UNKNOWN',
      timestamp: Date.now()
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// [2] أدوات مساعدة
// ================================================================
function s(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

// تحويل آمن لسعر
function toPrice(value) {
  if (value === null || value === undefined || value === '') return 0;

  let str = String(value);

  // تحويل الأرقام العربية-الهندية
  str = str.replace(/[٠-٩]/g, function(d) {
    return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  });

  // إزالة فواصل الآلاف
  str = str.replace(/[٬،,]/g, '');

  // إزالة الرموز العربية الخاصة
  str = str.replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '');

  // إزالة كل ما ليس رقماً أو نقطة أو سالب
  str = str.replace(/[^0-9.\-]/g, '');

  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) return 0;
  return Math.max(0, num);
}

// تحويل آمن لعدد صحيح
function toInt(value) {
  if (value === null || value === undefined || value === '') return 0;

  let str = String(value);
  str = str.replace(/[٠-٩]/g, function(d) {
    return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  });
  str = str.replace(/[\u200E\u200F\u061C\u202A-\u202E٬،,\s]/g, '');
  str = str.replace(/[^\d\-]/g, '');

  const num = parseInt(str, 10);
  if (isNaN(num) || !isFinite(num)) return 0;
  return Math.max(0, num);
}

// تحويل التوافر إلى منطقي
function toAvailable(value) {
  const str = s(value).trim();
  return str === 'متوفر' || str === 'true' || str === 'TRUE' || str === '1';
}

// التحقق من صحة رابط الصورة
function sanitizeImageUrl(value) {
  const str = s(value).trim();
  if (!str) return '';
  if (!/^https?:\/\//i.test(str)) return '';
  if (str.length > 2048) return '';
  return str;
}

// قياس حجم البايتات
function byteLength(str) {
  try {
    return unescape(encodeURIComponent(str)).length;
  } catch (e) {
    return str.length * 2;
  }
}

// ================================================================
// [3] إدارة العناوين والأعمدة
// ================================================================
function findColumnIndex(headers, name) {
  const target = s(name).trim();
  for (let i = 0; i < headers.length; i++) {
    if (s(headers[i]).trim() === target) return i;
  }
  return -1;
}

// كشف عمود التاريخ
function findDateColumnIndex(headers) {
  for (let i = 0; i < headers.length; i++) {
    const h = s(headers[i]).trim();
    if (!h) continue;

    if (/\d{1,2}:\d{2}(:\d{2})?\s*(ص|م|AM|PM)?/i.test(h) &&
        /\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(h)) {
      return i;
    }

    if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(h)) return i;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(h)) return i;
  }
  return -1;
}

function validateHeaders(headers) {
  const map = {};
  const missing = [];

  for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
    const name = REQUIRED_HEADERS[i];
    const idx = findColumnIndex(headers, name);
    if (idx === -1) {
      missing.push(name);
    } else {
      map[name] = idx;
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing: missing, map: null };
  }

  for (let i = 0; i < OPTIONAL_HEADERS.length; i++) {
    const name = OPTIONAL_HEADERS[i];
    const idx = findColumnIndex(headers, name);
    if (idx !== -1) map[name] = idx;
  }

  return { ok: true, missing: [], map: map };
}

// ================================================================
// [4] الكاش
// ================================================================
function cacheClear() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove(CACHE_KEY);
    cache.remove(CACHE_KEY + '_meta');
    for (let i = 0; i < 20; i++) {
      cache.remove(CACHE_KEY + '_c' + i);
    }
  } catch (e) {}
}

function cacheGet() {
  try {
    const cache = CacheService.getScriptCache();

    const direct = cache.get(CACHE_KEY);
    if (direct) {
      const parsed = JSON.parse(direct);
      if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
        return parsed;
      }
    }

    const meta = cache.get(CACHE_KEY + '_meta');
    if (!meta) return null;

    const info = JSON.parse(meta);
    if (!info || typeof info.n !== 'number' || info.n <= 0) return null;

    let combined = '';
    for (let i = 0; i < info.n; i++) {
      const part = cache.get(CACHE_KEY + '_c' + i);
      if (part === null) return null;
      combined += part;
    }

    const parsed = JSON.parse(combined);
    return (parsed && Array.isArray(parsed.items) && parsed.items.length > 0)
      ? parsed
      : null;
  } catch (e) {
    return null;
  }
}

function cacheSet(payload) {
  try {
    if (!payload || !payload.items || payload.items.length === 0) return false;

    cacheClear();

    const json = JSON.stringify(payload);
    const bytes = byteLength(json);

    if (bytes <= CACHE_CHUNK_BYTES) {
      CacheService.getScriptCache().put(CACHE_KEY, json, CACHE_EXPIRY);
      return true;
    }

    const charStep = Math.floor(CACHE_CHUNK_BYTES / 2);
    const chunks = [];
    let cursor = 0;

    while (cursor < json.length) {
      let end = Math.min(cursor + charStep, json.length);
      while (end > cursor && json.charAt(end - 1) === '\\') end--;
      chunks.push(json.substring(cursor, end));
      cursor = end;
    }

    const cache = CacheService.getScriptCache();
    for (let i = 0; i < chunks.length; i++) {
      cache.put(CACHE_KEY + '_c' + i, chunks[i], CACHE_EXPIRY);
    }
    cache.put(CACHE_KEY + '_meta', JSON.stringify({ n: chunks.length }), CACHE_EXPIRY);

    return true;
  } catch (e) {
    return false;
  }
}

// ================================================================
// [5] قراءة البيانات من الشيت
// ================================================================
function readFromSheet() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('الورقة "' + SHEET_NAME + '" غير موجودة في الملف');
  }

  const lastColumn = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  if (lastColumn === 0 || lastRow === 0) {
    return { items: [], lastUpdate: '' };
  }

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const validation = validateHeaders(headers);

  if (!validation.ok) {
    throw new Error(
      'العمود المطلوب غير موجود: ' + validation.missing.join(', ') +
      ' — يرجى التأكد من الصف الأول'
    );
  }

  const dateCol = findDateColumnIndex(headers);
  let lastUpdate = '';
  if (dateCol !== -1) {
    lastUpdate = s(headers[dateCol]).trim();
  }

  if (lastRow <= 1) {
    return { items: [], lastUpdate: lastUpdate };
  }

  const col = validation.map;
  const hasImage = col['رابط الصورة'] !== undefined;

  const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();

  const items = [];
  const seenIds = {};

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    const id = s(row[col['كود الصنف']]).trim();
    if (!id) continue;
    if (seenIds[id]) continue;
    seenIds[id] = true;

    const imageUrl = hasImage
      ? sanitizeImageUrl(row[col['رابط الصورة']])
      : '';

    items.push({
      id: id,
      name: s(row[col['اسم الصنف']]).trim(),
      cashPrice: toPrice(row[col['سعر الكاش']]),
      installPrice: toPrice(row[col['سعر البيع قسط']]),  // ← العنوان الصحيح
      quantity: toInt(row[col['الكمية']]),
      available: toAvailable(row[col['التوافر']]),
      image: imageUrl
    });
  }

  return { items: items, lastUpdate: lastUpdate };
}

function getData() {
  const cached = cacheGet();
  if (cached && cached.items && cached.items.length > 0) {
    return {
      items: cached.items,
      lastUpdate: cached.lastUpdate || '',
      fromCache: true
    };
  }

  const result = readFromSheet();
  cacheSet({ items: result.items, lastUpdate: result.lastUpdate });

  return {
    items: result.items,
    lastUpdate: result.lastUpdate,
    fromCache: false
  };
}

// ================================================================
// [6] نقطة الدخول GET
// ================================================================
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = params.action || 'getMenu';

    if (action === 'getMenu') {
      let limit = parseInt(params.limit, 10);
      if (isNaN(limit) || limit <= 0) limit = MAX_LIMIT;
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;

      let offset = parseInt(params.offset, 10);
      if (isNaN(offset) || offset < 0) offset = 0;

      const result = getData();
      const items = result.items;
      const total = items.length;
      const page = items.slice(offset, offset + limit);

      return jsonOK(page, total, result.fromCache, result.lastUpdate);
    }

    if (action === 'refreshCache') {
      cacheClear();
      const result = readFromSheet();
      cacheSet({ items: result.items, lastUpdate: result.lastUpdate });
      return jsonOK(result.items, result.items.length, false, result.lastUpdate);
    }

    if (action === 'version' || action === 'ping') {
      return ContentService
        .createTextOutput(JSON.stringify({
          success: true,
          version: SERVER_VERSION,
          sheet: SHEET_NAME,
          supportsImages: true,
          supportsLastUpdate: true,
          timestamp: Date.now()
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'diagnose') {
      const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
      if (!sheet) {
        return jsonError('الورقة غير موجودة', 'SHEET_NOT_FOUND');
      }

      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const validation = validateHeaders(headers);
      const dateCol = findDateColumnIndex(headers);
      const imageCol = findColumnIndex(headers, 'رابط الصورة');

      return ContentService
        .createTextOutput(JSON.stringify({
          success: true,
          version: SERVER_VERSION,
          headers: headers.map(function(h) { return s(h); }),
          required: REQUIRED_HEADERS,
          optional: OPTIONAL_HEADERS,
          valid: validation.ok,
          missing: validation.missing,
          hasImageColumn: imageCol !== -1,
          imageColumnIndex: imageCol,
          dateColumnIndex: dateCol,
          dateColumnValue: dateCol !== -1 ? s(headers[dateCol]) : '',
          totalRows: sheet.getLastRow(),
          totalColumns: sheet.getLastColumn()
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return jsonError('إجراء غير صالح: ' + action, 'INVALID_ACTION');

  } catch (err) {
    return jsonError(
      (err && err.message) ? err.message : String(err),
      'GET_ERROR'
    );
  }
}

// ================================================================
// [7] نقطة الدخول POST
// ================================================================
function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return jsonError('السيرفر مشغول، حاول مرة أخرى بعد قليل', 'LOCK_TIMEOUT');
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonError('لا توجد بيانات في الطلب', 'NO_PAYLOAD');
    }

    if (e.postData.contents.length > MAX_PAYLOAD_BYTES) {
      return jsonError('حجم البيانات كبير جداً', 'PAYLOAD_TOO_LARGE');
    }

    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonError('صيغة البيانات غير صحيحة', 'INVALID_JSON');
    }

    const action = data.action;
    let result;

    if (action === 'updateItem') {
      result = handleUpdateItem(data);
    } else if (action === 'addItem') {
      result = handleAddItem(data);
    } else if (action === 'deleteItem') {
      result = handleDeleteItem(data);
    } else {
      return jsonError('إجراء غير صالح: ' + action, 'INVALID_ACTION');
    }

    cacheClear();
    return result;

  } catch (err) {
    return jsonError(
      (err && err.message) ? err.message : String(err),
      'POST_ERROR'
    );
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

// ================================================================
// [8] عمليات الكتابة
// ================================================================
function findRowByCode(sheet, col, code) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;

  const idCol = col['كود الصنف'];
  const ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  const target = s(code).trim();

  for (let i = 0; i < ids.length; i++) {
    if (s(ids[i][0]).trim() === target) return i + 2;
  }
  return -1;
}

function handleUpdateItem(data) {
  if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return jsonError('الورقة غير موجودة', 'SHEET_NOT_FOUND');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const validation = validateHeaders(headers);
  if (!validation.ok) {
    return jsonError('عمود مفقود: ' + validation.missing.join(', '), 'MISSING_HEADER');
  }

  const col = validation.map;
  const rowIndex = findRowByCode(sheet, col, data.id);

  if (rowIndex === -1) {
    return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
  }

  if (data.name !== undefined && data.name !== '') {
    sheet.getRange(rowIndex, col['اسم الصنف'] + 1).setValue(s(data.name).trim());
  }

  if (data.cashPrice !== undefined) {
    const price = parseFloat(data.cashPrice);
    if (isNaN(price) || !isFinite(price) || price < 0) {
      return jsonError('سعر الكاش غير صالح', 'INVALID_PRICE');
    }
    sheet.getRange(rowIndex, col['سعر الكاش'] + 1).setValue(price);
  }

  if (data.installPrice !== undefined) {
    const price = parseFloat(data.installPrice);
    if (isNaN(price) || !isFinite(price) || price < 0) {
      return jsonError('سعر القسط غير صالح', 'INVALID_PRICE');
    }
    sheet.getRange(rowIndex, col['سعر البيع قسط'] + 1).setValue(price);  // ← العنوان الصحيح
  }

  if (data.quantity !== undefined) {
    const qty = parseInt(data.quantity, 10);
    if (isNaN(qty) || qty < 0) {
      return jsonError('الكمية غير صالحة', 'INVALID_QTY');
    }
    sheet.getRange(rowIndex, col['الكمية'] + 1).setValue(qty);
  }

  if (data.available !== undefined) {
    sheet.getRange(rowIndex, col['التوافر'] + 1).setValue(
      data.available ? 'متوفر' : 'غير متوفر'
    );
  }

  if (data.image !== undefined) {
    if (col['رابط الصورة'] === undefined) {
      return jsonError('عمود "رابط الصورة" غير موجود في الجدول', 'NO_IMAGE_COLUMN');
    }
    const imgUrl = sanitizeImageUrl(data.image);
    sheet.getRange(rowIndex, col['رابط الصورة'] + 1).setValue(imgUrl);
  }

  return ContentService
    .createTextOutput(JSON.stringify({
      success: true,
      version: SERVER_VERSION,
      action: 'update',
      id: data.id
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleAddItem(data) {
  if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');
  if (!data.name) return jsonError('اسم الصنف مطلوب', 'MISSING_NAME');

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return jsonError('الورقة غير موجودة', 'SHEET_NOT_FOUND');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const validation = validateHeaders(headers);
  if (!validation.ok) {
    return jsonError('عمود مفقود: ' + validation.missing.join(', '), 'MISSING_HEADER');
  }

  const col = validation.map;

  if (findRowByCode(sheet, col, data.id) !== -1) {
    return jsonError('الكود موجود بالفعل: ' + data.id, 'DUPLICATE');
  }

  const newRow = new Array(headers.length).fill('');
  newRow[col['كود الصنف']] = s(data.id).trim();
  newRow[col['اسم الصنف']] = s(data.name).trim();
  newRow[col['سعر الكاش']] = toPrice(data.cashPrice);
  newRow[col['سعر البيع قسط']] = toPrice(data.installPrice);  // ← العنوان الصحيح
  newRow[col['الكمية']] = toInt(data.quantity);
  newRow[col['التوافر']] = data.available ? 'متوفر' : 'غير متوفر';

  if (col['رابط الصورة'] !== undefined && data.image) {
    newRow[col['رابط الصورة']] = sanitizeImageUrl(data.image);
  }

  sheet.appendRow(newRow);

  return ContentService
    .createTextOutput(JSON.stringify({
      success: true,
      version: SERVER_VERSION,
      action: 'add',
      id: data.id
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleDeleteItem(data) {
  if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return jsonError('الورقة غير موجودة', 'SHEET_NOT_FOUND');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const validation = validateHeaders(headers);
  if (!validation.ok) {
    return jsonError('عمود مفقود: ' + validation.missing.join(', '), 'MISSING_HEADER');
  }

  const col = validation.map;
  const rowIndex = findRowByCode(sheet, col, data.id);

  if (rowIndex === -1) {
    return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
  }

  sheet.deleteRow(rowIndex);

  return ContentService
    .createTextOutput(JSON.stringify({
      success: true,
      version: SERVER_VERSION,
      action: 'delete',
      id: data.id
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// [9] Trigger تلقائي
// ================================================================
function onSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAME) return;
    cacheClear();
    console.log('Sheet edited at row ' + e.range.getRow() + ' - cache cleared');
  } catch (err) {
    console.error('onSheetEdit error:', err);
  }
}

// ================================================================
// [10] إعداد الـ Trigger
// ================================================================
function installTrigger() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'onSheetEdit') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
    ScriptApp.newTrigger('onSheetEdit')
      .forSpreadsheet(SHEET_ID)
      .onEdit()
      .create();
    return 'Trigger installed successfully';
  } catch (err) {
    return 'Trigger install failed: ' + err.message;
  }
}
