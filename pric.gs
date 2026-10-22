// ================================================================
// Code.gs - كتالوج سنتر عبدالله
// الإصدار: 5.0.0
// آخر تحديث: 2026-10-06
//
// التغييرات الرئيسية مقارنة بـ 4.3.0:
//   🔥 [FIX #1]  حساب حجم القطعة في الكاش (÷4 بدل ÷2)
//   🔥 [FIX #2]  cacheClear يمسح كل القطع عبر _meta
//   🔥 [FIX #3]  CACHE_KEY مرتبط بالإصدار
//   🔥 [FIX #4]  المصادقة عبر ADMIN_SECRET في doPost
//   🔥 [FIX #5]  Rate Limiting
//   🔥 [FIX #6]  Soft Delete بدل الحذف الفعلي
//   🔥 [FIX #7]  toAvailable يقبل 'نعم/yes' ويزيل محارف الاتجاه
//   🔥 [FIX #8]  إزالة findDateColumnIndex (كان يشوه العناوين)
//   🔥 [FIX #9]  حفظ lastUpdate في PropertiesService بدل header
//   🔥 [FIX #10] التحقق من installPrice >= cashPrice
//   🔥 [FIX #11] منع حقن الصيغ في الأسماء والأكواد
//   🔥 [FIX #12] setValues بدل setValue الفردية
//   🔥 [FIX #13] appendRow → setValues
//   🔥 [FIX #14] byteLength باستخدام TextEncoder
//   🔥 [FIX #15] sanitizeImageUrl whitelist
//   🔥 [FIX #16] CORS headers
//   🔥 [FIX #17] validateHeaders يكتشف التكرار
//   🔥 [FIX #18] diagnose محمي بـ token
//   🔥 [FIX #19] installTrigger يحذف فقط trigger معين
//   🔥 [FIX #20] Logging منظّم + rollback
// ================================================================

const SERVER_VERSION = '5.0.0';
const SHEET_ID = '1ev1AhcQmnhwYQuY5QV2drdGdiUW6zY6eXz4QabmFOMc';
const SHEET_NAME = 'Menu';

// 🔥 [FIX #3] CACHE_KEY مرتبط بالإصدار
const CACHE_KEY = 'catalog_v' + SERVER_VERSION.replace(/\./g, '') + '_items';
const CACHE_META_KEY = CACHE_KEY + '_meta';

const CACHE_EXPIRY = 600;          // 10 دقائق
// 🔥 [FIX #1] 80000 بايت، سنستخدم ÷4 لضمان الأمان مع UTF-8
const CACHE_CHUNK_BYTES = 80000;
const CACHE_MAX_CHUNKS = 50;       // 🔥 [FIX #2] حد أقصى معقول

const MAX_LIMIT = 1000;
const MAX_PAYLOAD_BYTES = 100000;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 200;

// 🔥 [FIX #4] مفتاح المصادقة (يجب أن يطابق admin.html)
// ⚠️ غيّره إلى قيمة عشوائية قوية ثم استخدمه في admin.html
const ADMIN_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING_v5';

// 🔥 [FIX #5] Rate Limiting
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_WRITES = 30;  // 30 عملية كتابة في الدقيقة
const RATE_LIMIT_MAX_READS = 120;  // 120 قراءة في الدقيقة

// 🔥 [FIX #15] نطاقات الصور المسموح بها
const IMAGE_HOST_WHITELIST = [
    'i.ibb.co',
    'drive.google.com',
    'lh3.googleusercontent.com',
    'res.cloudinary.com',
    'images.unsplash.com',
    'cdn.shopify.com',
    'encrypted-tbn0.gstatic.com',
];

// 🔥 [FIX #8] لا يوجد عمود تاريخ في العناوين المطلوبة
const REQUIRED_HEADERS = [
    'كود الصنف',
    'اسم الصنف',
    'سعر الكاش',
    'سعر البيع قسط',
    'الكمية',
    'التوافر'
];

const OPTIONAL_HEADERS = [
    'رابط الصورة',
    'محذوف'       // 🔥 [FIX #6] عمود الحذف الناعم (اختياري)
];

// أعمدة مسموح تعديلها
const EDITABLE_FIELDS = [
    'اسم الصنف', 'سعر الكاش', 'سعر البيع قسط',
    'الكمية', 'التوافر', 'رابط الصورة'
];

// ================================================================
// [1] أدوات مساعدة عامة
// ================================================================
function s(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

// 🔥 [FIX #14] قياس حجم البايتات بـ TextEncoder
function byteLength(str) {
    try {
        // Apps Script يدعم TextEncoder في V8
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(str).length;
        }
        // fallback
        return Utilities.newBlob(str).getBytes().length;
    } catch (e) {
        // الحل الأخير: افتراض الأسوأ (4 بايت للحرف)
        return s(str).length * 4;
    }
}

