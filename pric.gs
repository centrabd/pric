// ================================================================
// Code.gs - كتالوج سنتر عبد الله السويس
// الإصدار: 5.2.0 (إصدار الإنتاج المستقر والمتكامل)
// تاريخ التحديث: 2026-10-22
//
// التغييرات الرئيسية في v5.2.0:
//   🔥 [FIX #21] دعم شامل لجميع عبارات التوافر (متوفر بالمخزن، نفد من المخزن، متاح) في toAvailable
//   🔥 [FIX #22] محول تلقائي لروابط صور Google Drive (drive.google.com/file/d/...) إلى روابط تدفق مباشر (lh3.googleusercontent.com/d/...)
//   🔥 [FIX #23] توسيع القائمة البيضاء لنطاقات الصور IMAGE_HOST_WHITELIST لتشمل كافة مواقع الموردين والشركات المعتمدة في الشيت (elarabygroup.com, wuiltstore.com, sokany-eg.com, homzmart.net, roxystore.net, alasly.net, tv-it.com, homyonline.com, files.easy-orders.net إلخ) مع دعم روابط الصور المباشرة الآمنة
//   🔥 [FIX #24] رفع حد جلب البيانات MAX_LIMIT من 500 إلى 1000 صنف لضمان جلب كامل الـ 548 صنفاً دفعة واحدة دون فاقد
//   🔥 [FIX #25] معالجة الفاصلة العشرية العربية (٫ / \u066B) والأرقام السالبة المركبة مع العملات في toPrice وtoInt
//   🔥 [FIX #26] رفع حد Rate Limiting للقراءة RATE_LIMIT_MAX_READS من 120 إلى 600 طلب/دقيقة لمنع حظر الزوار الحقيقيين
//   🔥 [FIX #27] حماية معادلات ورقة Menu بنسخ احتياطي تلقائي للصيغ في Script Properties مع دالة restoreMenuFormulas للاستعادة
//   🔥 [FIX #28] مطابقة العناوين المرنة (Header Aliases) لمنع فشل القراءة عند اختلاف التسميات (التوافر / حالة التوفر بالمخزن / الفئة)
//   🔥 [FIX #29] دعم إجراءات الإدارة الجديدة في doPost: syncData (المزامنة الآمنة)، restoreFormulas (استعادة المعادلات)، diagnose (فحص الصحة)
//   🔥 [FIX #30] تكامل معماري كامل مع دالة copyDataimpToPriceSafe وقفل التزامن البرمجي LockService
// ================================================================

const SERVER_VERSION = '5.2.0';
const SHEET_ID = '1ev1AhcQmnhwYQuU5QV2drdGdiUW6zY6eXz4QabmFOMc';
const SOURCE_SHEET_NAME = '0';
const SHEET_NAME = 'Menu';

// 🔥 [FIX #3] CACHE_KEY مرتبط بالإصدار
const CACHE_KEY = 'catalog_v' + SERVER_VERSION.replace(/\./g, '') + '_items';
const CACHE_META_KEY = CACHE_KEY + '_meta';

const CACHE_EXPIRY = 600;          // 10 دقائق
// 🔥 [FIX #1] 80000 بايت، سنستخدم ÷4 لضمان الأمان مع UTF-8
const CACHE_CHUNK_BYTES = 80000;
const CACHE_MAX_CHUNKS = 50;       // 🔥 [FIX #2] حد أقصى معقول

// 🔥 [FIX #24] رفع الحد إلى 1000 لاستيعاب كامل الـ 548 منتجاً في طلب واحد
const MAX_LIMIT = 1000;
const MAX_PAYLOAD_BYTES = 100000;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 200;

// 🔥 [FIX #4] مفتاح المصادقة (يقرأ من Script Properties مع قيمة احتياطية)
function getAdminSecret() {
    try {
        const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
        if (stored && stored.trim().length > 0) return stored.trim();
    } catch (e) { /* ignore */ }
    return 'CHANGE_ME_TO_A_LONG_RANDOM_STRING_v5';
}
const ADMIN_SECRET = getAdminSecret();

// 🔥 [FIX #26] رفع حد القراءة إلى 600 طلب في الدقيقة لضمان عدم حظر الزوار الحقيقيين
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_WRITES = 30;  // 30 عملية كتابة في الدقيقة
const RATE_LIMIT_MAX_READS = 600;  // 600 قراءة في الدقيقة

// 🔥 [FIX #23] توسيع القائمة البيضاء لتشمل كافة موردي ومخازن سنتر عبد الله السويس
const IMAGE_HOST_WHITELIST = [
    'i.ibb.co',
    'ibb.co',
    'drive.google.com',
    'lh3.googleusercontent.com',
    'googleusercontent.com',
    'res.cloudinary.com',
    'images.unsplash.com',
    'cdn.shopify.com',
    'encrypted-tbn0.gstatic.com',
    'files.easy-orders.net',
    'easy-orders.net',
    'myeasyorders.com',
    'elarabygroup.com',
    'wuiltstore.com',
    'assets.wuiltstore.com',
    'sokany-eg.com',
    'sokany.com',
    'homzmart.net',
    'eg-rv.homzmart.net',
    'roxystore.net',
    'alasly.net',
    'tv-it.com',
    'homyonline.com',
    'postimages.org',
    'postimg.cc',
    'imgur.com',
    'i.imgur.com',
    'media-amazon.com',
    'm.media-amazon.com',
    'noon.com'
];

