const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const excel = require('exceljs');
const app = express();
const PORT = 3000;

// مسیر فایل‌های داده
const DATA_FILES = {
  patients: path.join(__dirname, 'data.json'),
  quotaHistory: path.join(__dirname, 'quotaHistory.json'),
  globalQuota: path.join(__dirname, 'globalQuota.json'),
  drugDelivery: path.join(__dirname, 'drugDelivery.json'),
  monthlyReport: path.join(__dirname, 'monthlyReport.json'),
  notifications: path.join(__dirname, 'notifications.json')
};

// لیست داروهای معتبر
const VALID_DRUGS = [
  'شربت متادون',
  'شربت اپیوم',
  'قرص متادون 5',
  'قرص متادون 20',
  'قرص متادون 40'
];

// ساختار پیش‌فرض برای سهمیه کل
const DEFAULT_GLOBAL_QUOTA = {
  drugs: VALID_DRUGS.reduce((acc, drug) => {
    acc[drug] = {
      totalQuota: 10000,
      lastUpdated: new Date().toISOString().split('T')[0],
      warningSent: false,
      monthlyQuotas: [],
      manualAdjustments: []
    };
    return acc;
  }, {})
};

// ساختار پیش‌فرض برای اعلانات
const DEFAULT_NOTIFICATIONS = [
  {
    id: 1,
    title: 'به سیستم خوش آمدید',
    message: 'سیستم مدیریت مرکز ترک اعتیاد آماده استفاده است.',
    date: new Date().toISOString(),
    read: false
  },
  {
    id: 2,
    title: 'آخرین بروزرسانی',
    message: 'نسخه جدید شامل بهینه شدن تمام بخش ها  ui جدید اپلیکیشن راه اندازی شد!',
    date: new Date().toISOString(),
    read: false
  },
];

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// اعتبارسنجی داده‌های بیمار
function validatePatientData(patientData) {
  const errors = [];
  
  if (!patientData.fullName || patientData.fullName.trim().length < 3) {
    errors.push('نام بیمار باید حداقل 3 حرف داشته باشد');
  }
  
  if (!/^\d{10}$/.test(patientData.nationalCode)) {
    errors.push('کد ملی باید 10 رقم باشد');
  }
  
  if (!patientData.birthDate || !patientData.visitDate) {
    errors.push('تاریخ تولد و مراجعه الزامی است');
  }
  
  if (!patientData.recordNumber || patientData.recordNumber.trim().length < 3) {
    errors.push('شماره پرونده الزامی است');
  }
  
  if (isNaN(patientData.quota) || patientData.quota <= 0) {
    errors.push('سهمیه باید عدد مثبت باشد');
  }
  
  if (!VALID_DRUGS.includes(patientData.drug)) {
    errors.push('داروی انتخاب شده معتبر نیست');
  }
  
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

// اعتبارسنجی داده‌های تحویل دارو
function validateDeliveryData(deliveryData) {
  const errors = [];
  
  if (!deliveryData.recordNumber || !deliveryData.patientName || !deliveryData.nationalCode) {
    errors.push('اطلاعات بیمار الزامی است');
  }
  
  if (!deliveryData.drugs || deliveryData.drugs.length === 0) {
    errors.push('حداقل یک دارو باید انتخاب شود');
  }
  
  if (!deliveryData.reason || deliveryData.reason.trim().length < 0) {
    errors.push('دلیل تحویل باید حداقل 5 حرف داشته باشد');
  }
  
  // اعتبارسنجی داروها
  const invalidDrugs = deliveryData.drugs.filter(drug => !VALID_DRUGS.includes(drug));
  if (invalidDrugs.length > 0) {
    errors.push(`داروهای نامعتبر: ${invalidDrugs.join(', ')}`);
  }
  
  // اعتبارسنجی مقادیر داروها
  if (!deliveryData.drugQuantities || Object.keys(deliveryData.drugQuantities).length !== deliveryData.drugs.length) {
    errors.push('مقادیر داروها الزامی است');
  }
  
  for (const drug in deliveryData.drugQuantities) {
    const quantity = parseInt(deliveryData.drugQuantities[drug]);
    if (isNaN(quantity)) {
      errors.push(`مقدار نامعتبر برای ${drug}`);
    } else if (drug.includes('شربت') && (quantity < 1 || quantity > 1000)) {
      errors.push(`مقدار شربت باید بین 1 تا 1000 سی‌سی باشد`);
    } else if (!drug.includes('شربت') && quantity < 1) {
      errors.push(`مقدار قرص باید حداقل 1 عدد باشد`);
    }
  }
  
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

// تابع برای ذخیره داده‌ها در فایل JSON
async function saveToJsonFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    console.log(`Data saved to ${path.basename(filePath)}`);
  } catch (err) {
    console.error(`Error saving to JSON file (${path.basename(filePath)}):`, err);
    throw err;
  }
}

// تابع برای بارگیری داده‌ها از فایل JSON
async function loadFromJsonFile(filePath, defaultValue = []) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // اگر فایل وجود نداشت، آن را با مقدار پیش‌فرض ایجاد می‌کنیم
      await saveToJsonFile(filePath, defaultValue);
      return defaultValue;
    }
    console.error(`Error loading from JSON file (${path.basename(filePath)}):`, err);
    return defaultValue;
  }
}