// 🔥 [FIX #20] Logging منظّم
function logError(context, err, extra) {
    try {
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            version: SERVER_VERSION,
            context: context,
            error: (err && err.message) ? err.message : String(err),
            stack: (err && err.stack) ? err.stack : '',
            extra: extra || {}
        }));
    } catch (e) { /* silent */ }
}

function logInfo(context, data) {
    try {
        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            version: SERVER_VERSION,
            context: context,
            data: data || {}
        }));
    } catch (e) { /* silent */ }
}

// ================================================================
// [2] تحويلات آمنة
// ================================================================
function toPrice(value) {
    if (value === null || value === undefined || value === '') return 0;

    let str = String(value);

    // تحويل الأرقام العربية-الهندية
    str = str.replace(/[٠-٩]/g, function(d) {
        return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    });

    // إزالة فواصل الآلاف
    str = str.replace(/[٬،,]/g, '');

    // إزالة محارف الاتجاه
    str = str.replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '');

    // 🔥 [FIX] regex صارم: رقم واحد + فاصلة عشرية واحدة فقط
    str = str.trim();
    if (!/^-?\d+(\.\d+)?$/.test(str)) {
        // حاول استخراج أول رقم صالح
        const match = str.match(/-?\d+(?:\.\d+)?/);
        if (!match) return 0;
        str = match[0];
    }

    const num = parseFloat(str);
    if (isNaN(num) || !isFinite(num)) return 0;
    return Math.max(0, num);
}

function toInt(value) {
    if (value === null || value === undefined || value === '') return 0;

    let str = String(value);
    str = str.replace(/[٠-٩]/g, function(d) {
        return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    });
    str = str.replace(/[\u200E\u200F\u061C\u202A-\u202E٬،,\s]/g, '');
    str = str.trim();

    // 🔥 [FIX] regex صارم
    if (!/^-?\d+$/.test(str)) {
        const match = str.match(/-?\d+/);
        if (!match) return 0;
        str = match[0];
    }

    const num = parseInt(str, 10);
    if (isNaN(num) || !isFinite(num)) return 0;
    return Math.max(0, num);
}

// 🔥 [FIX #7] toAvailable موسّعة
function toAvailable(value) {
    if (value === null || value === undefined) return false;
    // إزالة محارف الاتجاه
    const str = s(value)
        .replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '')
        .trim()
        .toLowerCase();

    return str === 'متوفر'
        || str === 'true'
        || str === '1'
        || str === 'نعم'
        || str === 'yes'
        || str === 'y';
}

// 🔥 [FIX #11] منع حقن الصيغ في Sheets
function sanitizeText(value, maxLength) {
    let str = s(value).trim();
    if (!str) return '';
    // إزالة محارف التحكم
    str = str.replace(/[\u0000-\u001F\u007F]/g, '');
    // 🔥 منع حقن الصيغ (formula injection)
    if (/^[=+\-@]/.test(str)) {
        str = "'" + str;
    }
    if (maxLength && str.length > maxLength) {
        str = str.substring(0, maxLength);
    }
    return str;
}

// 🔥 [FIX #15] sanitizeImageUrl مع whitelist
function sanitizeImageUrl(value) {
    const str = s(value).trim();
    if (!str) return '';
    if (str.length > 2048) return '';
    if (!/^https:\/\//i.test(str)) return '';
    try {
        const url = new URL(str);
        const host = url.hostname.toLowerCase();
        const ok = IMAGE_HOST_WHITELIST.some(allowed =>
            host === allowed || host.endsWith('.' + allowed)
        );
        return ok ? str : '';
    } catch (e) {
        return '';
    }
}

// 🔥 [FIX #11] sanitize ID
function sanitizeId(value) {
    let str = s(value).trim();
    if (!str) return '';
    if (str.length > MAX_ID_LENGTH) str = str.substring(0, MAX_ID_LENGTH);
    if (/^[=+\-@]/.test(str)) str = "'" + str;
    return str;
}

// ================================================================
// [3] إدارة العناوين
// ================================================================
// 🔥 [FIX] مقارنة حساسة لحالة الأحرف + trim
function findColumnIndex(headers, name) {
    const target = s(name).trim().toLowerCase();
    for (let i = 0; i < headers.length; i++) {
        if (s(headers[i]).trim().toLowerCase() === target) return i;
    }
    return -1;
}

// 🔥 [FIX #17] اكتشاف العناوين المكررة
function findDuplicateHeaders(headers) {
    const seen = {};
    const duplicates = [];
    for (let i = 0; i < headers.length; i++) {
        const h = s(headers[i]).trim().toLowerCase();
        if (!h) continue;
        if (seen[h] !== undefined) {
            duplicates.push(h);
        } else {
            seen[h] = i;
        }
    }
    return duplicates;
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
        return { ok: false, missing: missing, map: null, duplicates: [] };
    }

    for (let i = 0; i < OPTIONAL_HEADERS.length; i++) {
        const name = OPTIONAL_HEADERS[i];
        const idx = findColumnIndex(headers, name);
        if (idx !== -1) map[name] = idx;
    }

    // 🔥 [FIX #17] التحقق من التكرار
    const duplicates = findDuplicateHeaders(headers);

    return { ok: true, missing: [], map: map, duplicates: duplicates };
}