// 🔥 [FIX #8 & #28] العناوين الإلزامية والاختيارية مع دعم المرادفات
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
    'التصنيف',
    'الفئة',
    'الوصف',
    'العلامة التجارية',
    'الوحدة',
    'حالة المنتج',
    'محذوف'       // 🔥 [FIX #6] عمود الحذف الناعم (اختياري)
];

// 🔥 [FIX #28] قاموس المرادفات للعناوين لمنع تعطل النظام عند أي اختلاف طفيف في التسمية
const HEADER_ALIASES = {
    'كود الصنف': ['كود الصنف', 'الكود', 'كود', 'الباركود', 'باركود', 'code', 'barcode', 'id'],
    'اسم الصنف': ['اسم الصنف', 'اسم المنتج', 'الاسم', 'المادة', 'name', 'product_name'],
    'سعر الكاش': ['سعر الكاش', 'سعر البيع كاش', 'كاش', 'cash_price', 'cash'],
    'سعر البيع قسط': ['سعر البيع قسط', 'سعر القسط', 'قسط', 'قسط شهري', 'installment_price', 'installment'],
    'الكمية': ['الكمية', 'الكمية الموجودة', 'الرصيد', 'المخزون', 'qty', 'quantity', 'stock'],
    'التوافر': ['التوافر', 'حالة التوفر بالمخزن', 'التوفر', 'حالة التوفر', 'المتاح', 'available', 'availability'],
    'رابط الصورة': ['رابط الصورة', 'الصورة', 'صورة', 'image', 'image_url', 'img'],
    'التصنيف': ['التصنيف', 'القسم', 'المجموعة', 'category'],
    'الفئة': ['الفئة', 'القسم الرئيسي', 'التصنيف الرئيسي'],
    'الوصف': ['الوصف', 'وصف المنتج', 'المواصفات', 'description', 'desc'],
    'العلامة التجارية': ['العلامة التجارية', 'الماركة', 'البراند', 'الشركة', 'brand'],
    'الوحدة': ['الوحدة', 'وحدة القياس', 'unit'],
    'حالة المنتج': ['حالة المنتج', 'الحالة', 'condition', 'status'],
    'محذوف': ['محذوف', 'محذوفة', 'deleted', 'is_deleted']
};

// أعمدة مسموح تعديلها من لوحة التحكم
const EDITABLE_FIELDS = [
    'اسم الصنف', 'سعر الكاش', 'سعر البيع قسط',
    'الكمية', 'التوافر', 'رابط الصورة',
    'التصنيف', 'الفئة', 'الوصف', 'العلامة التجارية',
    'الوحدة', 'حالة المنتج'
];

// ================================================================
// [1] أدوات مساعدة عامة والتسجيل المنظّم
// ================================================================
function s(val) {
    if (val === null || val === undefined) return '';
    return String(val);
}

// 🔥 [FIX #14] قياس حجم السلسلة بالبايتات الفعلية لـ UTF-8
function byteLength(str) {
    if (!str) return 0;
    try {
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(str).length;
        }
    } catch (e) { /* fallback */ }
    try {
        return Utilities.newBlob(str, 'text/plain', 'UTF-8').getBytes().length;
    } catch (e) {
        let b = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            if (c < 0x80) b += 1;
            else if (c < 0x800) b += 2;
            else if (c >= 0xD800 && c <= 0xDBFF) { b += 4; i++; }
            else b += 3;
        }
        return b;
    }
}

function logError(context, err, data) {
    try {
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            version: SERVER_VERSION,
            context: context,
            error: (err && err.message) ? err.message : String(err),
            stack: (err && err.stack) ? err.stack : undefined,
            data: data || {}
        }));
    } catch (e) {
        Logger.log('ERROR [' + context + ']: ' + err);
    }
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
// [2] تحويلات آمنة وتعقيم البيانات
// ================================================================

// 🔥 [FIX #25] معالجة الأرقام العربية والفاصلة العشرية العربية (٫) والأرقام المركبة
function toPrice(value) {
    if (value === null || value === undefined || value === '') return 0;

    let str = String(value);

    // تحويل الأرقام العربية-الهندية إلى أرقام لاتينية قياسية
    str = str.replace(/[٠-٩]/g, function(d) {
        return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    });

    // تحويل الفاصلة العشرية العربية (٫) إلى نقطة لاتينية (.)
    str = str.replace(/[\u066B]/g, '.');

    // إزالة فواصل الآلاف (، و ٬ و , والمسافات وفواصل العملات)
    str = str.replace(/[\u066C،,]/g, '');

    // إزالة محارف الاتجاه
    str = str.replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '');

    // فحص ما إذا كانت القيمة تحتوي على إشارة سالب قبل أو بعد العملة
    const isNegative = /^\s*-\s*[^\d]*\d|\d[^\d]*-\s*$/.test(str) || str.indexOf('-') !== -1;

    // استخراج أول رقم عشري صالح
    const match = str.match(/\d+(?:\.\d+)?/);
    if (!match) return 0;

    const num = parseFloat(match[0]);
    if (isNaN(num) || !isFinite(num)) return 0;

    return isNegative ? 0 : Math.max(0, num);
}