// تابع برای مدیریت سهمیه کل
async function manageGlobalQuota() {
  try {
    let globalQuota = await loadFromJsonFile(DATA_FILES.globalQuota, DEFAULT_GLOBAL_QUOTA);
    const today = new Date().toISOString().split('T')[0];
    
    // اطمینان از وجود ساختار برای همه داروها
    for (const drug of VALID_DRUGS) {
      if (!globalQuota.drugs[drug]) {
        globalQuota.drugs[drug] = {
          totalQuota: 10000,
          lastUpdated: today,
          warningSent: false,
          monthlyQuotas: [],
          manualAdjustments: []
        };
      }
    }
    
    // بررسی و ریست سهمیه برای هر دارو در شروع ماه جدید
    for (const drug in globalQuota.drugs) {
      const lastUpdated = globalQuota.drugs[drug].lastUpdated;
      
      if (today !== lastUpdated) {
        const lastUpdatedDate = new Date(lastUpdated);
        const currentDate = new Date(today);
        
        if (lastUpdatedDate.getMonth() !== currentDate.getMonth()) {
          globalQuota.drugs[drug].totalQuota = 10000;
          globalQuota.drugs[drug].lastUpdated = today;
          globalQuota.drugs[drug].warningSent = false;
          
          // حذف سهمیه‌های ماهانه منقضی شده
          globalQuota.drugs[drug].monthlyQuotas = globalQuota.drugs[drug].monthlyQuotas.filter(q => {
            const expiryDate = new Date(q.expiresAt);
            return expiryDate > currentDate;
          });
        }
      }
    }
    
    await saveToJsonFile(DATA_FILES.globalQuota, globalQuota);
    return globalQuota;
  } catch (err) {
    console.error('Error managing global quota:', err);
    return DEFAULT_GLOBAL_QUOTA;
  }
}

// تابع برای دریافت تاریخ شمسی
function getPersianDate() {
  const date = new Date();
  const options = { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'Asia/Tehran'
  };
  return new Intl.DateTimeFormat('fa-IR', options).format(date);
}

// تابع برای به‌روزرسانی گزارش ماهانه
async function updateMonthlyReport(delivery) {
  try {
    const currentMonth = delivery.month;
    const currentYear = delivery.year;
    
    let reports = await loadFromJsonFile(DATA_FILES.monthlyReport, []);
    let report = reports.find(r => r.month === currentMonth && r.year === currentYear);
    
    if (!report) {
      report = {
        month: currentMonth,
        year: currentYear,
        drugs: {},
        totalUsed: 0,
        remaining: 0,
        exceeded: 0
      };
      
      // مقداردهی اولیه برای همه داروها
      VALID_DRUGS.forEach(drug => {
        report.drugs[drug] = {
          quantity: 0,
          type: drug.includes('شربت') ? 'cc' : 'عدد'
        };
      });
      
      reports.push(report);
    }
    
    // به‌روزرسانی مقادیر برای هر دارو
    delivery.drugs.forEach(drug => {
      if (report.drugs[drug]) {
        report.drugs[drug].quantity += parseInt(delivery.drugQuantities[drug]) || 0;
      } else {
        report.drugs[drug] = {
          quantity: parseInt(delivery.drugQuantities[drug]) || 0,
          type: drug.includes('شربت') ? 'cc' : 'عدد'
        };
      }
    });
    
    // محاسبه کل استفاده شده
    report.totalUsed = Object.values(report.drugs).reduce((sum, drug) => sum + drug.quantity, 0);
    
    await saveToJsonFile(DATA_FILES.monthlyReport, reports);
  } catch (err) {
    console.error('Error updating monthly report:', err);
  }
}

// تابع برای حذف کامل بیمار و تمام اطلاعات مرتبط
async function deletePatientCompletely(patientId) {
  try {
    // 1. دریافت اطلاعات بیمار
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    const patientIndex = patients.findIndex(p => p._id === patientId);
    
    if (patientIndex === -1) {
      throw new Error('بیمار یافت نشد');
    }
    
    const patient = patients[patientIndex];
    const recordNumber = patient.recordNumber;
    const nationalCode = patient.nationalCode;
    
    // 2. حذف بیمار از لیست بیماران
    patients.splice(patientIndex, 1);
    await saveToJsonFile(DATA_FILES.patients, patients);
    
    // 3. حذف تمام تحویل‌های داروی بیمار
    const deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery, []);
    const filteredDeliveries = deliveries.filter(d => 
      d.recordNumber !== recordNumber && d.nationalCode !== nationalCode
    );
    
    if (filteredDeliveries.length !== deliveries.length) {
      await saveToJsonFile(DATA_FILES.drugDelivery, filteredDeliveries);
      
      // 4. به‌روزرسانی گزارش‌های ماهانه برای ماه‌هایی که بیمار تحویل دارو داشته
      const monthsToUpdate = new Set();
      deliveries.forEach(d => {
        if (d.recordNumber === recordNumber || d.nationalCode === nationalCode) {
          monthsToUpdate.add(`${d.month}-${d.year}`);
        }
      });
      
      for (const monthYear of monthsToUpdate) {
        const [month, year] = monthYear.split('-');
        await recalcMonthlyReport(month, parseInt(year));
      }
    }
    
    // 5. حذف تاریخچه سهمیه بیمار
    const quotaHistory = await loadFromJsonFile(DATA_FILES.quotaHistory);
    const filteredQuotaHistory = quotaHistory.filter(q => q.patientId !== patientId);
    
    if (filteredQuotaHistory.length !== quotaHistory.length) {
      await saveToJsonFile(DATA_FILES.quotaHistory, filteredQuotaHistory);
    }
    
    // 6. برگرداندن سهمیه به سهمیه کل
    const globalQuota = await manageGlobalQuota();
    if (globalQuota.drugs[patient.drug]) {
      globalQuota.drugs[patient.drug].totalQuota += parseInt(patient.quota) || 0;
      globalQuota.drugs[patient.drug].lastUpdated = new Date().toISOString().split('T')[0];
      await saveToJsonFile(DATA_FILES.globalQuota, globalQuota);
    }
    
    return { success: true };
  } catch (err) {
    console.error('Error deleting patient completely:', err);
    throw err;
  }
}