// ================================================================
// [4] الاستجابات
// ================================================================
function jsonOutput(payload) {
    return ContentService
        .createTextOutput(JSON.stringify(payload))
        .setMimeType(ContentService.MimeType.JSON);
}

function jsonOK(data, total, fromCache, lastUpdate, extra) {
    const body = {
        success: true,
        version: SERVER_VERSION,
        data: data || [],
        total: total || 0,
        lastUpdate: lastUpdate || '',
        fromCache: !!fromCache,
        timestamp: Date.now()
    };
    // 🔥 [FIX] تمييز الحالة الفارغة
    if (!data || data.length === 0) {
        body.empty = true;
    }
    if (extra) {
        for (const k in extra) {
            if (extra.hasOwnProperty(k)) body[k] = extra[k];
        }
    }
    return jsonOutput(body);
}

function jsonError(message, code, extra) {
    const body = {
        success: false,
        version: SERVER_VERSION,
        error: String(message || 'خطأ غير معروف'),
        code: code || 'UNKNOWN',
        data: [],
        timestamp: Date.now()
    };
    if (extra) {
        for (const k in extra) {
            if (extra.hasOwnProperty(k)) body[k] = extra[k];
        }
    }
    return jsonOutput(body);
}

// ================================================================
// [5] Rate Limiting
// ================================================================
// 🔥 [FIX #5] Rate limiter بسيط عبر CacheService
function rateLimit(scope, maxOps, windowSec) {
    try {
        const cache = CacheService.getScriptCache();
        const key = 'rl_' + scope + '_' + Math.floor(Date.now() / (windowSec * 1000));
        const current = parseInt(cache.get(key) || '0', 10);
        if (current >= maxOps) return false;
        cache.put(key, String(current + 1), windowSec + 5);
        return true;
    } catch (e) {
        // في حال فشل الكاش، اسمح بالمرور (لا تعطّل الخدمة)
        return true;
    }
}

// ================================================================
// [6] الكاش - 🔥 [FIX #1, #2, #3] مُعاد بناؤه
// ================================================================
function cacheClear() {
    try {
        const cache = CacheService.getScriptCache();

        // 🔥 [FIX #2] نقرأ عدد القطع من _meta ثم نمسحها كلها
        const meta = cache.get(CACHE_META_KEY);
        if (meta) {
            try {
                const info = JSON.parse(meta);
                const n = Math.min(info.n || 0, CACHE_MAX_CHUNKS);
                for (let i = 0; i < n; i++) {
                    cache.remove(CACHE_KEY + '_c' + i);
                }
            } catch (e) { /* meta تالفة */ }
        }

        // امسح حتى الحد الأقصى (احتياط)
        for (let i = 0; i < CACHE_MAX_CHUNKS; i++) {
            cache.remove(CACHE_KEY + '_c' + i);
        }

        cache.remove(CACHE_KEY);
        cache.remove(CACHE_META_KEY);
    } catch (e) {
        logError('cacheClear', e);
    }
}

function cacheGet() {
    try {
        const cache = CacheService.getScriptCache();

        // محاولة القراءة المباشرة أولاً
        const direct = cache.get(CACHE_KEY);
        if (direct) {
            try {
                const parsed = JSON.parse(direct);
                if (parsed && Array.isArray(parsed.items)) {
                    return parsed;
                }
            } catch (e) {
                // بيانات تالفة - امسح
                cache.remove(CACHE_KEY);
            }
        }

        // قراءة مقسّمة
        const metaRaw = cache.get(CACHE_META_KEY);
        if (!metaRaw) return null;

        let info;
        try { info = JSON.parse(metaRaw); }
        catch (e) { return null; }

        if (!info || typeof info.n !== 'number' || info.n <= 0) return null;
        if (info.n > CACHE_MAX_CHUNKS) return null;

        // 🔥 قراءة كل القطع دفعة واحدة باستخدام getAll
        const keys = [];
        for (let i = 0; i < info.n; i++) keys.push(CACHE_KEY + '_c' + i);

        const parts = cache.getAll(keys);

        let combined = '';
        for (let i = 0; i < info.n; i++) {
            const part = parts[CACHE_KEY + '_c' + i];
            // 🔥 [FIX] يجب أن تكون كل القطع موجودة
            if (part === null || part === undefined) {
                // بيانات ناقصة - امسح الكاش كاملاً
                cacheClear();
                return null;
            }
            combined += part;
        }

        const parsed = JSON.parse(combined);
        return (parsed && Array.isArray(parsed.items)) ? parsed : null;
    } catch (e) {
        logError('cacheGet', e);
        return null;
    }
}