function toInt(value) {
    if (value === null || value === undefined || value === '') return 0;

    let str = String(value);
    str = str.replace(/[٠-٩]/g, function(d) {
        return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    });
    str = str.replace(/[\u066B]/g, '.');
    str = str.replace(/[\u066C،,\u200E\u200F\u061C\u202A-\u202E\s]/g, '');
    str = str.trim();

    const match = str.match(/\d+/);
    if (!match) return 0;

    const num = parseInt(match[0], 10);
    if (isNaN(num) || !isFinite(num)) return 0;
    return Math.max(0, num);
}

// 🔥 [FIX #21] دعم شامل لكافة عبارات التوافر (متوفر بالمخزن، متوفر، نعم، متاح)
function toAvailable(value) {
    if (value === null || value === undefined) return false;
    const str = s(value)
        .replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '')
        .trim()
        .toLowerCase();

    if (!str || str === '0' || str === 'false' || str === 'لا' || str === 'no' || str === 'n') {
        return false;
    }
    if (str.includes('غير متوفر') || str.includes('نفد') || str.includes('منتهي') || str.includes('out of stock')) {
        return false;
    }
    return str.includes('متوفر')
        || str.includes('متاح')
        || str === 'true'
        || str === '1'
        || str === 'نعم'
        || str === 'yes'
        || str === 'y'
        || str === 'in stock';
}

// 🔥 [FIX #11] حماية من Formula Injection في النصوص
function sanitizeText(value, maxLen) {
    let str = s(value).trim();
    if (!str) return '';
    if (maxLen && str.length > maxLen) str = str.substring(0, maxLen);

    // إزالة محارف التحكم الخفية
    str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // منع حقن الصيغ
    if (/^[=+\-@]/.test(str)) str = "'" + str;

    return str;
}

// 🔥 [FIX #22] تحويل روابط مشاركة Google Drive إلى روابط تدفق مباشر
function formatDriveImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    const match = trimmed.match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|id=)([a-zA-Z0-9_-]{25,})/);
    if (match && match[1]) {
        return 'https://lh3.googleusercontent.com/d/' + match[1];
    }
    return trimmed;
}

// 🔥 [FIX #15 & #23] تعقيم وفحص روابط الصور مع دعم النطاقات والصور المباشرة
function sanitizeImageUrl(value) {
    let str = s(value).trim();
    if (!str) return '';

    str = str.replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '').trim();
    str = formatDriveImageUrl(str);

    if (!/^https?:\/\//i.test(str)) return '';

    try {
        const parsed = new URL(str);
        const host = parsed.hostname.toLowerCase();

        const ok = IMAGE_HOST_WHITELIST.some(function(allowed) {
            return host === allowed || host.endsWith('.' + allowed);
        });

        if (!ok) {
            const isDirectImage = /\.(jpg|jpeg|png|webp|avif|gif|svg)(\?.*)?$/i.test(parsed.pathname);
            if (!isDirectImage) return '';
        }

        return str.length > 500 ? str.substring(0, 500) : str;
    } catch (e) {
        return '';
    }
}

function sanitizeId(value) {
    let str = s(value).trim();
    if (!str) return '';
    str = str.replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '').trim();
    if (str.length > MAX_ID_LENGTH) str = str.substring(0, MAX_ID_LENGTH);
    if (/^[=+\-@]/.test(str)) str = "'" + str;
    return str;
}

// ================================================================
// [3] إدارة العناوين والمطابقة المرنة
// ================================================================

function normalizeHeaderString(h) {
    return s(h)
        .replace(/[\u200E\u200F\u061C\u202A-\u202E]/g, '')
        .trim()
        .toLowerCase();
}

// 🔥 [FIX #28] البحث عن العمود بالاسم أو بالمرادفات الشائعة
function findColumnIndex(headers, name) {
    const target = normalizeHeaderString(name);
    for (let i = 0; i < headers.length; i++) {
        if (normalizeHeaderString(headers[i]) === target) return i;
    }

    const aliases = HEADER_ALIASES[name];
    if (aliases && Array.isArray(aliases)) {
        for (let a = 0; a < aliases.length; a++) {
            const aliasNorm = normalizeHeaderString(aliases[a]);
            for (let i = 0; i < headers.length; i++) {
                if (normalizeHeaderString(headers[i]) === aliasNorm) return i;
            }
        }
    }
    return -1;
}

