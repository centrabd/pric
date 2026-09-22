// ================================================================
// Code.gs - الإصدار النهائي مع Pagination الكامل
// ================================================================

const SHEET_ID = '1ev1AhcQmnhwYQuU5QV2drdGdiUW6zY6eXz4QabmFOMc';
const SHEET_NAME = 'Menu';

// العناوين المطلوبة (يجب أن تطابق ما هو موجود في الصف الأول بالضبط)
const REQUIRED_HEADERS = ['كود الصنف', 'اسم الصنف', 'سعر الكاش', 'سعر البيع قسط شهري', 'الكمية', 'التوافر'];

// ---------- دوال مساعدة ----------
function buildErrorResponse(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

function buildSuccessResponse(data, total) {
  return ContentService
    .createTextOutput(JSON.stringify({ data: data, total: total }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getColumnIndex(headers, name) {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].trim() === name) return i;
  }
  return -1;
}

function cleanPrice(value) {
  if (value === undefined || value === null) return 0;
  let str = String(value);
  let cleaned = str.replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

function validateAndGetColumns(headers) {
  const result = {};
  for (let h of REQUIRED_HEADERS) {
    const idx = getColumnIndex(headers, h);
    if (idx === -1) {
      return { valid: false, missing: h };
    }
    result[h] = idx;
  }
  return { valid: true, columns: result };
}

// ---------- نقطة الدخول (GET) ----------
function doGet(e) {
  try {
    const action = e.parameter.action || 'getMenu';
    if (action === 'getMenu') {
      const offset = parseInt(e.parameter.offset) || 0;
      const limit = parseInt(e.parameter.limit) || 20; // الحد الافتراضي 20
      const search = e.parameter.search || '';
      const sort = e.parameter.sort || 'name';
      const order = e.parameter.order || 'asc';
      return handleGetMenu(offset, limit, search, sort, order);
    }
    return buildErrorResponse('إجراء غير صالح');
  } catch (err) {
    return buildErrorResponse('خطأ في السيرفر: ' + err.toString());
  }
}

// ---------- نقطة الدخول (POST) ----------
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'updateItem') {
      return handleUpdateItem(data);
    } else if (action === 'addItem') {
      return handleAddItem(data);
    } else if (action === 'deleteItem') {
      return handleDeleteItem(data);
    }
    return buildErrorResponse('إجراء غير صالح');
  } catch (err) {
    return buildErrorResponse(err.toString());
  } finally {
    lock.releaseLock();
  }
}

// ---------- دالة جلب البيانات (مع Pagination حقيقي) ----------
function handleGetMenu(offset, limit, search, sort, order) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) {
    return buildErrorResponse('الورقة "' + SHEET_NAME + '" غير موجودة');
  }

  // 1. قراءة صف العناوين (فقط للقراءة، لا تعديل)
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  // 2. التحقق من وجود جميع العناوين المطلوبة
  const validation = validateAndGetColumns(headers);
  if (!validation.valid) {
    return buildErrorResponse(
      '⚠️ العمود المطلوب "' + validation.missing + '" غير موجود.\n' +
      'تأكد من أن الصف الأول يحتوي على: ' + REQUIRED_HEADERS.join(' - ')
    );
  }
  const col = validation.columns;

  // 3. قراءة البيانات
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return buildSuccessResponse([], 0);
  }

  const dataRange = sheet.getRange(2, 1, lastRow - 1, headers.length);
  const rows = dataRange.getValues();

  let items = rows.map(row => ({
    id: String(row[col['كود الصنف']] || ''),
    name: String(row[col['اسم الصنف']] || ''),
    cashPrice: cleanPrice(row[col['سعر الكاش']]),
    installPrice: cleanPrice(row[col['سعر البيع قسط شهري']]),
    quantity: parseInt(row[col['الكمية']]) || 0,
    available: (String(row[col['التوافر']]).trim() === 'متوفر')
  }));

  // 4. بحث
  if (search.trim() !== '') {
    const keyword = search.trim().toLowerCase();
    items = items.filter(item => item.name.toLowerCase().includes(keyword));
  }

  // 5. ترتيب
  items.sort((a, b) => {
    let valA = a[sort] ?? '';
    let valB = b[sort] ?? '';
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
    if (valA < valB) return order === 'asc' ? -1 : 1;
    if (valA > valB) return order === 'asc' ? 1 : -1;
    return 0;
  });

  // 6. حساب العدد الكلي بعد الفلترة والترتيب
  const total = items.length;

  // 7. Pagination (تقطيع)
  const paginatedItems = items.slice(offset, offset + limit);

  return buildSuccessResponse(paginatedItems, total);
}

// ---------- دالة تحديث المنتج ----------
function handleUpdateItem(data) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return buildErrorResponse('الورقة غير موجودة');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const validation = validateAndGetColumns(headers);
  if (!validation.valid) {
    return buildErrorResponse('العمود "' + validation.missing + '" غير موجود، لا يمكن التحديث.');
  }
  const col = validation.columns;

  const rows = sheet.getDataRange().getValues();
  let foundRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][col['كود الصنف']]) === String(data.id)) {
      foundRow = i + 1;
      break;
    }
  }
  if (foundRow === -1) return buildErrorResponse('المنتج غير موجود');

  if (data.cashPrice !== undefined)
    sheet.getRange(foundRow, col['سعر الكاش'] + 1).setValue(data.cashPrice);
  if (data.installPrice !== undefined)
    sheet.getRange(foundRow, col['سعر البيع قسط شهري'] + 1).setValue(data.installPrice);
  if (data.quantity !== undefined)
    sheet.getRange(foundRow, col['الكمية'] + 1).setValue(data.quantity);
  if (data.available !== undefined)
    sheet.getRange(foundRow, col['التوافر'] + 1).setValue(data.available ? 'متوفر' : 'غير متوفر');

  return ContentService
    .createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- دالة إضافة منتج جديد ----------
function handleAddItem(data) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return buildErrorResponse('الورقة غير موجودة');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const validation = validateAndGetColumns(headers);
  if (!validation.valid) {
    return buildErrorResponse('العمود "' + validation.missing + '" غير موجود، لا يمكن الإضافة.');
  }
  const col = validation.columns;

  // التحقق من عدم وجود الكود مكرر
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][col['كود الصنف']]) === String(data.id)) {
      return buildErrorResponse('الكود موجود بالفعل');
    }
  }

  // إضافة صف جديد
  const newRow = [
    data.id,
    data.name,
    data.cashPrice || 0,
    data.installPrice || 0,
    data.quantity || 0,
    data.available ? 'متوفر' : 'غير متوفر'
  ];
  sheet.appendRow(newRow);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true, id: data.id }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- دالة حذف منتج ----------
function handleDeleteItem(data) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return buildErrorResponse('الورقة غير موجودة');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const validation = validateAndGetColumns(headers);
  if (!validation.valid) {
    return buildErrorResponse('العمود "' + validation.missing + '" غير موجود، لا يمكن الحذف.');
  }
  const col = validation.columns;

  const rows = sheet.getDataRange().getValues();
  let foundRow = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][col['كود الصنف']]) === String(data.id)) {
      foundRow = i + 1;
      break;
    }
  }
  if (foundRow === -1) return buildErrorResponse('المنتج غير موجود');

  // حذف الصف
  sheet.deleteRow(foundRow);

  return ContentService
    .createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