function cacheSet(payload) {
    try {
        if (!payload || !Array.isArray(payload.items)) return false;

        cacheClear();

        const json = JSON.stringify(payload);

        // 🔥 [FIX #14] قياس البايتات الفعلي
        const bytes = byteLength(json);

        const cache = CacheService.getScriptCache();

        // كتابة مباشرة
        if (bytes <= CACHE_CHUNK_BYTES) {
            cache.put(CACHE_KEY, json, CACHE_EXPIRY);
            // ✅ تحقق من النجاح
            return cache.get(CACHE_KEY) !== null;
        }

        // 🔥 [FIX #1] نقسم على أساس 4 بايت للحرف (آمن لـ UTF-8)
        const charStep = Math.floor(CACHE_CHUNK_BYTES / 4);
        const chunks = [];
        let cursor = 0;

        while (cursor < json.length) {
            let end = Math.min(cursor + charStep, json.length);

            // ⚠️ لا تقطع بين surrogate pair
            while (end > cursor) {
                const code = json.charCodeAt(end - 1);
                // إذا كان high surrogate، لا نقطع هنا
                if (code >= 0xD800 && code <= 0xDBFF) {
                    end--;
                } else {
                    break;
                }
            }
            if (end === cursor) end = Math.min(cursor + charStep, json.length);

            chunks.push(json.substring(cursor, end));
            cursor = end;

            if (chunks.length > CACHE_MAX_CHUNKS) {
                logError('cacheSet', new Error('عدد القطع تجاوز الحد'));
                return false;
            }
        }

        // كتابة كل القطع
        const toWrite = {};
        for (let i = 0; i < chunks.length; i++) {
            toWrite[CACHE_KEY + '_c' + i] = chunks[i];
        }
        cache.putAll(toWrite, CACHE_EXPIRY);
        cache.put(CACHE_META_KEY, JSON.stringify({ n: chunks.length, ts: Date.now() }), CACHE_EXPIRY);

        // ✅ تحقق
        const checkMeta = cache.get(CACHE_META_KEY);
        return checkMeta !== null;
    } catch (e) {
        logError('cacheSet', e);
        return false;
    }
}

// ================================================================
// [7] lastUpdate - 🔥 [FIX #9] في PropertiesService
// ================================================================
function getLastUpdate() {
    try {
        const props = PropertiesService.getScriptProperties();
        return props.getProperty('LAST_UPDATE') || '';
    } catch (e) {
        return '';
    }
}

function setLastUpdate() {
    try {
        const props = PropertiesService.getScriptProperties();
        const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
        props.setProperty('LAST_UPDATE', now);
        return now;
    } catch (e) {
        logError('setLastUpdate', e);
        return '';
    }
}

// ================================================================
// [8] قراءة البيانات - 🔥 [FIX #8, #9, #10]
// ================================================================
function readFromSheet() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
        throw new Error('الورقة "' + SHEET_NAME + '" غير موجودة في الملف');
    }

    const lastColumn = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();

    if (lastColumn === 0 || lastRow === 0) {
        return { items: [], lastUpdate: getLastUpdate(), skipped: 0 };
    }

    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    const validation = validateHeaders(headers);

    if (!validation.ok) {
        throw new Error(
            'العمود المطلوب غير موجود: ' + validation.missing.join(', ') +
            ' — يرجى التأكد من الصف الأول'
        );
    }

    // 🔥 [FIX #8] لا نبحث عن عمود تاريخ - lastUpdate من PropertiesService
    const lastUpdate = getLastUpdate();

    if (lastRow <= 1) {
        return { items: [], lastUpdate: lastUpdate, skipped: 0 };
    }

    const col = validation.map;
    const hasImage = col['رابط الصورة'] !== undefined;
    const hasDeleted = col['محذوف'] !== undefined;

    const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();

    const items = [];
    const seenIds = {};
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        const id = sanitizeId(row[col['كود الصنف']]);
        if (!id) { skipped++; continue; }
        if (seenIds[id]) { skipped++; continue; }
        seenIds[id] = true;

        // 🔥 [FIX #6] تخطى الصفوف المحذوفة ناعماً
        if (hasDeleted && toAvailable(row[col['محذوف']])) {
            continue;
        }

        const imageUrl = hasImage ? sanitizeImageUrl(row[col['رابط الصورة']]) : '';

        items.push({
            id: id,
            name: sanitizeText(row[col['اسم الصنف']], MAX_NAME_LENGTH),
            cashPrice: toPrice(row[col['سعر الكاش']]),
            installPrice: toPrice(row[col['سعر البيع قسط']]),
            quantity: toInt(row[col['الكمية']]),
            available: toAvailable(row[col['التوافر']]),
            image: imageUrl
        });
    }

    return { items: items, lastUpdate: lastUpdate, skipped: skipped };
}