// تابع برای محاسبه مجدد گزارش ماهانه
async function recalcMonthlyReport(month, year) {
  try {
    // دریافت تمام تحویل‌های دارو برای ماه و سال مشخص
    const deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery, []);
    const filteredDeliveries = deliveries.filter(d => 
      d.month === month && d.year === year
    );
    
    // دریافت گزارش‌های ماهانه فعلی
    let reports = await loadFromJsonFile(DATA_FILES.monthlyReport, []);
    let reportIndex = reports.findIndex(r => r.month === month && r.year === year);
    
    // اگر گزارشی برای این ماه وجود نداشت، یک گزارش جدید ایجاد می‌کنیم
    if (reportIndex === -1) {
      const newReport = {
        month,
        year,
        drugs: {},
        totalUsed: 0,
        remaining: 0,
        exceeded: 0
      };
      
      // مقداردهی اولیه برای همه داروها
      VALID_DRUGS.forEach(drug => {
        newReport.drugs[drug] = {
          quantity: 0,
          type: drug.includes('شربت') ? 'cc' : 'عدد'
        };
      });
      
      reports.push(newReport);
      reportIndex = reports.length - 1;
    }
    
    // ریست کردن مقادیر گزارش
    reports[reportIndex].totalUsed = 0;
    for (const drug in reports[reportIndex].drugs) {
      reports[reportIndex].drugs[drug].quantity = 0;
    }
    
    // محاسبه مقادیر بر اساس تحویل‌های این ماه
    filteredDeliveries.forEach(delivery => {
      delivery.drugs.forEach(drug => {
        if (reports[reportIndex].drugs[drug]) {
          reports[reportIndex].drugs[drug].quantity += parseInt(delivery.drugQuantities[drug]) || 0;
        } else {
          reports[reportIndex].drugs[drug] = {
            quantity: parseInt(delivery.drugQuantities[drug]) || 0,
            type: drug.includes('شربت') ? 'cc' : 'عدد'
          };
        }
      });
    });
    
    // محاسبه کل استفاده شده
    reports[reportIndex].totalUsed = Object.values(reports[reportIndex].drugs)
      .reduce((sum, drug) => sum + drug.quantity, 0);
    
    await saveToJsonFile(DATA_FILES.monthlyReport, reports);
    return { success: true };
  } catch (err) {
    console.error('Error recalculating monthly report:', err);
    throw err;
  }
}

