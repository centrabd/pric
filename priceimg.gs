/**
 * سكريبت لنسخ البيانات والتنسيقات من ورقة DATAIMP إلى ورقة priceimg كقيم وثوابت فقط
 */
function copyDataimpToPrice() {
  const SOURCE_SHEET_NAME = "DATAIMP";  // الورقة المصدر
  const TARGET_SHEET_NAME = "priceimg"; // الورقة الهدف

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName(SOURCE_SHEET_NAME);

  if (!sourceSheet) {
    Logger.log("⚠ الورقة المصدر غير موجودة: " + SOURCE_SHEET_NAME);
    return;
  }

  // 1. جلب أو إنشاء الورقة الهدف (priceimg)
  let targetSheet = ss.getSheetByName(TARGET_SHEET_NAME);
  if (!targetSheet) {
    targetSheet = ss.insertSheet(TARGET_SHEET_NAME);
  } else {
    targetSheet.clear(); // مسح البيانات والتنسيقات القديمة بالكامل
  }

  // 2. جلب البيانات من DATAIMP
  const sourceRange = sourceSheet.getDataRange();
  const values = sourceRange.getValues(); // جلب القيم المباشرة بدون معادلات

  if (values.length === 0 || values[0].length === 0) return;

  // 3. تحديد النطاق في ورقة priceimg وتعبئته بالقيم الثابتة
  const targetRange = targetSheet.getRange(1, 1, values.length, values[0].length);
  targetRange.setValues(values);

  // 4. نقل التنسيقات والألوان وأبعاد الأعمدة
  sourceRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sourceRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_COLUMN_WIDTHS, false);

  Logger.log("✅ تم تحديث ورقة " + TARGET_SHEET_NAME + " بنجاح من " + SOURCE_SHEET_NAME + " في: " + new Date());
}