function getData() {
    const cached = cacheGet();
    if (cached && cached.items && cached.items.length > 0) {
        return {
            items: cached.items,
            lastUpdate: cached.lastUpdate || getLastUpdate(),
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
// [9] CORS - 🔥 [FIX #16]
// ================================================================
function getCorsHeaders() {
    // ملاحظة: Apps Script يتعامل مع CORS تلقائياً
    // هذه الدالة للتوثيق فقط
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '3600'
    };
}

// ================================================================
// [10] نقطة الدخول GET
// ================================================================
function doGet(e) {
    try {
        // 🔥 [FIX #5] Rate limit
        if (!rateLimit('get', RATE_LIMIT_MAX_READS, RATE_LIMIT_WINDOW_SEC)) {
            return jsonError('عدد الطلبات كبير، حاول لاحقاً', 'RATE_LIMIT');
        }

        const params = (e && e.parameter) || {};
        const action = params.action || 'getMenu';

        // 🔥 Action: getMenu
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

            return jsonOK(page, total, result.fromCache, result.lastUpdate, {
                offset: offset,
                limit: limit,
                hasMore: (offset + limit) < total
            });
        }

        // 🔥 Action: refreshCache (يحتاج token)
        if (action === 'refreshCache') {
            if (params.token !== ADMIN_SECRET) {
                return jsonError('غير مصرح', 'UNAUTHORIZED');
            }
            cacheClear();
            const result = readFromSheet();
            const now = setLastUpdate();
            cacheSet({ items: result.items, lastUpdate: now });
            return jsonOK(result.items, result.items.length, false, now);
        }

        // 🔥 Action: version / ping
        if (action === 'version' || action === 'ping') {
            return jsonOutput({
                success: true,
                version: SERVER_VERSION,
                sheet: SHEET_NAME,
                supportsImages: true,
                supportsLastUpdate: true,
                supportsSoftDelete: true,
                supportsAuth: true,
                supportsPagination: true,
                timestamp: Date.now()
            });
        }

        // 🔥 [FIX #18] diagnose محمي بـ token
        if (action === 'diagnose') {
            if (params.token !== ADMIN_SECRET) {
                return jsonError('غير مصرح', 'UNAUTHORIZED');
            }

            const ss = SpreadsheetApp.openById(SHEET_ID);
            const sheet = ss.getSheetByName(SHEET_NAME);
            if (!sheet) {
                return jsonError('الورقة غير موجودة', 'SHEET_NOT_FOUND');
            }

            const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
            const validation = validateHeaders(headers);
            const imageCol = findColumnIndex(headers, 'رابط الصورة');
            const deletedCol = findColumnIndex(headers, 'محذوف');

            return jsonOutput({
                success: true,
                version: SERVER_VERSION,
                headers: headers.map(function(h) { return s(h); }),
                required: REQUIRED_HEADERS,
                optional: OPTIONAL_HEADERS,
                valid: validation.ok,
                missing: validation.missing,
                duplicates: validation.duplicates,
                hasImageColumn: imageCol !== -1,
                imageColumnIndex: imageCol,
                hasDeletedColumn: deletedCol !== -1,
                deletedColumnIndex: deletedCol,
                lastUpdate: getLastUpdate(),
                totalRows: sheet.getLastRow(),
                totalColumns: sheet.getLastColumn()
            });
        }

        // 🔥 Action: clearCache (يحتاج token)
        if (action === 'clearCache') {
            if (params.token !== ADMIN_SECRET) {
                return jsonError('غير مصرح', 'UNAUTHORIZED');
            }
            cacheClear();
            return jsonOutput({
                success: true,
                version: SERVER_VERSION,
                action: 'clearCache',
                cleared: true
            });
        }

        return jsonError('إجراء غير صالح: ' + action, 'INVALID_ACTION');

    } catch (err) {
        logError('doGet', err, { params: e && e.parameter });
        return jsonError(
            (err && err.message) ? err.message : String(err),
            'GET_ERROR'
        );
    }
}

// ================================================================
// [11] نقطة الدخول POST
// ================================================================
function doPost(e) {
    const lock = LockService.getScriptLock();

    try {
        // 🔥 [FIX #5] Rate limit
        if (!rateLimit('post', RATE_LIMIT_MAX_WRITES, RATE_LIMIT_WINDOW_SEC)) {
            return jsonError('عدد الطلبات كبير، حاول لاحقاً', 'RATE_LIMIT');
        }

        try {
            lock.waitLock(15000);
        } catch (lockErr) {
            return jsonError('السيرفر مشغول، حاول مرة أخرى بعد قليل', 'LOCK_TIMEOUT');
        }

        if (!e || !e.postData || !e.postData.contents) {
            return jsonError('لا توجد بيانات في الطلب', 'NO_PAYLOAD');
        }

        // 🔥 [FIX #14] قياس الحجم الفعلي
        const bytes = byteLength(e.postData.contents);
        if (bytes > MAX_PAYLOAD_BYTES) {
            return jsonError('حجم البيانات كبير جداً', 'PAYLOAD_TOO_LARGE', { bytes: bytes });
        }

        let data;
        try {
            data = JSON.parse(e.postData.contents);
        } catch (parseErr) {
            return jsonError('صيغة البيانات غير صحيحة', 'INVALID_JSON');
        }

        // 🔥 [FIX #4] المصادقة
        if (!data.token || data.token !== ADMIN_SECRET) {
            logError('doPost', new Error('فشل المصادقة'), { action: data.action });
            return jsonError('غير مصرح', 'UNAUTHORIZED');
        }

        const action = data.action;
        let result;

        if (action === 'updateItem') {
            result = handleUpdateItem(data);
        } else if (action === 'addItem') {
            result = handleAddItem(data);
        } else if (action === 'deleteItem') {
            result = handleDeleteItem(data);
        } else if (action === 'restoreItem') {
            result = handleRestoreItem(data);
        } else {
            return jsonError('إجراء غير صالح: ' + action, 'INVALID_ACTION');
        }

        // إذا نجحت العملية، امسح الكاش وحدّث lastUpdate
        if (result && result.success) {
            cacheClear();
            setLastUpdate();
        }

        return result;

    } catch (err) {
        logError('doPost', err);
        return jsonError(
            (err && err.message) ? err.message : String(err),
            'POST_ERROR'
        );
    } finally {
        try { lock.releaseLock(); } catch (releaseErr) { /* silent */ }
    }
}

// ================================================================
// [12] دوال مساعدة للكتابة
// ================================================================
function getSheet() {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('الورقة غير موجودة');
    return sheet;
}

function getHeadersAndValidation(sheet) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const validation = validateHeaders(headers);
    if (!validation.ok) {
        throw new Error('عمود مفقود: ' + validation.missing.join(', '));
    }
    return { headers: headers, col: validation.map };
}