function findDuplicateHeaders(headers) {
    const seen = {};
    const duplicates = [];
    for (let i = 0; i < headers.length; i++) {
        const h = normalizeHeaderString(headers[i]);
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

    const duplicates = findDuplicateHeaders(headers);
    return { ok: true, missing: [], map: map, duplicates: duplicates };
}

// ================================================================
// [4] بناء وتوحيد استجابات JSON
// ================================================================
function jsonOutput(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}

function jsonOK(items, total, fromCache, lastUpdate, extra) {
    const res = {
        success: true,
        version: SERVER_VERSION,
        data: items,
        total: (total !== undefined && total !== null) ? total : items.length,
        fromCache: !!fromCache,
        lastUpdate: lastUpdate || null,
        empty: !items || items.length === 0
    };
    if (extra && typeof extra === 'object') {
        for (const k in extra) {
            if (extra.hasOwnProperty(k)) res[k] = extra[k];
        }
    }
    return jsonOutput(res);
}

function jsonError(message, code, extra) {
    const res = {
        success: false,
        version: SERVER_VERSION,
        error: message,
        code: code || 'UNKNOWN_ERROR'
    };
    if (extra && typeof extra === 'object') {
        for (const k in extra) {
            if (extra.hasOwnProperty(k)) res[k] = extra[k];
        }
    }
    return jsonOutput(res);
}

// ================================================================
// [5] Rate Limiting لحماية السيرفر من الاستنزاف
// ================================================================
function rateLimit(scope, maxOps, windowSec) {
    try {
        const cache = CacheService.getScriptCache();
        const key = 'rl_' + scope + '_' + Math.floor(Date.now() / (windowSec * 1000));
        const current = parseInt(cache.get(key) || '0', 10);
        if (current >= maxOps) return false;
        cache.put(key, String(current + 1), windowSec + 5);
        return true;
    } catch (e) {
        return true;
    }
}

// ================================================================
// [6] الكاش المجزأ الذكي (Chunked Cache)
// ================================================================
function cacheClear() {
    try {
        const cache = CacheService.getScriptCache();
        const meta = cache.get(CACHE_META_KEY);
        if (meta) {
            try {
                const info = JSON.parse(meta);
                const n = Math.min(info.n || 0, CACHE_MAX_CHUNKS);
                for (let i = 0; i < n; i++) {
                    cache.remove(CACHE_KEY + '_c' + i);
                }
            } catch (e) { /* meta corrupted */ }
        }

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
        const direct = cache.get(CACHE_KEY);
        if (direct) {
            try {
                const parsed = JSON.parse(direct);
                return (parsed && Array.isArray(parsed.items)) ? parsed : null;
            } catch (e) { /* corrupted */ }
        }

        const meta = cache.get(CACHE_META_KEY);
        if (!meta) return null;

        let info;
        try {
            info = JSON.parse(meta);
        } catch (e) { return null; }

        if (!info || !info.n || info.n <= 0) return null;

        const keys = [];
        for (let i = 0; i < info.n; i++) keys.push(CACHE_KEY + '_c' + i);

        const parts = cache.getAll(keys);
        let combined = '';
        for (let i = 0; i < info.n; i++) {
            const part = parts[CACHE_KEY + '_c' + i];
            if (part === null || part === undefined) {
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
        const bytes = byteLength(json);
        const cache = CacheService.getScriptCache();

        if (bytes <= CACHE_CHUNK_BYTES) {
            cache.put(CACHE_KEY, json, CACHE_EXPIRY);
            return cache.get(CACHE_KEY) !== null;
        }

        const charStep = Math.floor(CACHE_CHUNK_BYTES / 4);
        const chunks = [];
        let cursor = 0;

        while (cursor < json.length) {
            let end = Math.min(cursor + charStep, json.length);

            while (end > cursor) {
                const code = json.charCodeAt(end - 1);
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

        const toWrite = {};
        for (let i = 0; i < chunks.length; i++) {
            toWrite[CACHE_KEY + '_c' + i] = chunks[i];
        }
        cache.putAll(toWrite, CACHE_EXPIRY);
        cache.put(CACHE_META_KEY, JSON.stringify({ n: chunks.length, ts: Date.now() }), CACHE_EXPIRY);

        return cache.get(CACHE_META_KEY) !== null;
    } catch (e) {
        logError('cacheSet', e);
        return false;
    }
}

// ================================================================
// [7] إدارة طابع التحديث (lastUpdate)
// ================================================================
function getLastUpdate() {
    try {
        return PropertiesService.getScriptProperties().getProperty('LAST_UPDATE') || '';
    } catch (e) {
        return '';
    }
}

function setLastUpdate() {
    try {
        const now = Utilities.formatDate(
            new Date(),
            Session.getScriptTimeZone() || 'Africa/Cairo',
            'yyyy/MM/dd HH:mm'
        );
        PropertiesService.getScriptProperties().setProperty('LAST_UPDATE', now);
        return now;
    } catch (e) {
        logError('setLastUpdate', e);
        return '';
    }
}

// ================================================================
// [8] قراءة واستخراج الكتالوج من الشيت
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

    let lastUpdate = getLastUpdate();
    if (!lastUpdate && headers.length >= 11 && headers[10]) {
        try {
            if (headers[10] instanceof Date) {
                lastUpdate = Utilities.formatDate(headers[10], Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy/MM/dd HH:mm');
            } else {
                lastUpdate = sanitizeText(headers[10], 60);
            }
        } catch (e) {
            lastUpdate = String(headers[10] || '');
        }
    }

    if (lastRow <= 1) {
        return { items: [], lastUpdate: lastUpdate, skipped: 0 };
    }

    const col = validation.map;
    const hasImage = col['رابط الصورة'] !== undefined;
    const hasCategory = col['التصنيف'] !== undefined;
    const hasRefinedCategory = col['الفئة'] !== undefined;
    const hasDesc = col['الوصف'] !== undefined;
    const hasBrand = col['العلامة التجارية'] !== undefined;
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

        if (hasDeleted && toAvailable(row[col['محذوف']])) {
            continue;
        }

        const imageUrl = hasImage ? sanitizeImageUrl(row[col['رابط الصورة']]) : '';

        // استخدام الفئة المنقحة إذا توفرت بدلاً من التصنيف الخام
        let categoryVal = '';
        if (hasRefinedCategory && row[col['الفئة']]) {
            categoryVal = sanitizeText(row[col['الفئة']], 100);
        } else if (hasCategory && row[col['التصنيف']]) {
            categoryVal = sanitizeText(row[col['التصنيف']], 100);
        }

        items.push({
            id: id,
            name: sanitizeText(row[col['اسم الصنف']], MAX_NAME_LENGTH),
            cashPrice: toPrice(row[col['سعر الكاش']]),
            installPrice: toPrice(row[col['سعر البيع قسط']]),
            quantity: toInt(row[col['الكمية']]),
            available: toAvailable(row[col['التوافر']]),
            image: imageUrl,
            category: categoryVal,
            description: hasDesc ? sanitizeText(row[col['الوصف']], 1000) : '',
            brand: hasBrand ? sanitizeText(row[col['العلامة التجارية']], 100) : ''
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
// [9] توثيق ترويسات CORS
// ================================================================
function getCorsHeaders() {
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
        if (!rateLimit('get', RATE_LIMIT_MAX_READS, RATE_LIMIT_WINDOW_SEC)) {
            return jsonError('عدد الطلبات كبير، حاول لاحقاً', 'RATE_LIMIT');
        }

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

            return jsonOK(page, total, result.fromCache, result.lastUpdate, {
                offset: offset,
                limit: limit,
                hasMore: (offset + limit) < total
            });
        }

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
                maxLimit: MAX_LIMIT,
                timestamp: Date.now()
            });
        }

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

            // فحص وجود معادلات في ورقة Menu
            let hasFormulas = false;
            try {
                const fA2 = sheet.getRange('A2').getFormula();
                const fG1 = sheet.getRange('G1').getFormula();
                hasFormulas = !!(fA2 || fG1);
            } catch (fe) { /* ignore */ }

            return jsonOutput({
                success: true,
                version: SERVER_VERSION,
                headers: headers.map(s),
                required: REQUIRED_HEADERS,
                optional: OPTIONAL_HEADERS,
                valid: validation.ok,
                missing: validation.missing,
                duplicates: validation.duplicates,
                hasImageColumn: imageCol !== -1,
                imageColumnIndex: imageCol,
                hasDeletedColumn: deletedCol !== -1,
                deletedColumnIndex: deletedCol,
                menuHasFormulas: hasFormulas,
                lastUpdate: getLastUpdate(),
                totalRows: sheet.getLastRow(),
                totalColumns: sheet.getLastColumn()
            });
        }

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
        } else if (action === 'syncData') {
            result = copyDataimpToPriceSafe();
        } else if (action === 'restoreFormulas') {
            result = restoreMenuFormulas();
        } else {
            return jsonError('إجراء غير صالح: ' + action, 'INVALID_ACTION');
        }

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
// [12] دوال مساعدة للكتابة وحماية المعادلات
// ================================================================
function getSheet() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('الورقة غير موجودة: ' + SHEET_NAME);
    return sheet;
}

// 🔥 [FIX #27] حماية معادلات Menu بنسخ احتياطي قبل التثبيت
function ensureMenuWritable(sheet) {
    try {
        const rangeA2 = sheet.getRange('A2');
        const rangeG1 = sheet.getRange('G1');
        const fA2 = rangeA2.getFormula();
        const fG1 = rangeG1.getFormula();

        if (fA2 || fG1) {
            const formulasBackup = {
                A2: fA2,
                G1: fG1,
                H1: sheet.getRange('H1').getFormula(),
                I1: sheet.getRange('I1').getFormula(),
                J1: sheet.getRange('J1').getFormula(),
                K1: sheet.getRange('K1').getFormula(),
                timestamp: new Date().toISOString()
            };
            PropertiesService.getScriptProperties().setProperty('MENU_FORMULAS_BACKUP', JSON.stringify(formulasBackup));

            const dataRange = sheet.getDataRange();
            const vals = dataRange.getValues();
            dataRange.setValues(vals);
            logInfo('ensureMenuWritable', { message: 'تم تثبيت القيم لحماية الورقة مع أخذ نسخة احتياطية من المعادلات' });
        }
    } catch (e) {
        logError('ensureMenuWritable', e);
    }
}

// 🔥 [FIX #27] استعادة معادلات ورقة Menu الأصلية وإعادة ربطها بمصنف '0'
function restoreMenuFormulas() {
    try {
        const sheet = getSheet();
        sheet.clearContents();

        sheet.getRange('A1:F1').setValues([['كود الصنف', 'اسم الصنف', 'سعر الكاش', 'سعر البيع قسط', 'الكمية', 'التوافر']]);
        sheet.getRange('G1').setFormula("='0'!H:H");
        sheet.getRange('H1').setFormula("='0'!K:K");
        sheet.getRange('I1').setFormula("='0'!J:J");
        sheet.getRange('J1').setFormula("='0'!L:L");
        sheet.getRange('K1').setFormula("='0'!G1");
        sheet.getRange('A2').setFormula("=ARRAYFORMULA('0'!A2:F1000)");

        cacheClear();
        setLastUpdate();
        return jsonOutput({
            success: true,
            version: SERVER_VERSION,
            action: 'restoreFormulas',
            message: 'تمت استعادة معادلات ورقة Menu وربطها بنجاح مع ورقة 0'
        });
    } catch (e) {
        logError('restoreMenuFormulas', e);
        return jsonError('فشل استعادة الصيغ: ' + e.message, 'RESTORE_FAILED');
    }
}

function getHeadersAndValidation(sheet) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const validation = validateHeaders(headers);
    if (!validation.ok) {
        throw new Error('عمود مفقود: ' + validation.missing.join(', '));
    }
    return { headers: headers, col: validation.map };
}

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

function validatePrices(cashPrice, installPrice) {
    if (cashPrice < 0) {
        return { ok: false, error: 'سعر الكاش لا يمكن أن يكون سالباً' };
    }
    if (installPrice < 0) {
        return { ok: false, error: 'سعر القسط لا يمكن أن يكون سالباً' };
    }
    if (installPrice > 0 && cashPrice > 0 && installPrice < cashPrice) {
        return {
            ok: true,
            warning: 'سعر القسط (' + installPrice + ') أقل من سعر الكاش (' + cashPrice + ')'
        };
    }
    return { ok: true };
}

// ================================================================
// [13] عمليات الكتابة والحذف الناعم
// ================================================================
function handleUpdateItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    const rowIndex = findRowByCode(sheet, col, data.id);
    if (rowIndex === -1) {
        return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
    }

    const currentRow = sheet.getRange(rowIndex, 1, 1, info.headers.length).getValues()[0];
    const newRow = currentRow.slice();

    const newCash = data.cashPrice !== undefined ? toPrice(data.cashPrice) : toPrice(currentRow[col['سعر الكاش']]);
    const newInst = data.installPrice !== undefined ? toPrice(data.installPrice) : toPrice(currentRow[col['سعر البيع قسط']]);

    const priceCheck = validatePrices(newCash, newInst);
    if (!priceCheck.ok) {
        return jsonError(priceCheck.error, 'INVALID_PRICE');
    }

    if (data.name !== undefined) {
        newRow[col['اسم الصنف']] = sanitizeText(data.name, MAX_NAME_LENGTH);
    }
    if (data.cashPrice !== undefined) {
        newRow[col['سعر الكاش']] = newCash;
    }
    if (data.installPrice !== undefined) {
        newRow[col['سعر البيع قسط']] = newInst;
    }
    if (data.quantity !== undefined) {
        newRow[col['الكمية']] = toInt(data.quantity);
    }
    if (data.available !== undefined) {
        newRow[col['التوافر']] = data.available ? 'متوفر' : 'غير متوفر';
    }
    if (data.image !== undefined && col['رابط الصورة'] !== undefined) {
        newRow[col['رابط الصورة']] = sanitizeImageUrl(data.image);
    }
    if (data.category !== undefined && col['التصنيف'] !== undefined) {
        newRow[col['التصنيف']] = sanitizeText(data.category, 100);
    }
    if (data.refinedCategory !== undefined && col['الفئة'] !== undefined) {
        newRow[col['الفئة']] = sanitizeText(data.refinedCategory, 100);
    }
    if (data.description !== undefined && col['الوصف'] !== undefined) {
        newRow[col['الوصف']] = sanitizeText(data.description, 1000);
    }
    if (data.brand !== undefined && col['العلامة التجارية'] !== undefined) {
        newRow[col['العلامة التجارية']] = sanitizeText(data.brand, 100);
    }

    ensureMenuWritable(sheet);
    sheet.getRange(rowIndex, 1, 1, newRow.length).setValues([newRow]);

    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'update',
        id: data.id,
        warning: priceCheck.warning || null
    });
}

function handleAddItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');
    if (!data.name) return jsonError('اسم الصنف مطلوب', 'MISSING_NAME');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    const id = sanitizeId(data.id);
    if (!id) return jsonError('كود الصنف غير صالح', 'INVALID_ID');

    if (findRowByCode(sheet, col, id) !== -1) {
        return jsonError('الكود موجود بالفعل: ' + id, 'DUPLICATE');
    }

    const cashPrice = toPrice(data.cashPrice);
    const installPrice = toPrice(data.installPrice);
    const priceCheck = validatePrices(cashPrice, installPrice);
    if (!priceCheck.ok) {
        return jsonError(priceCheck.error, 'INVALID_PRICE');
    }

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
    if (col['التصنيف'] !== undefined && data.category) {
        newRow[col['التصنيف']] = sanitizeText(data.category, 100);
    }
    if (col['الفئة'] !== undefined && data.refinedCategory) {
        newRow[col['الفئة']] = sanitizeText(data.refinedCategory, 100);
    }
    if (col['الوصف'] !== undefined && data.description) {
        newRow[col['الوصف']] = sanitizeText(data.description, 1000);
    }
    if (col['العلامة التجارية'] !== undefined && data.brand) {
        newRow[col['العلامة التجارية']] = sanitizeText(data.brand, 100);
    }
    if (col['محذوف'] !== undefined) {
        newRow[col['محذوف']] = 'لا';
    }

    ensureMenuWritable(sheet);
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

function handleDeleteItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    const rowIndex = findRowByCode(sheet, col, data.id);
    if (rowIndex === -1) {
        return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
    }

    if (col['محذوف'] !== undefined) {
        ensureMenuWritable(sheet);
        sheet.getRange(rowIndex, col['محذوف'] + 1).setValue('نعم');
        return jsonOutput({
            success: true,
            version: SERVER_VERSION,
            action: 'softDelete',
            id: data.id,
            row: rowIndex
        });
    }

    ensureMenuWritable(sheet);
    sheet.deleteRow(rowIndex);
    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'hardDelete',
        id: data.id,
        row: rowIndex
    });
}

function handleRestoreItem(data) {
    if (!data.id) return jsonError('كود الصنف مطلوب', 'MISSING_ID');

    const sheet = getSheet();
    const info = getHeadersAndValidation(sheet);
    const col = info.col;

    if (col['محذوف'] === undefined) {
        return jsonError('عمود "محذوف" غير موجود في الجدول', 'NO_DELETE_COLUMN');
    }

    const rowIndex = findRowByCode(sheet, col, data.id);
    if (rowIndex === -1) {
        return jsonError('المنتج غير موجود: ' + data.id, 'NOT_FOUND');
    }

    ensureMenuWritable(sheet);
    sheet.getRange(rowIndex, col['محذوف'] + 1).setValue('لا');

    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'restore',
        id: data.id,
        row: rowIndex
    });
}