// ==================== Routes ====================
// ثبت اطلاعات بیمار
app.post('/api/patients', async (req, res) => {
  const patientData = req.body;
  
  try {
    validatePatientData(patientData);
    
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    const existingPatient = patients.find(p => 
      p.nationalCode === patientData.nationalCode || p.recordNumber === patientData.recordNumber
    );
    
    if (existingPatient) {
      return res.status(400).json({ 
        success: false, 
        error: 'بیمار با این کد ملی یا کد رهگیری قبلاً ثبت شده است' 
      });
    }
    
    // بررسی سهمیه کل برای داروی انتخابی
    const globalQuota = await manageGlobalQuota();
    const requestedQuota = parseInt(patientData.quota) || 0;
    const selectedDrug = patientData.drug;
    
    if (!globalQuota.drugs[selectedDrug]) {
      return res.status(400).json({ 
        success: false, 
        error: 'داروی انتخاب شده معتبر نیست' 
      });
    }
    
    if (requestedQuota > globalQuota.drugs[selectedDrug].totalQuota) {
      return res.status(400).json({ 
        success: false, 
        error: `سهمیه درخواستی بیشتر از سهمیه کل است. سهمیه باقیمانده ${selectedDrug}: ${globalQuota.drugs[selectedDrug].totalQuota}` 
      });
    }
    
    // کسر از سهمیه کل
    globalQuota.drugs[selectedDrug].totalQuota -= requestedQuota;
    globalQuota.drugs[selectedDrug].lastUpdated = new Date().toISOString().split('T')[0];
    await saveToJsonFile(DATA_FILES.globalQuota, globalQuota);
    
    const newPatient = {
      ...patientData,
      _id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      quotaHistory: []
    };
    
    patients.push(newPatient);
    await saveToJsonFile(DATA_FILES.patients, patients);
    
    res.json({ 
      success: true, 
      id: newPatient._id,
      remainingQuota: globalQuota.drugs[selectedDrug].totalQuota
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت وضعیت سهمیه کل
app.get('/api/global-quota', async (req, res) => {
  try {
    const globalQuota = await manageGlobalQuota();
    res.json(globalQuota);
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// به‌روزرسانی سهمیه کل
app.put('/api/global-quota', async (req, res) => {
  try {
    const { drug, action, amount, description } = req.body;
    
    if (!VALID_DRUGS.includes(drug)) {
      throw new Error('داروی انتخاب شده معتبر نیست');
    }
    
    if (!['add', 'subtract', 'set'].includes(action)) {
      throw new Error('عملیات نامعتبر');
    }
    
    const amountNum = parseInt(amount);
    if (isNaN(amountNum)) {
      throw new Error('مقدار باید عدد باشد');
    }
    
    let globalQuota = await manageGlobalQuota();
    
    // اطمینان از وجود ساختار برای دارو
    if (!globalQuota.drugs[drug]) {
      globalQuota.drugs[drug] = {
        totalQuota: 10000,
        lastUpdated: new Date().toISOString().split('T')[0],
        warningSent: false,
        monthlyQuotas: [],
        manualAdjustments: []
      };
    }
    
    if (!globalQuota.drugs[drug].manualAdjustments) {
      globalQuota.drugs[drug].manualAdjustments = [];
    }
    
    const previousQuota = globalQuota.drugs[drug].totalQuota;
    let newQuota = previousQuota;
    
    if (action === 'add') {
      newQuota += amountNum;
    } else if (action === 'subtract') {
      newQuota -= amountNum;
    } else if (action === 'set') {
      newQuota = amountNum;
    }
    
    if (newQuota < 0) {
      throw new Error('سهمیه نمی‌تواند منفی باشد');
    }
    
    globalQuota.drugs[drug].totalQuota = newQuota;
    globalQuota.drugs[drug].lastUpdated = new Date().toISOString().split('T')[0];
    
    // ثبت تغییرات دستی
    globalQuota.drugs[drug].manualAdjustments.unshift({
      date: new Date().toISOString(),
      action,
      amount: amountNum,
      description: description || '',
      previousQuota: action === 'set' ? null : previousQuota,
      newQuota
    });
    
    await saveToJsonFile(DATA_FILES.globalQuota, globalQuota);
    res.json({ 
      success: true, 
      globalQuota 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ثبت سهمیه ماهانه
app.post('/api/global-quota/monthly', async (req, res) => {
  try {
    const { drug, month, amount, expiryDays } = req.body;
    
    if (!VALID_DRUGS.includes(drug)) {
      throw new Error('داروی انتخاب شده معتبر نیست');
    }
    
    if (!month || month.trim().length < 2) {
      throw new Error('نام ماه الزامی است');
    }
    
    const amountNum = parseInt(amount);
    if (isNaN(amountNum)) {
      throw new Error('مقدار سهمیه باید عدد باشد');
    }
    
    const expiryDaysNum = parseInt(expiryDays) || 30;
    
    let globalQuota = await manageGlobalQuota();
    
    // اطمینان از وجود ساختار برای دارو
    if (!globalQuota.drugs[drug]) {
      globalQuota.drugs[drug] = {
        totalQuota: 10000,
        lastUpdated: new Date().toISOString().split('T')[0],
        warningSent: false,
        monthlyQuotas: [],
        manualAdjustments: []
      };
    }
    
    if (!globalQuota.drugs[drug].monthlyQuotas) {
      globalQuota.drugs[drug].monthlyQuotas = [];
    }
    
    // اضافه کردن سهمیه ماهانه
    const addedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiryDaysNum * 24 * 60 * 60 * 1000).toISOString();
    
    globalQuota.drugs[drug].monthlyQuotas.unshift({
      month,
      amount: amountNum,
      expiryDays: expiryDaysNum,
      addedAt,
      expiresAt
    });
    
    // افزایش سهمیه کل
    globalQuota.drugs[drug].totalQuota += amountNum;
    globalQuota.drugs[drug].lastUpdated = new Date().toISOString().split('T')[0];
    
    await saveToJsonFile(DATA_FILES.globalQuota, globalQuota);
    res.json({ 
      success: true, 
      globalQuota 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت لیست بیماران
app.get('/api/patients', async (req, res) => {
  try {
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    res.json(patients);
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت لیست بیماران به صورت اکسل
app.get('/api/patients/export', async (req, res) => {
  try {
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    
    // ایجاد فایل اکسل
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('بیماران');
    
    // اضافه کردن هدرها
    worksheet.columns = [
      { header: 'نام و نام خانوادگی', key: 'fullName', width: 30 },
      { header: 'کد ملی', key: 'nationalCode', width: 15 },
      { header: 'تاریخ تولد', key: 'birthDate', width: 15 },
      { header: 'تاریخ مراجعه', key: 'visitDate', width: 15 },
      { header: 'شماره پرونده', key: 'recordNumber', width: 20 },
      { header: 'سهمیه', key: 'quota', width: 10 },
      { header: 'دارو', key: 'drug', width: 20 },
      { header: 'تاریخ ثبت', key: 'createdAt', width: 20 }
    ];
    
    // اضافه کردن داده‌ها
    patients.forEach(patient => {
      worksheet.addRow({
        fullName: patient.fullName,
        nationalCode: patient.nationalCode,
        birthDate: patient.birthDate,
        visitDate: patient.visitDate,
        recordNumber: patient.recordNumber,
        quota: patient.quota,
        drug: patient.drug,
        createdAt: new Date(patient.createdAt).toLocaleString('fa-IR')
      });
    });
    
    // تنظیم هدر برای دانلود
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=patients.xlsx'
    );
    
    // ارسال فایل
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting patients:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// جستجوی بیمار با کد ملی یا کد رهگیری
app.get('/api/patients/search', async (req, res) => {
  try {
    const { nationalCode, recordNumber } = req.query;
    
    if (!nationalCode && !recordNumber) {
      throw new Error('کد ملی یا کد رهگیری الزامی است');
    }
    
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    
    let patient = null;
    if (nationalCode) {
      patient = patients.find(p => p.nationalCode === nationalCode);
    } else if (recordNumber) {
      patient = patients.find(p => p.recordNumber === recordNumber);
    }
    
    if (patient) {
      res.json({ 
        success: true, 
        patient 
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'بیمار یافت نشد' 
      });
    }
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت اطلاعات یک بیمار خاص
app.get('/api/patients/:id', async (req, res) => {
  try {
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    const patient = patients.find(p => p._id === req.params.id);
    
    if (patient) {
      res.json(patient);
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'بیمار یافت نشد' 
      });
    }
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// به‌روزرسانی اطلاعات بیمار
app.put('/api/patients/:id', async (req, res) => {
  try {
    const patientData = req.body;
    
    // اعتبارسنجی داده‌ها
    validatePatientData(patientData);
    
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    const patientIndex = patients.findIndex(p => p._id === req.params.id);
    
    if (patientIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: 'بیمار یافت نشد' 
      });
    }
    
    // دریافت اطلاعات بیمار فعلی
    const currentPatient = patients[patientIndex];
    
    // بررسی تغییر کد ملی یا شماره پرونده
    if (patientData.nationalCode !== currentPatient.nationalCode || 
        patientData.recordNumber !== currentPatient.recordNumber) {
      // بررسی تکراری نبودن کد ملی یا شماره پرونده جدید
      const existingPatient = patients.find(p => 
        p._id !== req.params.id && (
          p.nationalCode === patientData.nationalCode || 
          p.recordNumber === patientData.recordNumber
        )
      );
      
      if (existingPatient) {
        return res.status(400).json({ 
          success: false, 
          error: 'بیمار با این کد ملی یا کد رهگیری قبلاً ثبت شده است' 
        });
      }
    }
    
    // بررسی تغییر دارو
    if (patientData.drug !== currentPatient.drug) {
      // برگرداندن سهمیه قدیمی به سهمیه کل
      const globalQuota = await manageGlobalQuota();
      if (globalQuota.drugs[currentPatient.drug]) {
        globalQuota.drugs[currentPatient.drug].totalQuota += parseInt(currentPatient.quota) || 0;
        globalQuota.drugs[currentPatient.drug].lastUpdated = new Date().toISOString().split('T')[0];
      }
      
      // کسر سهمیه جدید از سهمیه کل
      const requestedQuota = parseInt(patientData.quota) || 0;
      if (requestedQuota > globalQuota.drugs[patientData.drug].totalQuota) {
        return res.status(400).json({ 
          success: false, 
          error: `سهمیه درخواستی بیشتر از سهمیه کل است. سهمیه باقیمانده ${patientData.drug}: ${globalQuota.drugs[patientData.drug].totalQuota}` 
        });
      }
      
      globalQuota.drugs[patientData.drug].totalQuota -= requestedQuota;
      globalQuota.drugs[patientData.drug].lastUpdated = new Date().toISOString().split('T')[0];
      await saveToJsonFile(DATA_FILES.globalQuota, globalQuota);
    }
    
    // به‌روزرسانی اطلاعات بیمار
    patients[patientIndex] = {
      ...currentPatient,
      ...patientData,
      updatedAt: new Date().toISOString()
    };
    
    await saveToJsonFile(DATA_FILES.patients, patients);
    
    res.json({ 
      success: true,
      patient: patients[patientIndex]
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// حذف بیمار
app.delete('/api/patients/:id', async (req, res) => {
  try {
    await deletePatientCompletely(req.params.id);
    res.json({ 
      success: true 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت تاریخچه سهمیه
app.get('/api/quota-history', async (req, res) => {
  try {
    const quotaHistory = await loadFromJsonFile(DATA_FILES.quotaHistory);
    res.json(quotaHistory);
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت تاریخچه سهمیه به صورت اکسل
app.get('/api/quota-history/export', async (req, res) => {
  try {
    const quotaHistory = await loadFromJsonFile(DATA_FILES.quotaHistory);
    
    // ایجاد فایل اکسل
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('تاریخچه سهمیه');
    
    // اضافه کردن هدرها
    worksheet.columns = [
      { header: 'نام بیمار', key: 'patientName', width: 30 },
      { header: 'کد ملی', key: 'patientId', width: 15 },
      { header: 'ماه', key: 'month', width: 15 },
      { header: 'تاریخ', key: 'date', width: 15 },
      { header: 'مقدار', key: 'amount', width: 10 },
      { header: 'عملیات', key: 'operation', width: 15 },
      { header: 'زمان ثبت', key: 'createdAt', width: 20 }
    ];
    
    // اضافه کردن داده‌ها
    quotaHistory.forEach(entry => {
      worksheet.addRow({
        patientName: entry.patientName || '',
        patientId: entry.patientId || '',
        month: entry.month || '',
        date: entry.date || '',
        amount: entry.amount || '',
        operation: entry.operation === 'add' ? 'افزایش' : 'کاهش',
        createdAt: new Date(entry.createdAt).toLocaleString('fa-IR')
      });
    });
    
    // تنظیم هدر برای دانلود
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=quota_history.xlsx'
    );
    
    // ارسال فایل
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting quota history:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// افزودن سهمیه جدید به بیمار
app.post('/api/patients/:id/quota', async (req, res) => {
  try {
    const { month, date, amount, operation } = req.body;
    
    if (!month || !date || !operation) {
      throw new Error('تمام فیلدها الزامی هستند');
    }
    
    const amountNum = parseInt(amount);
    if (isNaN(amountNum)) {
      throw new Error('مقدار سهمیه باید عدد باشد');
    }
    
    if (!['add', 'subtract'].includes(operation)) {
      throw new Error('عملیات نامعتبر');
    }
    
    const patients = await loadFromJsonFile(DATA_FILES.patients);
    const quotaHistory = await loadFromJsonFile(DATA_FILES.quotaHistory);
    
    const patientIndex = patients.findIndex(p => p._id === req.params.id);
    if (patientIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: 'بیمار یافت نشد' 
      });
    }
    
    const patient = patients[patientIndex];
    
    // مدیریت سهمیه کل برای عملیات کاهش
    if (operation === 'subtract') {
      const globalQuota = await manageGlobalQuota();
      
      if (globalQuota.drugs[patient.drug]) {
        globalQuota.drugs[patient.drug].totalQuota += amountNum;
        globalQuota.drugs[patient.drug].lastUpdated = new Date().toISOString().split('T')[0];
        await saveToJsonFile(DATA_FILES.globalQuota, globalQuota);
      }
    }
    
    // به‌روزرسانی سهمیه بیمار
    if (operation === 'add') {
      patients[patientIndex].quota += amountNum;
    } else {
      patients[patientIndex].quota -= amountNum;
    }
    
    // ذخیره تغییرات بیمار
    await saveToJsonFile(DATA_FILES.patients, patients);
    
    // ثبت در تاریخچه سهمیه
    const historyEntry = {
      patientId: req.params.id,
      patientName: patient.fullName,
      month,
      date,
      amount: amountNum,
      operation,
      createdAt: new Date().toISOString()
    };
    
    quotaHistory.unshift(historyEntry);
    await saveToJsonFile(DATA_FILES.quotaHistory, quotaHistory);
    
    res.json({ 
      success: true,
      patient: patients[patientIndex]
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ثبت تحویل دارو
app.post('/api/drug-delivery', async (req, res) => {
  try {
    const deliveryData = req.body;
    
    validateDeliveryData(deliveryData);
    
    const deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery, []);
    
    // تاریخ شمسی
    const persianDate = getPersianDate();
    const currentDate = new Date();
    const currentMonth = persianDate.split(' ')[1]; // ماه شمسی
    const currentYear = currentDate.getFullYear();
    
    const newDelivery = {
      ...deliveryData,
      _id: Date.now().toString(),
      deliveryDate: currentDate.toISOString(),
      persianDate: persianDate,
      month: currentMonth,
      year: currentYear,
      gregorianMonth: currentDate.getMonth() + 1,
      gregorianYear: currentYear,
      deliveryTime: currentDate.toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran' })
    };
    
    deliveries.push(newDelivery);
    await saveToJsonFile(DATA_FILES.drugDelivery, deliveries);
    
    // به‌روزرسانی گزارش ماهانه
    await updateMonthlyReport(newDelivery);
    
    res.json({ 
      success: true, 
      delivery: newDelivery 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت تاریخچه تحویل دارو
app.get('/api/drug-delivery', async (req, res) => {
  try {
    const { recordNumber, nationalCode } = req.query;
    let deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery, []);
    
    if (recordNumber) {
      deliveries = deliveries.filter(d => d.recordNumber === recordNumber);
    } else if (nationalCode) {
      deliveries = deliveries.filter(d => d.nationalCode === nationalCode);
    }
    
    res.json(deliveries);
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت تاریخچه تحویل دارو به صورت اکسل
app.get('/api/drug-delivery/export', async (req, res) => {
  try {
    const { recordNumber, nationalCode } = req.query;
    let deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery, []);
    
    if (recordNumber) {
      deliveries = deliveries.filter(d => d.recordNumber === recordNumber);
    } else if (nationalCode) {
      deliveries = deliveries.filter(d => d.nationalCode === nationalCode);
    }
    
    // ایجاد فایل اکسل
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('تحویل دارو');
    
    // اضافه کردن هدرها
    worksheet.columns = [
      { header: 'نام بیمار', key: 'patientName', width: 30 },
      { header: 'کد ملی', key: 'nationalCode', width: 15 },
      { header: 'شماره پرونده', key: 'recordNumber', width: 20 },
      { header: 'تاریخ تحویل', key: 'persianDate', width: 25 },
      { header: 'داروها', key: 'drugs', width: 40 },
      { header: 'مقادیر', key: 'quantities', width: 40 },
      { header: 'دلیل تحویل', key: 'reason', width: 40 }
    ];
    
    // اضافه کردن داده‌ها
    deliveries.forEach(delivery => {
      const drugs = delivery.drugs ? delivery.drugs.join('، ') : '';
      let quantities = '';
      if (delivery.drugQuantities) {
        quantities = Object.entries(delivery.drugQuantities)
          .map(([drug, qty]) => `${drug}: ${qty} ${drug.includes('شربت') ? 'cc' : 'عدد'}`)
          .join('، ');
      }
      
      worksheet.addRow({
        patientName: delivery.patientName || '',
        nationalCode: delivery.nationalCode || '',
        recordNumber: delivery.recordNumber || '',
        persianDate: delivery.persianDate || '',
        drugs,
        quantities,
        reason: delivery.reason || ''
      });
    });
    
    // تنظیم هدر برای دانلود
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=drug_deliveries.xlsx'
    );
    
    // ارسال فایل
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting drug deliveries:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت اطلاعات یک تحویل داروی خاص
app.get('/api/drug-delivery/:id', async (req, res) => {
  try {
    const deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery);
    const delivery = deliveries.find(d => d._id === req.params.id);
    
    if (delivery) {
      res.json(delivery);
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'تحویل دارو یافت نشد' 
      });
    }
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// به‌روزرسانی تحویل دارو
app.put('/api/drug-delivery/:id', async (req, res) => {
  try {
    const { drugs, drugQuantities, reason } = req.body;
    
    // اعتبارسنجی داده‌ها
    if (!drugs || drugs.length === 0) {
      throw new Error('حداقل یک دارو باید انتخاب شود');
    }
    
    if (!reason || reason.trim().length < 0) {
      throw new Error('دلیل تحویل باید حداقل 5 حرف داشته باشد');
    }
    
    // اعتبارسنجی داروها
    const invalidDrugs = drugs.filter(drug => !VALID_DRUGS.includes(drug));
    if (invalidDrugs.length > 0) {
      throw new Error(`داروهای نامعتبر: ${invalidDrugs.join(', ')}`);
    }
    
    // اعتبارسنجی مقادیر داروها
    if (!drugQuantities || Object.keys(drugQuantities).length !== drugs.length) {
      throw new Error('مقادیر داروها الزامی است');
    }
    
    for (const drug of drugs) {
      const quantity = parseInt(drugQuantities[drug]);
      if (isNaN(quantity)) {
        throw new Error(`مقدار نامعتبر برای ${drug}`);
      } else if (drug.includes('شربت') && (quantity < 1 || quantity > 1000)) {
        throw new Error(`مقدار شربت باید بین 1 تا 1000 سی‌سی باشد`);
      } else if (!drug.includes('شربت') && quantity < 1) {
        throw new Error(`مقدار قرص باید حداقل 1 عدد باشد`);
      }
    }
    
    const deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery);
    const deliveryIndex = deliveries.findIndex(d => d._id === req.params.id);
    
    if (deliveryIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: 'تحویل دارو یافت نشد' 
      });
    }
    
    // ذخیره اطلاعات قدیمی برای به‌روزرسانی گزارش ماهانه
    const oldDelivery = deliveries[deliveryIndex];
    
    // به‌روزرسانی تحویل دارو
    deliveries[deliveryIndex] = {
      ...oldDelivery,
      drugs,
      drugQuantities,
      reason,
      updatedAt: new Date().toISOString()
    };
    
    await saveToJsonFile(DATA_FILES.drugDelivery, deliveries);
    
    // به‌روزرسانی گزارش ماهانه
    // 1. کسر مقادیر قدیمی از گزارش ماهانه
    await updateMonthlyReport({
      ...oldDelivery,
      drugs: oldDelivery.drugs.map(drug => ({
        drug,
        quantity: -parseInt(oldDelivery.drugQuantities[drug]) || 0
      }))
    });
    
    // 2. افزودن مقادیر جدید به گزارش ماهانه
    await updateMonthlyReport(deliveries[deliveryIndex]);
    
    res.json({ 
      success: true,
      delivery: deliveries[deliveryIndex]
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت گزارش ماهانه
app.get('/api/monthly-report', async (req, res) => {
  try {
    const { month, year } = req.query;
    
    if (!month || !year) {
      throw new Error('ماه و سال الزامی است');
    }
    
    const reports = await loadFromJsonFile(DATA_FILES.monthlyReport, []);
    let report = reports.find(r => r.month === month && r.year === parseInt(year));
    
    // اگر گزارش برای این ماه وجود نداشت، یک گزارش جدید ایجاد می‌کنیم
    if (!report) {
      report = {
        month,
        year: parseInt(year),
        drugs: {},
        totalUsed: 0,
        remaining: 0,
        exceeded: 0
      };
      
      // مقداردهی اولیه برای همه داروها
      VALID_DRUGS.forEach(drug => {
        report.drugs[drug] = {
          quantity: 0,
          type: drug.includes('شربت') ? 'cc' : 'عدد'
        };
      });
    }
    
    // محاسبه مجدد مقادیر بر اساس تاریخچه تحویل دارو
    const deliveries = await loadFromJsonFile(DATA_FILES.drugDelivery, []);
    const filteredDeliveries = deliveries.filter(d => 
      d.month === month && d.year === parseInt(year)
    );
    
    // ریست کردن مقادیر گزارش
    report.totalUsed = 0;
    for (const drug in report.drugs) {
      report.drugs[drug].quantity = 0;
    }
    
    // محاسبه مقادیر بر اساس تحویل‌های این ماه
    filteredDeliveries.forEach(delivery => {
      delivery.drugs.forEach(drug => {
        if (report.drugs[drug]) {
          report.drugs[drug].quantity += parseInt(delivery.drugQuantities[drug]) || 0;
        } else {
          report.drugs[drug] = {
            quantity: parseInt(delivery.drugQuantities[drug]) || 0,
            type: drug.includes('شربت') ? 'cc' : 'عدد'
          };
        }
      });
    });
    
    // محاسبه کل استفاده شده
    report.totalUsed = Object.values(report.drugs).reduce((sum, drug) => sum + drug.quantity, 0);
    
    res.json(report);
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دانلود گزارش ماهانه به صورت اکسل
app.get('/api/monthly-report/export', async (req, res) => {
  try {
    const { month, year } = req.query;
    
    if (!month || !year) {
      throw new Error('ماه و سال الزامی است');
    }
    
    const reports = await loadFromJsonFile(DATA_FILES.monthlyReport, []);
    const monthlyReport = reports.find(r => r.month === month && r.year === parseInt(year));
    
    if (!monthlyReport) {
      throw new Error('گزارشی برای این ماه یافت نشد');
    }
    
    // ایجاد فایل اکسل
    const workbook = new excel.Workbook();
    const worksheet = workbook.addWorksheet('گزارش ماهانه');
    
    // اضافه کردن هدرها
    worksheet.columns = [
      { header: 'دارو', key: 'drug', width: 30 },
      { header: 'مقدار مصرف شده', key: 'quantity', width: 20 },
      { header: 'واحد', key: 'type', width: 15 }
    ];
    
    // اضافه کردن داده‌ها
    for (const drug in monthlyReport.drugs) {
      worksheet.addRow({
        drug,
        quantity: monthlyReport.drugs[drug].quantity,
        type: monthlyReport.drugs[drug].type
      });
    }
    
    // اضافه کردن خلاصه گزارش
    worksheet.addRow([]); // خط خالی
    worksheet.addRow({ drug: 'کل مصرف شده', quantity: monthlyReport.totalUsed, type: 'واحد' });
    
    // تنظیم هدر برای دانلود
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=monthly_report_${month}_${year}.xlsx`
    );
    
    // ارسال فایل
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting monthly report:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// دریافت اعلانات
app.get('/api/notifications', async (req, res) => {
  try {
    const notifications = await loadFromJsonFile(DATA_FILES.notifications, DEFAULT_NOTIFICATIONS);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// افزودن اعلان جدید
app.post('/api/notifications', async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) {
      throw new Error('عنوان و متن اعلان الزامی است');
    }
 
    const notifications = await loadFromJsonFile(DATA_FILES.notifications, DEFAULT_NOTIFICATIONS);
    const newNotification = {
      id: Date.now(),
      title,
      message,
      date: new Date().toISOString(),
      read: false
    };
    notifications.unshift(newNotification);
    await saveToJsonFile(DATA_FILES.notifications, notifications);
    res.json({ 
      success: true,
      notification: newNotification
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// علامت زدن اعلان به عنوان خوانده شده
app.put('/api/notifications/:id/read', async (req, res) => {
  try {
    const notifications = await loadFromJsonFile(DATA_FILES.notifications, DEFAULT_NOTIFICATIONS);
    const notificationIndex = notifications.findIndex(n => n.id === parseInt(req.params.id));
    
    if (notificationIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: 'اعلان یافت نشد' 
      });
    }
    notifications[notificationIndex].read = true;
    await saveToJsonFile(DATA_FILES.notifications, notifications);
    res.json({ 
      success: true 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

async function startServer() {
  try {
    // شروع سرور Express
    const server = app.listen(PORT, () => {
      console.log(`Application base run :  ${PORT}`);
    });
    console.log('Press CTRL+C to stop the server');
    // مدیریت خاتمه تمیز
    process.on('SIGINT', async () => {
      console.log('\nShutting down server...');
      server.close();
      process.exit();
    });
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

app.get('/api/patients/:id/quota-history', async (req, res) => {
  try {
    const quotaHistory = await loadFromJsonFile(DATA_FILES.quotaHistory);
    const patientHistory = quotaHistory.filter(item => item.patientId === req.params.id);
    
    res.json(patientHistory);
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// شروع برنامه
startServer();