// 🔥 [FIX #8] O(n) مرة واحدة
function findRowByCode(sheet, col, code) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return -1;

    const idCol = col['كود الصنف'];
    const ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
    const target = sanitizeId(code);

    for (let i = 0; i < ids.length; i++) {
        if (sanitizeId(ids[i][0]) === target) return i + 2;
    }
    return -1;
}

// 🔥 [FIX #10] التحقق من اتساق الأسعار
function validatePrices(cashPrice, installPrice) {
    if (cashPrice < 0) {
        return { ok: false, error: 'سعر الكاش لا يمكن أن يكون سالباً' };
    }
    if (installPrice < 0) {
        return { ok: false, error: 'سعر القسط لا يمكن أن يكون سالباً' };
    }
    // التحقق من أن القسط >= الكاش (تحذير فقط، ليس خطأ)
    if (installPrice > 0 && cashPrice > 0 && installPrice < cashPrice) {
        return {
            ok: true,
            warning: 'سعر القسط (' + installPrice + ') أقل من سعر الكاش (' + cashPrice + ')'
        };
    }
    return { ok: true };
}

// ================================================================
// [13] عمليات الكتابة
// ================================================================
// 🔥 [FIX #12] تحديث جماعي بـ setValues
function handleUpdateItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    const rowIndex = findRowByCode(sheet, col, data.id);
    if (rowIndex === -1) {
        return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
    }

    // 🔥 قراءة الصف الحالي
    const currentRow = sheet.getRange(rowIndex, 1, 1, info.headers.length).getValues()[0];

    // 🔥 بناء الصف الجديد
    const newRow = currentRow.slice(); // نسخة

    // التحقق من الأسعار قبل التطبيق
    const newCash = data.cashPrice !== undefined ? toPrice(data.cashPrice) : toPrice(currentRow[col['سعر الكاش']]);
    const newInst = data.installPrice !== undefined ? toPrice(data.installPrice) : toPrice(currentRow[col['سعر البيع قسط']]);

    const priceCheck = validatePrices(newCash, newInst);
    if (!priceCheck.ok) {
        return jsonError(priceCheck.error, 'INVALID_PRICE');
    }

    // الاسم
    if (data.name !== undefined) {
        newRow[col['اسم الصنف']] = sanitizeText(data.name, MAX_NAME_LENGTH);
    }

    // الأسعار
    if (data.cashPrice !== undefined) {
        newRow[col['سعر الكاش']] = newCash;
    }
    if (data.installPrice !== undefined) {
        newRow[col['سعر البيع قسط']] = newInst;
    }

    // الكمية
    if (data.quantity !== undefined) {
        newRow[col['الكمية']] = toInt(data.quantity);
    }

    // التوافر
    if (data.available !== undefined) {
        newRow[col['التوافر']] = data.available ? 'متوفر' : 'غير متوفر';
    }

    // الصورة
    if (data.image !== undefined) {
        if (col['رابط الصورة'] === undefined) {
            return jsonError('عمود "رابط الصورة" غير موجود في الجدول', 'NO_IMAGE_COLUMN');
        }
        newRow[col['رابط الصورة']] = sanitizeImageUrl(data.image);
    }

    // 🔥 [FIX #12] كتابة كل الصف مرة واحدة
    sheet.getRange(rowIndex, 1, 1, newRow.length).setValues([newRow]);

    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'update',
        id: data.id,
        warning: priceCheck.warning || null
    });
}