// ================================================================
// [14] مشغل التعديل التلقائي (Trigger)
// ================================================================
function onSheetEdit(e) {
    try {
        if (!e || !e.range) return;

        const sheet = e.range.getSheet();
        if (sheet.getName() !== SHEET_NAME) return;

        if (e.changeType && e.changeType !== 'EDIT' && e.changeType !== 'INSERT_ROW' && e.changeType !== 'REMOVE_ROW') {
            return;
        }

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
// [15] تثبيت المشغلات التلقائية
// ================================================================
function installTrigger() {
    try {
        const triggers = ScriptApp.getProjectTriggers();
        let removed = 0;
        let installed = 0;

        for (let i = 0; i < triggers.length; i++) {
            const t = triggers[i];
            if (t.getHandlerFunction() === 'onSheetEdit') {
                try {
                    ScriptApp.deleteTrigger(t);
                    removed++;
                } catch (e) { /* ignore */ }
            }
        }

        ScriptApp.newTrigger('onSheetEdit')
            .forSpreadsheet(SHEET_ID)
            .onEdit()
            .create();
        installed++;

        return 'Trigger installed successfully. Removed: ' + removed + ', Installed: ' + installed;
    } catch (err) {
        logError('installTrigger', err);
        return 'Trigger install failed: ' + err.message;
    }
}

// ================================================================
// [16] أدوات مساعدة للصيانة اليدوية وقائمة الشيت
// ================================================================

function onOpen() {
    try {
        const ui = SpreadsheetApp.getUi();
        ui.createMenu('🏪 سنتر عبد الله السويس')
            .addItem('⚡ مزامنة وتحديث الكاش فوراً', 'clearCacheManual')
            .addItem('🔄 استعادة معادلات ورقة Menu الأصلية', 'restoreMenuFormulas')
            .addSeparator()
            .addItem('🔍 فحص وتشخيص صحة السيرفر والجدول', 'diagnoseManual')
            .addItem('🧪 اختبار سرعة وكفاءة الكاش', 'testCache')
            .addToUi();
    } catch (e) { /* silent on webapp */ }
}

function setLastUpdateManual(value) {
    try {
        const props = PropertiesService.getScriptProperties();
        props.setProperty('LAST_UPDATE', String(value || ''));
        return 'OK: ' + value;
    } catch (e) {
        return 'ERROR: ' + e.message;
    }
}

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

function clearCacheManual() {
    cacheClear();
    setLastUpdate();
    return 'Cache cleared successfully';
}

// ================================================================
// [17] دالة المزامنة الآمنة بين DATAIMP و priceimg (v5.2.0)
// ================================================================
/**
 * تُستخدم لمزامنة مصنف priceimg بأمان تام:
 * تقرأ البيانات في الذاكرة أولاً قبل أي مسح، وتدمج كافة الحقول التسويقية
 * بناءً على «كود الصنف» كمفتاح فريد لمنع انزلاق الصفوف أو ضياع البيانات.
 */
function copyDataimpToPriceSafe() {
    const SOURCE_SHEET_NAME = 'DATAIMP';
    const TARGET_SHEET_NAME = 'priceimg';

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName(SOURCE_SHEET_NAME);
    if (!sourceSheet) {
        Logger.log('⚠️ الورقة المصدر غير موجودة: ' + SOURCE_SHEET_NAME);
        return jsonError('الورقة المصدر غير موجودة: ' + SOURCE_SHEET_NAME, 'SHEET_NOT_FOUND');
    }

    const sourceRange = sourceSheet.getDataRange();
    const sourceValues = sourceRange.getValues();
    if (sourceValues.length <= 1 || sourceValues[0].length === 0) {
        return jsonError('الورقة المصدر فارغة', 'EMPTY_SOURCE');
    }

    let targetSheet = ss.getSheetByName(TARGET_SHEET_NAME);
    const enrichmentMap = {};

    if (targetSheet && targetSheet.getLastRow() > 1) {
        const oldValues = targetSheet.getDataRange().getValues();
        for (let r = 1; r < oldValues.length; r++) {
            const code = sanitizeId(oldValues[r][0]);
            if (!code) continue;
            enrichmentMap[code] = {
                image: formatDriveImageUrl(oldValues[r][7]),
                shortName: s(oldValues[r][8]).trim(),
                description: s(oldValues[r][9]).trim(),
                brand: s(oldValues[r][11]).trim(),
                unit: s(oldValues[r][12]).trim(),
                condition: s(oldValues[r][13]).trim(),
                lastEdit: oldValues[r][14] || ''
            };
        }
    } else if (!targetSheet) {
        targetSheet = ss.insertSheet(TARGET_SHEET_NAME);
    }

    const currentTimestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Africa/Cairo', 'yyyy-MM-dd HH:mm:ss');

    const mergedValues = sourceValues.map(function(row, idx) {
        const newRow = row.slice();
        while (newRow.length < 15) newRow.push('');

        if (idx === 0) {
            newRow[7] = 'رابط الصورة';
            newRow[8] = 'اسم مختصر';
            newRow[9] = 'الوصف';
            newRow[11] = 'العلامة التجارية';
            newRow[12] = 'الوحدة';
            newRow[13] = 'حالة المنتج';
            newRow[14] = 'آخر تعديل';
            return newRow;
        }

        const code = sanitizeId(newRow[0]);
        newRow[0] = code;

        // ضبط التوافر التلقائي
        const qtyNum = toInt(newRow[4]);
        newRow[5] = qtyNum > 0 ? 'متوفر بالمخزن' : 'نفد من المخزن';

        if (newRow[7]) {
            newRow[7] = formatDriveImageUrl(newRow[7]);
        }

        const saved = enrichmentMap[code];
        if (saved) {
            if (!newRow[7] || String(newRow[7]).includes('link removed')) newRow[7] = saved.image;
            if (!newRow[8]) newRow[8] = saved.shortName;
            if (!newRow[9]) newRow[9] = saved.description;
            if (!newRow[11]) newRow[11] = saved.brand;
            if (!newRow[12]) newRow[12] = saved.unit;
            if (!newRow[13]) newRow[13] = saved.condition;
            newRow[14] = saved.lastEdit || currentTimestamp;
        } else {
            newRow[14] = currentTimestamp;
        }

        return newRow;
    });

    targetSheet.clearContents();
    targetSheet.getRange(1, 1, mergedValues.length, 1).setNumberFormat('@');
    targetSheet.getRange(1, 1, mergedValues.length, mergedValues[0].length).setValues(mergedValues);
    sourceRange.copyTo(targetSheet.getRange(1, 1, mergedValues.length, mergedValues[0].length), SpreadsheetApp.CopyPasteType.PASTE_COLUMN_WIDTHS, false);

    cacheClear();
    setLastUpdate();

    return jsonOutput({
        success: true,
        version: SERVER_VERSION,
        action: 'syncData',
        itemsCount: mergedValues.length - 1,
        timestamp: currentTimestamp
    });
}