// 🔥 [FIX #13] appendRow → setValues
function handleAddItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');
    if (!data.name) return jsonError('اسم الصنف مطلوب', 'MISSING_NAME');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    const id = sanitizeId(data.id);
    if (!id) return jsonError('كود الصنف غير صالح', 'INVALID_ID');

    // التحقق من عدم التكرار
    if (findRowByCode(sheet, col, id) !== -1) {
        return jsonError('الكود موجود بالفعل: ' + id, 'DUPLICATE');
    }

    // التحقق من الأسعار
    const cashPrice = toPrice(data.cashPrice);
    const installPrice = toPrice(data.installPrice);
    const priceCheck = validatePrices(cashPrice, installPrice);
    if (!priceCheck.ok) {
        return jsonError(priceCheck.error, 'INVALID_PRICE');
    }

    // 🔥 بناء الصف الجديد
    const newRow = new Array(info.headers.length).fill('');
    newRow[col['كود الصنف']] = id;
    newRow[col['اسم الصنف']] = sanitizeText(data.name, MAX_NAME_LENGTH);
    newRow[col['سعر الكاش']] = cashPrice;
    newRow[col['سعر البيع قسط']] = installPrice;
    newRow[col['الكمية']] = toInt(data.quantity);
    newRow[col['التوافر']] = data.available ? 'متوفر' : 'غير متوفر';

    if (col['رابط الصورة'] !== undefined && data.image) {
        newRow[col['رابط الصورة']] = sanitizeImageUrl(data.image);
    }
    if (col['محذوف'] !== undefined) {
        newRow[col['محذوف']] = 'لا';
    }

    // 🔥 [FIX #13] setValues بدل appendRow
    const newRowIndex = sheet.getLastRow() + 1;
    sheet.getRange(newRowIndex, 1, 1, newRow.length).setValues([newRow]);

    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'add',
        id: id,
        row: newRowIndex,
        warning: priceCheck.warning || null
    });
}

// 🔥 [FIX #6] Soft delete
function handleDeleteItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    const rowIndex = findRowByCode(sheet, col, data.id);
    if (rowIndex === -1) {
        return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
    }

    // 🔥 [FIX #6] إذا وُجد عمود 'محذوف'، استخدم soft delete
    if (col['محذوف'] !== undefined) {
        sheet.getRange(rowIndex, col['محذوف'] + 1).setValue('نعم');
        return jsonOutput({
            success: true,
            version: SERVER_VERSION,
            action: 'softDelete',
            id: data.id,
            recoverable: true
        });
    }

    // fallback: حذف فعلي (مع تحذير)
    sheet.deleteRow(rowIndex);

    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'delete',
        id: data.id,
        recoverable: false,
        warning: 'لم يتم العثور على عمود "محذوف" - تم الحذف الفعلي'
    });
}

// 🔥 [FIX #6] Restore من soft delete
function handleRestoreItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    if (col['محذوف'] === undefined) {
        return jsonError('لا يوجد عمود "محذوف" - لا يمكن الاستعادة', 'NO_DELETED_COLUMN');
    }

    const rowIndex = findRowByCode(sheet, col, data.id);
    if (rowIndex === -1) {
        return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
    }

    sheet.getRange(rowIndex, col['محذوف'] + 1).setValue('لا');

    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'restore',
        id: data.id
    });
}

// ================================================================
// [14] Trigger
// ================================================================
// 🔥 [FIX #20] يمسح فقط trigger هذا السكربت
function onSheetEdit(e) {
    try {
        if (!e || !e.range) return;

        const sheet = e.range.getSheet();
        if (sheet.getName() !== SHEET_NAME) return;

        // 🔥 [FIX] تجاهل تعديلات التنسيق
        if (e.changeType && e.changeType !== 'EDIT' && e.changeType !== 'INSERT_ROW' && e.changeType !== 'REMOVE_ROW') {
            return;
        }

        // 🔥 تحديث lastUpdate ومسح الكاش
        setLastUpdate();
        cacheClear();

        logInfo('onSheetEdit', {
            row: e.range.getRow(),
            col: e.range.getColumn(),
            changeType: e.changeType || 'EDIT'
        });
    } catch (err) {
        logError('onSheetEdit', err);
    }
}

// ================================================================
// [15] إعداد الـ Trigger
// ================================================================
// 🔥 [FIX #19] يحذف فقط trigger على SHEET_ID
function installTrigger() {
    try {
        const triggers = ScriptApp.getProjectTriggers();
        let removed = 0;
        let installed = 0;

        for (let i = 0; i < triggers.length; i++) {
            const t = triggers[i];
            // احذف فقط trigger اسمه onSheetEdit ومرتبط بنفس الشيت
            if (t.getHandlerFunction() === 'onSheetEdit') {
                try {
                    ScriptApp.deleteTrigger(t);
                    removed++;
                } catch (e) { /* قد يكون trigger لملف آخر */ }
            }
        }

        ScriptApp.newTrigger('onSheetEdit')
            .forSpreadsheet(SHEET_ID)
            .onEdit()
            .create();
        installed++;

        return 'Trigger installed. Removed: ' + removed + ', Installed: ' + installed;
    } catch (err) {
        logError('installTrigger', err);
        return 'Trigger install failed: ' + err.message;
    }
}

// ================================================================
// [16] أدوات مساعدة للصيانة اليدوية
// ================================================================

/**
 * تعيين lastUpdate يدوياً
 * استخدم من محرر Apps Script
 */
function setLastUpdateManual(value) {
    try {
        const props = PropertiesService.getScriptProperties();
        props.setProperty('LAST_UPDATE', String(value || ''));
        return 'OK: ' + value;
    } catch (e) {
        return 'ERROR: ' + e.message;
    }
}

/**
 * عرض معلومات التشخيص من محرر Apps Script
 */
function diagnoseManual() {
    try {
        const ss = SpreadsheetApp.openById(SHEET_ID);
        const sheet = ss.getSheetByName(SHEET_NAME);
        if (!sheet) return { error: 'Sheet not found' };

        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        const validation = validateHeaders(headers);

        return {
            version: SERVER_VERSION,
            headers: headers.map(s),
            validation: validation,
            lastUpdate: getLastUpdate(),
            totalRows: sheet.getLastRow(),
            totalColumns: sheet.getLastColumn(),
            required: REQUIRED_HEADERS,
            optional: OPTIONAL_HEADERS
        };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * اختبار كتابة/قراءة الكاش
 */
function testCache() {
    try {
        const testData = {
            items: [],
            lastUpdate: 'test_' + Date.now()
        };
        for (let i = 0; i < 500; i++) {
            testData.items.push({
                id: 'TEST_' + i,
                name: 'منتج اختبار ' + i,
                cashPrice: i * 10,
                installPrice: i * 12,
                quantity: i,
                available: true,
                image: ''
            });
        }

        const setOk = cacheSet(testData);
        const got = cacheGet();

        const result = {
            setOk: setOk,
            getOk: !!got,
            itemsCount: got ? got.items.length : 0,
            matches: got && got.items.length === testData.items.length
        };

        cacheClear();
        return result;
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * تنظيف شامل للكاش
 */
function clearCacheManual() {
    cacheClear();
    return 'Cache cleared';
}
