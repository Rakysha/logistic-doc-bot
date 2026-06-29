require('dotenv').config(); // Загружаем переменные из .env
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fetch = require('node-fetch');

// --- КОНФИГУРАЦИЯ ИЗ .ENV ---
const config = {
  botToken: process.env.BOT_TOKEN,
  geminiKey: process.env.GEMINI_KEY,
  paymentToken: process.env.PAYMENT_TEST_TOKEN,
  db: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT),
  }
};

const bot = new Telegraf(config.botToken);
const pool = new Pool({
  ...config.db,
  password: String(config.db.password || '')
});
const genAI = new GoogleGenerativeAI(config.geminiKey);

// --- НАСТРОЙКИ И АДМИНЫ (БД) ---
const MASTER_ADMIN_IDS = [parseInt(process.env.ADMIN_ID || 0)];

const checkIsAdmin = async (userId) => {
  if (MASTER_ADMIN_IDS.includes(parseInt(userId))) return true;
  try {
    const res = await pool.query('SELECT is_admin FROM users WHERE telegram_id = $1', [userId]);
    return res.rows[0]?.is_admin === true;
  } catch (e) { return false; }
};

const getAdminIds = async () => {
  try {
    const res = await pool.query('SELECT telegram_id FROM users WHERE is_admin = true');
    const ids = res.rows.map(r => parseInt(r.telegram_id));
    for (const masterId of MASTER_ADMIN_IDS) {
      if (!ids.includes(masterId)) ids.push(masterId);
    }
    return ids;
  } catch (e) { return [...MASTER_ADMIN_IDS]; }
};

// Хелперы для временных данных в БД (вместо Map)
const getTempData = async (userId) => {
  const res = await pool.query('SELECT temp_ui_data FROM users WHERE telegram_id = $1', [userId]);
  return res.rows[0]?.temp_ui_data || {};
};

const setTempData = async (userId, data) => {
  const current = await getTempData(userId);
  const updated = { ...current, ...data };
  await pool.query('UPDATE users SET temp_ui_data = $1 WHERE telegram_id = $2', [JSON.stringify(updated), userId]);
};

const clearTempData = async (userId) => {
  await pool.query('UPDATE users SET temp_ui_data = $1 WHERE telegram_id = $2', [null, userId]);
};

const getSetting = async (key, defaultVal = '') => {
  try {
    const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return res.rows[0] ? res.rows[0].value : defaultVal;
  } catch (e) { return defaultVal; }
};

// Универсальный fetch с таймаутом
async function fetchWithTimeout(url, options = {}, timeout = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// Защита от спама альбомами
const processedMediaGroups = new Set();

// Парсинг JSON от ИИ
const parseAiJson = (responseText) => {
  try {
    const text = responseText.replace(/```(json|JSON)?/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('AI JSON Parse Error:', e.message, 'Text:', responseText);
    return null;
  }
};

// === ВАЛИДАТОРЫ ДЛЯ ПОСТ-ОБРАБОТКИ OCR ===

// Валидация ИНН по контрольной сумме (стандарт ФНС)
function validateINN(inn) {
  if (!inn) return '';
  const cleaned = String(inn).replace(/\D/g, '');
  if (cleaned.length === 10) {
    const w = [2,4,10,3,5,9,4,6,8];
    const sum = w.reduce((s, k, i) => s + k * parseInt(cleaned[i]), 0);
    return (sum % 11 % 10) === parseInt(cleaned[9]) ? cleaned : '';
  }
  if (cleaned.length === 12) {
    const w1 = [7,2,4,10,3,5,9,4,6,8];
    const w2 = [3,7,2,4,10,3,5,9,4,6,8];
    const s1 = w1.reduce((s, k, i) => s + k * parseInt(cleaned[i]), 0);
    const s2 = w2.reduce((s, k, i) => s + k * parseInt(cleaned[i]), 0);
    return (s1 % 11 % 10) === parseInt(cleaned[10]) && (s2 % 11 % 10) === parseInt(cleaned[11]) ? cleaned : '';
  }
  return '';
}

// Нормализация госномера: латиница → кириллица, очистка
function normalizePlate(plate) {
  if (!plate) return '';
  const map = { 'A':'А','B':'В','C':'С','E':'Е','H':'Н','K':'К','M':'М','O':'О','P':'Р','T':'Т','X':'Х','Y':'У' };
  let clean = String(plate).replace(/[\s\-\.]/g, '').toUpperCase();
  clean = clean.replace(/[A-Z]/g, ch => map[ch] || ch);
  // Проверка формата: буква + 3 цифры + 2 буквы + 2-3 цифры региона
  if (/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/.test(clean)) return clean;
  // Прицеп: 2 буквы + 4 цифры + 2-3 цифры региона
  if (/^[АВЕКМНОРСТУХ]{2}\d{4}\d{2,3}$/.test(clean)) return clean;
  // Если хоть что-то похожее на номер — вернём как есть, пользователь поправит
  if (clean.length >= 6 && /\d/.test(clean)) return clean;
  return '';
}

// Нормализация массы: "20.5 тонн" → "20.5", "1100 кг" → "1.1"
function normalizeWeight(weight) {
  if (!weight) return '';
  let s = String(weight).replace(/,/g, '.').replace(/\s+/g, '');
  const isKg = /кг|kg/i.test(s);
  s = s.replace(/[^\d\.]/g, '');
  const num = parseFloat(s);
  if (isNaN(num) || num <= 0) return '';
  return isKg && num > 100 ? (num / 1000).toFixed(2).replace(/\.?0+$/, '') : String(num);
}

// Валидация ФИО (минимум фамилия)
function validateFIO(fio) {
  if (!fio) return '';
  const cleaned = String(fio).trim();
  if (cleaned.length < 2 || !/[а-яА-ЯёЁ]/.test(cleaned)) return '';
  return cleaned;
}


async function sbisAuthenticate(login, password) {
  if (login.toLowerCase() === 'dev') return { success: true, sid: "test_session_id_for_development" };

  try {
    const response = await fetchWithTimeout('https://online.sbis.ru/auth/service/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "СБИС.Аутентифицировать",
        params: { "Параметры": { "Логин": login, "Пароль": password } },
        id: "0"
      })
    });
    const result = await response.json();
    if (result.error) return { success: false, message: result.error.message };
    return { success: true, sid: result.result };
  } catch (e) {
    return { success: false, message: 'Ошибка СБИС: ' + (e.name === 'AbortError' ? 'Таймаут' : 'Сервер недоступен') };
  }
}

async function sbisSendETrN(sid, data) {
  try {
    // Разбиваем ФИО на части для СБИСа (Фамилия Имя Отчество)
    const fioParts = (data.driver?.fio || 'Неизвестный Водитель').split(' ');
    const lastName = fioParts[0] || 'Неуказано';
    const firstName = fioParts[1] || 'Неуказано';
    const middleName = fioParts.slice(2).join(' ') || '';

    // =====================================================================
    // ШАГ 1: Генерируем правильный XML через сервер СБИСа (Титул 1)
    // =====================================================================
    const generatePayload = {
      jsonrpc: "2.0",
      method: "СБИС.СгенерироватьВложение",
      params: {
        "Документ": {
          "Вложение": {
            "Тип": "ЭТрН",
            "Подтип": "1110339", // Титул грузоотправителя (Т1)
            "ВерсияФормата": "5.01",
            "Подстановка": {
              "1110339": {
                "Файл": {
                  "Документ": {
                    "СодИнфГО": {
                      "СвГО": {
                        "РекИдентГО": {
                          "ИдСв": { "СвЮЛУч": { "НаимОрг": data.shipper?.name || "Не указано", "ИННЮЛ": data.shipper?.inn || "" } }
                        }
                      },
                      "СвГП": {
                        "РекИдентГП": {
                          "ИдСв": { "СвЮЛУч": { "НаимОрг": data.consignee?.name || "Не указано", "ИННЮЛ": data.consignee?.inn || "" } }
                        }
                      },
                      "СвПер": {
                        "ИдСв": {
                          "СвЮЛУч": { "НаимОрг": data.carrier?.name || "Не указано", "ИННЮЛ": data.carrier?.inn || "" }
                        }
                      },
                      "СвВодит": {
                        "ФИО": {
                          "Фамилия": lastName,
                          "Имя": firstName,
                          "Отчество": middleName
                        },
                        "НомВУ": data.driver?.license || "Не указано"
                      },
                      "СвТС": {
                        "ТС": { "РегНомер": data.vehicle?.plate || "Не указано" }
                      },
                      "СвГруз": {
                        "ОпГруз": [{
                          "НаимГруз": data.cargo?.name || "Груз",
                          "ПлМасГруз": {
                            "МасБрутЗнач": data.cargo?.weight || "0"
                          }
                        }]
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      id: "1"
    };

    const genResponse = await fetchWithTimeout('https://tms.saby.ru/service/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json-rpc;charset=utf-8',
        'X-SBISSessionID': sid
      },
      body: JSON.stringify(generatePayload)
    });

    const genResult = await genResponse.json();
    
    // Проверка на протухшую сессию при генерации
    if (genResult.error) {
      const errMsg = genResult.error.details || genResult.error.message || '';
      if (errMsg.includes('авторизован') || errMsg.includes('сессия') || errMsg.includes('401')) {
        return { success: false, isAuthError: true, message: 'Сессия СБИС истекла' };
      }
      return { success: false, message: 'Ошибка генерации формы: ' + errMsg };
    }

    // СБИС отдает сгенерированный файл в формате Base64
    // В зависимости от ответа, он может лежать в result или result.ДвоичныеДанные
    const base64XML = typeof genResult.result === 'string' ? genResult.result : genResult.result?.ДвоичныеДанные;

    if (!base64XML) {
      return { success: false, message: 'СБИС не вернул файл вложения' };
    }

    // =====================================================================
    // ШАГ 2: Создаем сам документ прикрепляем наш сгенерированный Base64
    // =====================================================================
    const savePayload = {
      jsonrpc: "2.0",
      method: "СБИС.ЗаписатьДокумент",
      params: {
        "Документ": {
          "Идентификатор": "", // Пусто, так как создаем новый
          "Тип": "ConsignmentNote", // Строго этот тип из документации
          "Регламент": {
            "Название": "Транспортная накладная"
          },
          "Вложение": [
            {
              "Файл": {
                "Имя": "Titul_Gruzootpravitelya.xml",
                "ДвоичныеДанные": base64XML
              }
            }
          ]
        }
      },
      id: "2"
    };

    const saveResponse = await fetchWithTimeout('https://tms.saby.ru/service/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json-rpc;charset=utf-8',
        'X-SBISSessionID': sid
      },
      body: JSON.stringify(savePayload)
    });

    const saveResult = await saveResponse.json();
    
    if (saveResult.error) {
      const errMsg = saveResult.error.details || saveResult.error.message || '';
      if (errMsg.includes('авторизован') || errMsg.includes('сессия') || errMsg.includes('401')) {
        return { success: false, isAuthError: true, message: 'Сессия СБИС истекла' };
      }
      return { success: false, message: 'Ошибка сохранения накладной: ' + errMsg };
    }

    // Успех! Возвращаем идентификатор созданного документа
    return { success: true, result: saveResult.result.Идентификатор };

  } catch (e) {
    return { success: false, message: 'Ошибка связи со СБИС: ' + (e.name === 'AbortError' ? 'Таймаут' : e.message) };
  }
}

// Инициализация Gemini (две модели: для JSON для Текста)
const SAFETY_OFF = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const modelJson = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
  safetySettings: SAFETY_OFF
});

const modelText = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { temperature: 0.1 },
  safetySettings: SAFETY_OFF
});

// Прокси-объекты для замены Map на БД (для минимальных правок в коде)
const dataBatch = {
  async get(fullKey) {
    const key = String(fullKey);
    const userId = key.split('_')[0];
    const subKey = key.split('_').slice(1).join('_');
    const data = await getTempData(userId);
    return data[subKey];
  },
  async set(fullKey, value) {
    const key = String(fullKey);
    const userId = key.split('_')[0];
    const subKey = key.split('_').slice(1).join('_');
    await setTempData(userId, { [subKey]: value });
  },
  async delete(fullKey) {
    const key = String(fullKey);
    const userId = key.split('_')[0];
    const subKey = key.split('_').slice(1).join('_');
    const data = await getTempData(userId);
    delete data[subKey];
    await pool.query('UPDATE users SET temp_ui_data = $1 WHERE telegram_id = $2', [JSON.stringify(data), userId]);
  }
};

const pendingTemplate = {
  async get(userId) {
    const data = await getTempData(userId);
    return data.pending_template;
  },
  async set(userId, fileId) {
    await setTempData(userId, { pending_template: fileId });
  },
  async delete(userId) {
    const data = await getTempData(userId);
    delete data.pending_template;
    await pool.query('UPDATE users SET temp_ui_data = $1 WHERE telegram_id = $2', [JSON.stringify(data), userId]);
  }
};
const mediaGroupTimers = new Map();

// --- ТИПЫ ПРИЦЕПОВ / ТС ---
const TRAILER_TYPES = {
  container: { label: '📦 Контейнер', needsCount: true, needsTemp: false },
  cement: { label: '🏗️ Цементовоз', needsCount: false, needsTemp: false },
  ref: { label: '🧊 Рефрижератор', needsCount: true, needsTemp: true }
};

// Подсказки для полей груза по типу ТС
const CARGO_PROMPTS = {
  ref: { name: 'название груза (напр.: Мороженое, Мясо, Рыба)', weight: 'вес в тоннах (напр.: 5.2)', count: 'кол-во паллет', temp: 'температурный режим (напр.: -18°C)' },
  tent: { name: 'название груза (напр.: Бытовая техника, Одежда)', weight: 'вес в тоннах (напр.: 12.0)', count: 'кол-во паллет/мест' },
  cement: { name: 'вид цемента (напр.: ЦЕМ II 32,5 / Портландцемент М400)', weight: 'вес нетто в тоннах (напр.: 25.0)' },
  grain: { name: 'культуру (напр.: Пшеница 3кл, Кукуруза, Соя)', weight: 'вес в тоннах (напр.: 24.5)' },
  dump: { name: 'груза (напр.: Щебень фр.20-40, Песок, Грунт)', weight: 'вес в тоннах (напр.: 20.0)' },
  tanker: { name: 'груза (напр.: Молоко сырое, Нефтепродукт, Вода)', weight: 'объём в тоннах или литрах' },
  timber: { name: 'породу вид (напр.: Сосна хлысты, Берёза пиловочник)', weight: 'объём в м³ (напр.: 40.0)', count: 'кол-во брёвен/хлыстов' },
  container: { name: 'название груза (напр.: Электроника, Запчасти, Одежда)', weight: 'вес брутто в тоннах (напр.: 14.5)', count: 'номер размер контейнера (напр.: MSCU1234567 / 40HC)' },
  other: { name: 'груза', weight: 'вес в тоннах', count: 'кол-во мест' },
};
const cp = (trailerKey, field) => (CARGO_PROMPTS[trailerKey] || CARGO_PROMPTS.other)[field] || field;

// Хелпер для вызова агента с повторами
const callAiWithRetry = async (model, content, retries = 3, delay = 1500) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await model.generateContent(content);
    } catch (e) {
      if ((e.status === 503 || e.status === 429) && i < retries - 1) {
        console.log(`[AI Retry] Ошибка ${e.status}, попытка ${i + 1}/${retries}...`);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw e;
    }
  }
};

// Функция для анимации статуса (смена текста)
const animateStatus = (ctx, messageId, steps, interval = 3500) => {
  let step = 0;
  return setInterval(async () => {
    step = (step + 1) % steps.length;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, steps[step], { parse_mode: 'Markdown' });
    } catch (e) { /* Игнорируем ошибки при редактировании */ }
  }, interval);
};

// АВТО-ЗАГРУЗКА БАЗЫ ДАННЫХ
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        full_name TEXT,
        state VARCHAR(50) DEFAULT 'IDLE',
        current_template_id TEXT,
        is_new_template BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT,
        file_id TEXT,
        name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_new_template BOOLEAN DEFAULT FALSE;
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='sbis_sid') THEN
          ALTER TABLE users ADD COLUMN sbis_sid TEXT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_extracted_data') THEN
          ALTER TABLE users ADD COLUMN last_extracted_data JSONB; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='plan') THEN
          ALTER TABLE users ADD COLUMN plan VARCHAR(20) DEFAULT 'trial'; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='etrn_count') THEN
          ALTER TABLE users ADD COLUMN etrn_count INT DEFAULT 0; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='state_updated_at') THEN
          ALTER TABLE users ADD COLUMN state_updated_at TIMESTAMP DEFAULT NOW(); END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='custom_limit') THEN
          ALTER TABLE users ADD COLUMN custom_limit INT DEFAULT 0; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_admin') THEN
          ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='temp_ui_data') THEN
          ALTER TABLE users ADD COLUMN temp_ui_data JSONB; END IF;
      END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT
      );
    `);

    console.log('✅ БД загружена таблицы созданы.');

    // Таймаут сессий: сбрасываем зависших пользователей каждые 30 мин
    setInterval(async () => {
      try {
        await pool.query(`
          UPDATE users SET state = 'IDLE'
          WHERE state != 'IDLE'
          AND state_updated_at < NOW() - INTERVAL '2 hours'
        `);
      } catch (e) { console.error('[Timeout cleanup]', e.message); }
    }, 30 * 60 * 1000);

  } catch (err) { console.error('❌ Ошибка инициализации БД:', err.message); }
};

// --- ХЕЛПЕРЫ ДЛЯ НАВИГАЦИИ ---

const esc = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sendMainMenu = async (ctx) => {
  const userId = ctx.from.id;
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['IDLE', userId]);
  await clearTempData(userId);

  const { hasLimit } = await checkLimit(userId);

  const menuText = 
    `🏢 *E-Транспорт | Официальный шлюз ЭТрН*\n\n` +
    `Интеграционный модуль для автоматического формирования электронных транспортных накладных в системе СБИС (Saby).\n\n` +
    `📊 *Ваш статус:* ${hasLimit ? '🟢 Активен' : '🔴 Лимит исчерпан'}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `*Доступные режимы работы:*\n` +
    `📸 *Smart OCR* — мгновенное распознавание бумажной ТТН с помощью ИИ (рекомендуется).\n` +
    `✍️ *Ручной ввод* — пошаговое заполнение карточки рейса.\n\n` +
    `_Выберите действие:_`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Создать ЭТрН', 'create_etrn')],
    [Markup.button.callback('💳 Тарифы', 'pricing_btn'), Markup.button.callback('🛠 Поддержка', 'support_btn')],
    [Markup.button.callback('⚖️ Юр. справка', 'legal_btn')]
  ]);

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    return ctx.replyWithMarkdown(menuText, keyboard);
  }
  // Чтобы убрать "залипшую" клавиатуру, отправляем удаление отдельным вызовом (если это не callback)
  await ctx.reply('🔄', Markup.removeKeyboard()).then(m => safeDelete(ctx, m.message_id)).catch(() => { });
  return ctx.replyWithMarkdown(menuText, keyboard);
};

const showTemplates = async (ctx) => {
  const res = await pool.query('SELECT id, name FROM templates WHERE telegram_id = $1 ORDER BY created_at DESC', [ctx.from.id]);
  const buttons = res.rows.map(t => [Markup.button.callback(`📄 ${t.name}`, `select_template:${t.id}`)]);
  buttons.push([Markup.button.callback('🚫 Отмена', 'cancel')]);

  const text = '🗂 *Твои шаблоны:*\nВыбери нужный из списка ниже:';
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    try {
      return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {
      return ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    }
  }
  return ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
};

const showPricing = async (ctx) => {
  const userId = ctx.from.id;
  const res = await pool.query('SELECT plan, etrn_count, custom_limit FROM users WHERE telegram_id = $1', [userId]);
  const user = res.rows[0] || { plan: 'trial', etrn_count: 0 };

  const count = user.etrn_count || 0;
  const plan = user.plan || 'trial';

  let statusLine = '';
  if (plan === 'trial') {
    const left = Math.max(0, 3 - count);
    statusLine = left > 0
      ? `\n📊 *Ваш статус:* Пробный период — осталось \`${left}/3\` ЭТрН 🟡`
      : `\n📊 *Ваш статус:* Пробный период — \`ИСЧЕРПАН\` 🔴`;
  } else if (plan === 'custom') {
    const lim = user.custom_limit || 0;
    const left = Math.max(0, lim - count);
    statusLine = `\n📊 *Ваш статус:* Индивидуальный пакет — осталось \`${left}/${lim}\` ЭТрН 🟢`;
  } else {
    const limits = { pack_10: 10, pack_100: 100, pack_300: 300 };
    const lim = limits[plan] || 0;
    const left = Math.max(0, lim - count);
    statusLine = `\n📊 *Ваш статус:* Осталось \`${left}/${lim}\` ЭТрН 🟢`;
  }

  const text =
    `💳 *Тарифы ETrN Bot*${statusLine}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🚛 *Мы работаем только с логистическими компаниями транспортными предприятиями.*\n\n` +
    `Бот автоматизирует создание электронных транспортных накладных (ЭТрН) через СБИС/Saby — вы фотографируете бумажную ТТН, ИИ распознаёт данные формирует черновик за секунды.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `💼 *Корпоративный пакет*\n` +
    `100 ЭТрН в месяц — *5 000 ₽*\n\n` +
    `✅ Безлимитный доступ для команды\n` +
    `✅ Поддержка всех типов ТС (Реф, Контейнер, Цемент)\n` +
    `✅ Распознавание ИИ + ручное редактирование\n` +
    `✅ Прямая интеграция со СБИС (Saby)\n\n` +
    `_По вопросам индивидуальных условий: ������ ��������� (������ � .env)_`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Запросить корпоративный доступ', 'request_access')],
    [Markup.button.callback('🏠 В меню', 'cancel')]
  ]);

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    try {
      return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
      return ctx.replyWithMarkdown(text, keyboard);
    }
  }
  return ctx.replyWithMarkdown(text, keyboard);
};

const showSupport = async (ctx) => {
  const text = `🛠 *Центр поддержки*\n\n` +
    `У вас возник вопрос или техническая ошибка? Вы можете:\n\n` +
    `1️⃣ Написать нам напрямую через бота (анонимно конфиденциально).\n` +
    `2️⃣ Связаться с администраторами в Telegram:\n` +
    `👤 ������ ��������� (������ � .env)\n` +
    `👤 \n\n` +
    `_Нажмите кнопку ниже, чтобы отправить сообщение поддержке:_`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Написать обращение', 'write_support')],
    [Markup.button.callback('🏠 В меню', 'cancel')]
  ]);

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    try {
      return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
      return ctx.replyWithMarkdown(text, keyboard);
    }
  }
  return ctx.replyWithMarkdown(text, keyboard);
};

const showLegal = async (ctx) => {
  const text = `⚖️ *Юридическая информация*\n\n` +
    `Используя данного бота, вы соглашаетесь с условиями оферты правилами обработки персональных данных.\n\n` +
    `📍 *Пользовательское соглашение:*\n` +
    `• Бот является инструментом автоматизации не заменяет официальные системы ЭДО (СБИС/Saby).\n` +
    `• Ответственность за корректность данных несет пользователь.\n` +
    `• Сервис предоставляется "как есть".\n\n` +
    `📄 Полный текст соглашения доступен по ссылке: [etrn-docs.ru/terms](https://example.com)`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🏠 В меню', 'cancel')]]);

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    try {
      return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
      return ctx.replyWithMarkdown(text, keyboard);
    }
  }
  return ctx.replyWithMarkdown(text, keyboard);
};

const checkLimit = async (userId) => {
  const userRow = (await pool.query('SELECT plan, etrn_count, custom_limit FROM users WHERE telegram_id = $1', [userId])).rows[0];
  const LIMITS = { trial: 3, pack_10: 10, pack_100: 100, pack_300: 300 };
  const plan = userRow?.plan || 'trial';
  const count = userRow?.etrn_count || 0;
  const limit = plan === 'custom' ? (userRow?.custom_limit || 0) : (LIMITS[plan] ?? 3);
  return { hasLimit: count < limit, plan, limit, count };
};

// Хелпер для получения данных (Память -> БД)
const getExtractedData = async (userId) => {
  const cached = await dataBatch.get(`${userId}_result`);
  if (cached) return cached;

  const res = await pool.query('SELECT last_extracted_data FROM users WHERE telegram_id = $1', [userId]);
  if (res.rows[0]?.last_extracted_data) {
    const data = res.rows[0].last_extracted_data;
    await dataBatch.set(`${userId}_result`, data);
    return data;
  }
  return null;
};

// Хелпер для удаления кнопок у сообщения
const removeButtons = async (ctx, messageId) => {
  try {
    await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, messageId, null, { inline_keyboard: [] });
  } catch (e) { /* Игнорируем */ }
};

// Хелпер для безопасного удаления сообщения
const safeDelete = async (ctx, messageId) => {
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch (e) { /* Игнорируем */ }
};

// Хелпер: показать финальный отчёт для подтверждения
const showReview = async (ctx, data, trailerKey) => {
  const { doc = {}, driver = {}, vehicle = {}, cargo = {}, shipper = {}, consignee = {}, carrier = {}, payer = {}, route = {} } = data;
  const trailer = TRAILER_TYPES[trailerKey] || { label: '📋 Транспорт', needsCount: true, needsTemp: false };

  // Умная функция для проверки полей (если пусто — подсвечиваем красным)
  const val = (text) => text !== undefined && text !== null && String(text).trim() !== '' && String(text) !== '—' ? `\`${text}\`` : '🔴 *НЕ УКАЗАНО*';
  // Опциональное поле — не подсвечивается красным если пусто
  const optVal = (text) => text !== undefined && text !== null && String(text).trim() !== '' && String(text) !== '—' ? `\`${text}\`` : '—';

  const weightFormatted = cargo.weight && cargo.weight !== '—' ? `${cargo.weight} т.` : null;
  let cargoLines = `• Груз: ${val(cargo.name)}\n• Масса: ${val(weightFormatted)}\n`;
  if (cargo.unit) cargoLines += `• Ед.изм: \`${cargo.unit}\`\n`;
  if (trailer.needsCount) cargoLines += `• Мест/Штук: ${val(cargo.count)}\n`;
  if (trailer.needsTemp) cargoLines += `• Температура: ${val(cargo.temp)}\n`;
  if (cargo.container_number) cargoLines += `• Контейнер: \`${cargo.container_number}\`\n`;

  // Строка маршрута
  let routeLines = '';
  if (route.loading_point || route.unloading_point) {
    routeLines = `\n🗺 *Маршрут*\n` +
      `• Погрузка: ${optVal(route.loading_point)}\n` +
      `• Выгрузка: ${optVal(route.unloading_point)}\n`;
  }

  // Строка прицепа
  let trailerLine = '';
  if (vehicle.trailer_plate || vehicle.trailer_brand) {
    trailerLine = `• Прицеп: ${optVal(vehicle.trailer_brand)} | ${optVal(vehicle.trailer_plate)}\n`;
  }

  const report = 
    `📑 *ЧЕРНОВИК ЭТрН (СВЕРКА ДАННЫХ)*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    (doc.number || doc.date ? `📄 *Документ:* №${optVal(doc.number)} от ${optVal(doc.date)}\n` : '') +
    `🚛 *Спецификация ТС:* ${trailer.label}\n\n` +
    `👤 *Водитель Транспорт*\n` +
    `• ФИО: ${val(driver.fio)} | ВУ: ${val(driver.license)}\n` +
    `• ТС: ${val(vehicle.brand)} | Госномер: ${val(vehicle.plate)}\n` +
    trailerLine +
    `\n📦 *Груз*\n` + cargoLines +
    routeLines +
    `\n🏢 *Контрагенты*\n` +
    `• Отправитель: ${val(shipper.name)}\n` +
    `  🔢 ИНН: ${val(shipper.inn)}\n` +
    `  📍 Адрес: ${val(shipper.address)}\n` +
    `• Получатель: ${val(consignee.name)}\n` +
    `  🔢 ИНН: ${val(consignee.inn)}\n` +
    `  📍 Адрес: ${val(consignee.address)}\n` +
    `• Перевозчик: ${val(carrier.name)}\n` +
    `  🔢 ИНН: ${val(carrier.inn)}\n` +
    (payer.name ? `• Плательщик: ${optVal(payer.name)}\n  🔢 ИНН: ${optVal(payer.inn)}\n` : '') +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ _Проверьте поля с отметкой 🔴. Если данные корректны, нажмите «Подтвердить отправку»._`;

  return ctx.reply(report, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Подтвердить отправку в СБИС', 'final_send')],
      [Markup.button.callback('✏️ Внести правки', 'edit_data')],
      [Markup.button.callback('🗑 Отменить', 'cancel')]
    ])
  });
};

// --- ЛОГИКА БОТА ---

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const res = await pool.query('SELECT state FROM users WHERE telegram_id = $1', [userId]);

  if (res.rows.length === 0) {
    await pool.query('INSERT INTO users (telegram_id, full_name) VALUES ($1, $2)', [userId, ctx.from.first_name]);
    return sendMainMenu(ctx);
  }

  const currentState = res.rows[0].state;
  if (currentState !== 'IDLE' && currentState.startsWith('WAITING_') && currentState !== 'WAITING_SUPPORT_TEXT') {
    return ctx.replyWithMarkdown(
      `⚠️ *У вас есть незавершенная ЭТрН!*\n\nВы остановились на одном из шагов оформления. Желаете продолжить с сохраненными данными или начать заново?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('▶️ Продолжить', 'resume_draft')],
        [Markup.button.callback('🗑 Сбросить начать заново', 'cancel')]
      ])
    );
  }

  return sendMainMenu(ctx);
});

bot.action('resume_draft', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const currentData = (await getExtractedData(userId)) || {};
  const tKey = currentData.trailerKey || 'container';

  await dataBatch.set(`${userId}_result`, currentData);
  await dataBatch.set(`${userId}_trailer`, tKey);

  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['IDLE', userId]);

  await ctx.reply('🔄 *Восстановление черновика...*\nСейчас вы увидите всё, что успели заполнить. Если чего-то не хватает, нажмите «Редактировать».', { parse_mode: 'Markdown' });
  return showReview(ctx, currentData, tKey);
});

bot.command('pricing', showPricing);
bot.action('pricing_btn', showPricing);

bot.command('create', async (ctx) => {
  const userId = ctx.from.id;
  const { hasLimit, plan, limit } = await checkLimit(userId);

  if (!hasLimit) {
    return ctx.replyWithMarkdown(
      `🔒 *Лимит исчерпан*\n\n` +
      `На тарифе *${plan}* доступно *${limit} ЭТрН*.\n` +
      `Для продолжения работы обратитесь к администрации: ������ ��������� (������ � .env) или `,
      Markup.inlineKeyboard([
        [Markup.button.callback('💳 Посмотреть тарифы', 'pricing_btn')],
        [Markup.button.callback('🏠 В меню', 'cancel')]
      ])
    );
  }

  await pool.query('UPDATE users SET state = $1, state_updated_at = NOW() WHERE telegram_id = $2', ['CHOOSING_PLATFORM', userId]);

  const platformMsg = `
🚀 *Новая ЭТрН*
Выбери платформу, через которую будем отправлять документы:
  `;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔹 СБИС (Saby)', 'platform:sbis')],
    [Markup.button.callback('🔸 Контур.Диадок', 'platform:diadok')],
    [Markup.button.callback('🔹 Такском', 'platform:taxcom')],
    [Markup.button.callback('🚫 Отмена', 'cancel')]
  ]);

  return ctx.replyWithMarkdown(platformMsg, keyboard);
});
bot.command('support', showSupport);
bot.action('support_btn', showSupport);
bot.action('legal_btn', showLegal);

bot.action('write_support', async (ctx) => {
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_SUPPORT_TEXT', ctx.from.id]);
  return ctx.reply('💬 *Введите ваше сообщение для поддержки:*\n\nОпишите проблему или задайте вопрос. Вы можете прикрепить фото в следующем сообщении (пока поддерживается только текст).', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
  });
});

bot.command('legal', showLegal);

bot.command('addlimit', async (ctx) => {
  const userId = ctx.from.id;
  // Проверяем, является ли пользователь админом
  if (!(await checkIsAdmin(userId))) return;

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('❌ Использование: `/addlimit <кол-во_ЭТрН> <id_пользователя> [сумма_в_рублях]`', { parse_mode: 'Markdown' });
  }

  const limitAmount = parseInt(args[0]);
  const targetUserId = parseInt(args[1]);
  const price = args[2] ? parseInt(args[2]) : 0;

  if (isNaN(limitAmount) || isNaN(targetUserId)) {
    return ctx.reply('❌ Ошибка: количество ID должны быть числами.');
  }

  // UPSERT: Создаем юзера, если его нет, или обновляем существующего
  await pool.query(`
    INSERT INTO users (telegram_id, plan, custom_limit, etrn_count, state)
    VALUES ($1, 'custom', $2, 0, 'IDLE')
    ON CONFLICT (telegram_id) 
    DO UPDATE SET plan = 'custom', custom_limit = $2, etrn_count = 0, state = 'IDLE'
  `, [targetUserId, limitAmount]);

  await ctx.reply(`✅ Пользователю \`${targetUserId}\` успешно начислен индивидуальный пакет на ${limitAmount} ЭТрН.`, { parse_mode: 'Markdown' });

  try {
    await ctx.telegram.sendMessage(targetUserId, `🎉 *Ваш баланс пополнен!*\nВам начислен пакет на *${limitAmount} ЭТрН*. Приятной работы!`, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply(`⚠️ Сообщение пользователю не доставлено (возможно, он заблокировал бота).`);
  }

  // Интеграция с Google Таблицами через БД
  const GOOGLE_SHEETS_WEBHOOK_URL = await getSetting('google_sheets_webhook');

  if (GOOGLE_SHEETS_WEBHOOK_URL) {
    try {
      // Получаем инфо о юзере для обогащения таблицы
      const uInfo = (await pool.query('SELECT full_name, username, phone, company_name FROM users WHERE telegram_id = $1', [targetUserId])).rows[0] || {};

      await fetchWithTimeout(GOOGLE_SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'Пополнение тарифа',
          admin_id: userId,
          user_id: targetUserId,
          name: uInfo.full_name || 'Без имени',
          username: uInfo.username ? `@${uInfo.username}` : 'Скрыт',
          platform_phone: uInfo.phone ? `СБИС: ${uInfo.phone}` : 'Ещё не входил',
          company: uInfo.company_name || 'Ещё не оформлял',
          limit_amount: limitAmount,
          bot_name: 'ETrN_Bot',
          price: price,
          date: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
        })
      });
      await ctx.reply('✅ Данные успешно отправлены в Google Таблицу бухгалтерии.');
    } catch (e) {
      console.error('[Webhook Error] Не удалось отправить данные в Google Sheets:', e.message);
      await ctx.reply(`❌ Ошибка при отправке данных в Google Таблицу: ${e.name === 'AbortError' ? 'Таймаут' : 'Сервер недоступен'}`);
    }
  } else {
    await ctx.reply('ℹ️ Данные в Google Таблицу не отправлены, так как вебхук не задан. Используйте /setwebhook <url>');
  }
});

bot.command('makeadmin', async (ctx) => {
  const userId = ctx.from.id;
  if (!MASTER_ADMIN_IDS.includes(userId)) return; // Только владелец может назначать админов
  const args = ctx.message.text.split(' ').slice(1);
  if (!args[0]) return ctx.reply('❌ Использование: /makeadmin <id>');
  await pool.query('UPDATE users SET is_admin = true WHERE telegram_id = $1', [parseInt(args[0])]);
  ctx.reply(`✅ Пользователь ${args[0]} назначен администратором.`);
});

bot.command('removeadmin', async (ctx) => {
  const userId = ctx.from.id;
  if (!MASTER_ADMIN_IDS.includes(userId)) return; // Только владелец
  const args = ctx.message.text.split(' ').slice(1);
  if (!args[0]) return ctx.reply('❌ Использование: /removeadmin <id>');
  await pool.query('UPDATE users SET is_admin = false WHERE telegram_id = $1', [parseInt(args[0])]);
  ctx.reply(`✅ Пользователь ${args[0]} удален из администраторов.`);
});

bot.command('setwebhook', async (ctx) => {
  if (!(await checkIsAdmin(ctx.from.id))) return;
  const args = ctx.message.text.split(' ').slice(1);
  if (!args[0]) return ctx.reply('❌ Использование: /setwebhook <url>\nДля удаления: /setwebhook clear');
  const url = args[0] === 'clear' ? '' : args[0];
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['google_sheets_webhook', url]);
  ctx.reply(url ? '✅ Webhook URL сохранен в базу.' : '🗑 Webhook удален.');
});

bot.command('setsupportchat', async (ctx) => {
  console.log(`[Admin Command] /setsupportchat from ${ctx.from.id} in chat ${ctx.chat.id} (Thread: ${ctx.message.message_thread_id})`);
  const isAdmin = await checkIsAdmin(ctx.from.id);
  if (!isAdmin) return ctx.reply('❌ У вас нет прав.');

  const args = ctx.message.text.split(' ').slice(1);
  if (!args[0]) {
    return ctx.reply(`❌ Использование: \`/setsupportchat <ChatID> [ThreadID]\`\n\nID этого чата: \`${ctx.chat.id}\`\nID этой темы: \`${ctx.message.message_thread_id || 'General'}\``, {
      parse_mode: 'Markdown',
      message_thread_id: ctx.message.message_thread_id
    });
  }
  const chatId = args[0];
  const threadId = args[1] || '';

  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['support_chat_id', chatId]);
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['support_thread_id', threadId]);

  ctx.reply(`✅ Настройки поддержки сохранены:\nЧат: \`${chatId}\`\nТема: \`${threadId || 'General'}\``, {
    parse_mode: 'Markdown',
    message_thread_id: ctx.message.message_thread_id
  });
});

bot.command('ping', async (ctx) => {
  ctx.reply(`🏓 Понг!\n\nID чата: \`${ctx.chat.id}\`\nID темы: \`${ctx.message.message_thread_id || 'General'}\``, {
    parse_mode: 'Markdown',
    message_thread_id: ctx.message.message_thread_id
  });
});

bot.action('create_etrn', async (ctx) => {
  const userId = ctx.from.id;
  const { hasLimit, plan, limit } = await checkLimit(userId);

  if (!hasLimit) {
    await ctx.answerCbQuery();
    return ctx.replyWithMarkdown(
      `🔒 *Лимит исчерпан*\n\n` +
      `На тарифе *${plan}* доступно *${limit} ЭТрН*.\n` +
      `Для продолжения работы обратитесь к администрации: ������ ��������� (������ � .env) или `,
      Markup.inlineKeyboard([
        [Markup.button.callback('💳 Посмотреть тарифы', 'pricing_btn')],
        [Markup.button.callback('🏠 В меню', 'cancel')]
      ])
    );
  }

  await pool.query('UPDATE users SET state = $1, state_updated_at = NOW() WHERE telegram_id = $2', ['CHOOSING_PLATFORM', userId]);

  const platformMsg = `
🚀 *Новая ЭТрН*
Выбери платформу, через которую будем отправлять документы:
  `;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔹 СБИС (Saby)', 'platform:sbis')],
    [Markup.button.callback('🔸 Контур.Диадок', 'platform:diadok')],
    [Markup.button.callback('🔹 Такском', 'platform:taxcom')],
    [Markup.button.callback('🚫 Отмена', 'cancel')]
  ]);

  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  return ctx.replyWithMarkdown(platformMsg, keyboard);
});

// Заглушка для выбора платформы
bot.action(/^platform:(.+)$/, async (ctx) => {
  const platform = ctx.match[1];

  if (platform === 'sbis') {
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_AUTH_SBIS', ctx.from.id]);
    await ctx.answerCbQuery();
    await removeButtons(ctx, ctx.callbackQuery.message.message_id);

    const authMsg = await ctx.replyWithMarkdown(
      `🔐 *Авторизация в Saby (СБИС)*\n\n` +
      `Для подключения к API введите ваш *Логин* *Пароль* через один пробел.\n\n` +
      `⚠️ *Инструкция:* Если вы еще не устанавливали пароль, зайдите в [личный кабинет Saby](https://online.sbis.ru/), нажмите на свой профиль -> Безопасность -> Пароль.\n\n` +
      `*Пример:* \`79001234567 pass123456\``,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    // Сохраняем ID сообщения с инструкцией, чтобы убрать кнопки позже
    await dataBatch.set(`${ctx.from.id}_auth_msg`, authMsg.message_id);
    return authMsg;
  } else {
    return ctx.answerCbQuery('Эта платформа пока в разработке');
  }
});

bot.action('show_templates', async (ctx) => {
  return showTemplates(ctx);
});

bot.action(/^select_template:(.+)$/, async (ctx) => {
  const templateId = ctx.match[1];
  await pool.query('UPDATE users SET state = $1, current_template_id = (SELECT file_id FROM templates WHERE id = $2), is_new_template = FALSE WHERE telegram_id = $3', ['WAITING_DATA', templateId, ctx.from.id]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const promptMsg = await ctx.reply('✅ *Шаблон выбран!*\n\n📍 *Шаг 2: Загрузка документов*\n\nТеперь пришли мне фото документов (Паспорт, СТС, Водительское). Можно отправить несколько фото по очереди.', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена (назад)', 'cancel')]])
  });
  await dataBatch.set(`${ctx.from.id}_prompt_msg`, promptMsg.message_id);
  return promptMsg;
});

bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery('Для подключения тарифа напишите администрации: ������ ��������� (������ � .env) или ');
});

// --- ОПЛАТА И ВЕРИФИКАЦИЯ (Закрытый B2B Клуб) ---

bot.action('request_access', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  await pool.query('UPDATE users SET state = $1, state_updated_at = NOW() WHERE telegram_id = $2', ['WAITING_FOR_VERIFICATION_INFO', userId]);

  return ctx.replyWithMarkdown(
    `🔐 *Корпоративный доступ*\n\n` +
    `Мы работаем только с проверенными транспортными компаниями.\n\n` +
    `Пожалуйста, напишите в одном сообщении:\n` +
    `1. Ваш ИНН или название компании\n` +
    `2. Примерное количество машин в автопарке\n` +
    `3. Контактный номер телефона\n\n` +
    `_Ваша заявка будет отправлена администрации._`,
    Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
  );
});

// Скрытая команда для администраторов: отправка инвойса конкретному клиенту
bot.command('invoice', async (ctx) => {
  const isAdmin = await checkIsAdmin(ctx.from.id);
  if (!isAdmin) return;

  const args = ctx.message.text.split(' ').slice(1);
  if (!args[0]) return ctx.reply('❌ Использование: /invoice <ID_клиента> [Кол-во_ЭТрН] [Цена_в_Рублях]\nНапример: /invoice 12345 500 25000');

  const targetUserId = parseInt(args[0]);
  const count = parseInt(args[1]) || 100;
  const priceRub = parseInt(args[2]) || 5000;

  if (!config.paymentToken) {
    return ctx.reply('❌ Платёжный токен не настроен в .env');
  }

  try {
    const packName = (count === 100 && priceRub === 5000) ? 'Корпоративный пакет' : 'Индивидуальный пакет';
    
    await ctx.telegram.sendInvoice(targetUserId, {
      title: `📦 ${packName} — ${count} ЭТрН`,
      description: `Доступ к ${count} ЭТрН. Распознавание ИИ, интеграция со СБИС/Saby, поддержка всех типов ТС.`,
      payload: `custom_${count}_etrn`,
      provider_token: config.paymentToken,
      currency: 'RUB',
      prices: [{ label: `${packName} ${count} ЭТрН`, amount: priceRub * 100 }], // в копейках
      photo_url: 'https://i.imgur.com/7VIYq1k.png',
      photo_width: 600,
      photo_height: 300,
      need_name: false,
      need_phone_number: false,
      need_email: false,
      is_flexible: false,
      start_parameter: 'buy_pack',
      reply_markup: {
        inline_keyboard: [[{ text: `💳 Оплатить ${priceRub.toLocaleString('ru-RU')} ₽`, pay: true }]]
      }
    });
    await ctx.reply(`✅ Инвойс на ${count} ЭТрН (${priceRub} ₽) успешно отправлен клиенту ${targetUserId}.`);
  } catch (e) {
    console.error('[Payment] Ошибка отправки инвойса через /invoice:', e.message);
    await ctx.reply(`❌ Не удалось отправить форму оплаты. Ошибка: ${e.message}`);
  }
});

// Telegram вызывает перед оплатой — нужно подтвердить
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch (e) {
    await ctx.answerPreCheckoutQuery(false, 'Ошибка подтверждения платежа. Попробуйте позже.');
  }
});

// Telegram вызывает после успешной оплаты
bot.on('successful_payment', async (ctx) => {
  const userId = ctx.from.id;
  const payment = ctx.message.successful_payment;

  const payload = payment.invoice_payload || '';
  let countToAdd = 100;
  if (payload.startsWith('custom_')) {
    const parts = payload.split('_');
    if (parts[1]) {
      countToAdd = parseInt(parts[1]) || 100;
    }
  }

  try {
    // Начисляем ЭТрН пользователю
    await pool.query(`
      INSERT INTO users (telegram_id, plan, custom_limit, etrn_count, state)
      VALUES ($1, 'custom', $2, 0, 'IDLE')
      ON CONFLICT (telegram_id)
      DO UPDATE SET plan = 'custom', custom_limit = EXCLUDED.custom_limit, etrn_count = 0
    `, [userId, countToAdd]);

    await ctx.replyWithMarkdown(
      `✅ *Оплата прошла успешно!*\n\n` +
      `🎉 Вам начислено *${countToAdd} ЭТрН*. Можете приступать к работе!\n\n` +
      `Сумма: *${(payment.total_amount / 100).toLocaleString('ru-RU')} ₽*\n` +
      `ID транзакции: \`${payment.telegram_payment_charge_id}\``,
      Markup.inlineKeyboard([[Markup.button.callback('🚀 Создать ЭТрН', 'create_etrn')]])
    );

    // Уведомляем администратора
    for (const adminId of await getAdminIds()) {
      try {
        await ctx.telegram.sendMessage(adminId,
          `💰 <b>НОВАЯ ОПЛАТА!</b>\n\n` +
          `👤 <b>Кто:</b> ${ctx.from.first_name} (@${ctx.from.username || 'нет'})\n` +
          `🆔 <b>ID:</b> <code>${userId}</code>\n` +
          `💳 <b>Сумма:</b> ${(payment.total_amount / 100).toLocaleString('ru-RU')} ₽\n` +
          `📦 <b>Начислено:</b> ${countToAdd} ЭТрН\n` +
          `🔑 <b>TX:</b> <code>${payment.telegram_payment_charge_id}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (e) { /* ignore */ }
    }

    // Вебхук в CRM
    const webhookUrl = await getSetting('google_sheets_webhook');
    if (webhookUrl) {
      fetchWithTimeout(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'Оплата (auto)',
          user_id: userId,
          name: ctx.from.first_name || 'Без имени',
          username: ctx.from.username ? `@${ctx.from.username}` : 'Скрыт',
          limit_amount: 100,
          bot_name: 'ETrN_Bot',
          price: payment.total_amount / 100,
          date: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
        })
      }).catch(() => { });
    }

  } catch (e) {
    console.error('[Payment] Ошибка обработки successful_payment:', e.message);
    await ctx.reply('✅ Оплата прошла, но произошла ошибка начисления. Напишите администратору: ������ ��������� (������ � .env)');
  }
});

bot.action('cancel_silent', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDelete(ctx, ctx.callbackQuery.message.message_id);
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const uid = ctx.from.id;
  // Полная очистка всех временных данных
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['IDLE', uid]);
  await clearTempData(uid);
  return sendMainMenu(ctx);
});

bot.action('retry_naming', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Хорошо, введи новое название (только буквы цифры, до 10 символов):', Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]]));
});

bot.action('final_send', async (ctx) => {
  const userId = ctx.from.id;

  // 1. АТОМАРНАЯ БЛОКИРОВКА ДВОЙНОГО КЛИКА
  const lockRes = await pool.query(
    "UPDATE users SET state = 'PROCESSING_SBIS' WHERE telegram_id = $1 AND state != 'PROCESSING_SBIS' RETURNING sbis_sid", 
    [userId]
  );
  if (lockRes.rowCount === 0) {
    return ctx.answerCbQuery('⏳ Уже отправляем, подождите...', { show_alert: true });
  }
  const sbisSid = lockRes.rows[0].sbis_sid;

  const extractedData = await getExtractedData(userId);
  if (!extractedData) {
    await pool.query("UPDATE users SET state = 'IDLE' WHERE telegram_id = $1", [userId]);
    return ctx.answerCbQuery('Данные не найдены. Попробуйте начать заново.');
  }

  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  // ФИНАЛЬНАЯ ПРОВЕРКА ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ
  const missing = [];
  // Создаем жесткий валидатор: пустота, пробелы прочерки не пройдут!
  const isFilled = (val) => val && String(val).trim() !== '' && String(val).trim() !== '—';

  if (!isFilled(extractedData.driver?.fio)) missing.push('ФИО Водителя');
  if (!isFilled(extractedData.vehicle?.plate)) missing.push('Госномер транспорта');
  if (!isFilled(extractedData.cargo?.name)) missing.push('Название груза');
  if (!isFilled(extractedData.shipper?.name)) missing.push('Грузоотправитель');
  if (!isFilled(extractedData.consignee?.name)) missing.push('Грузополучатель');
  if (!isFilled(extractedData.carrier?.name)) missing.push('Перевозчик');

  const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
  const trailer = TRAILER_TYPES[tKey] || TRAILER_TYPES.other;

  if (trailer.needsCount && !isFilled(extractedData.cargo?.count)) missing.push(cp(tKey, 'count'));
  if (trailer.needsTemp && !isFilled(extractedData.cargo?.temp)) missing.push('Температурный режим');

  if (missing.length > 0) {
    await pool.query("UPDATE users SET state = 'IDLE' WHERE telegram_id = $1", [userId]);
    return ctx.replyWithMarkdown(
      `❌ *Невозможно отправить в СБИС!*\n\nДля регистрации ЭТрН обязательно нужны следующие данные, а они у вас не заполнены:\n• ` + missing.join('\n• ') +
      `\n\nНажмите кнопку *«Редактировать»* в отчёте выше допишите их руками.`,
      Markup.inlineKeyboard([[Markup.button.callback('Ок, понятно', 'cancel_silent')]])
    );
  }

  // 2. ПРОВЕРКА И СПИСАНИЕ ЛИМИТА (ПЛАТИМ ЗА РЕЗУЛЬТАТ)
  const { hasLimit, limit } = await checkLimit(userId);
  if (!hasLimit) {
    await pool.query("UPDATE users SET state = 'IDLE' WHERE telegram_id = $1", [userId]);
    return ctx.replyWithMarkdown(`🔒 *Лимит исчерпан!*\nДля продолжения обратитесь к администрации.`);
  }

  const limitRes = await pool.query(
    'UPDATE users SET etrn_count = etrn_count + 1 WHERE telegram_id = $1 AND etrn_count < $2 RETURNING etrn_count',
    [userId, limit]
  );
  if (limitRes.rowCount === 0) {
    await pool.query("UPDATE users SET state = 'IDLE' WHERE telegram_id = $1", [userId]);
    return ctx.reply('❌ Ошибка списания баланса.');
  }

  const statusMsg = await ctx.reply('🚀 *Формирую черновик ЭТрН в СБИС...*', { parse_mode: 'Markdown' });

  // Если мы в режиме "dev"
  if (sbisSid === "test_session_id_for_development") {
    setTimeout(async () => {
      try {
        await safeDelete(ctx, statusMsg.message_id);
        await pool.query("UPDATE users SET state = 'IDLE', last_extracted_data = NULL WHERE telegram_id = $1", [userId]);
        await clearTempData(userId);
        await ctx.replyWithMarkdown(
          `✅ *ИМИТАЦИЯ УСПЕХА (Режим DEV)*\n\nДокумент для водителя *${extractedData.driver.fio}* успешно сформирован!`,
          Markup.inlineKeyboard([[Markup.button.callback('🏠 Вернуться в главное меню', 'cancel')]])
        );
      } catch (e) { console.error(e); }
    }, 2000);
    return;
  }

  // 3. РЕАЛЬНАЯ ОТПРАВКА
  const result = await sbisSendETrN(sbisSid, extractedData);
  await safeDelete(ctx, statusMsg.message_id);

  if (result.success) {
    await pool.query("UPDATE users SET state = 'IDLE', last_extracted_data = NULL WHERE telegram_id = $1", [userId]);
    await clearTempData(userId);

    // ФОНОВЫЙ ВЕБХУК CRM
    const GOOGLE_SHEETS_WEBHOOK_URL = await getSetting('google_sheets_webhook');
    if (GOOGLE_SHEETS_WEBHOOK_URL) {
      (async () => {
        try {
          const uInfo = (await pool.query('SELECT full_name, username, phone, company_name FROM users WHERE telegram_id = $1', [userId])).rows[0] || {};
          await fetchWithTimeout(GOOGLE_SHEETS_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'Успешная ЭТрН', user_id: userId, name: uInfo.full_name || 'Без имени',
              company: extractedData.carrier?.name || 'Не указана', bot_name: 'ETrN_Bot',
              date: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
            })
          });
        } catch (e) {}
      })();
    }

    await ctx.replyWithMarkdown(
      `✅ *ЭТрН успешно зарегистрирована!*\n\n` +
      `Документ передан в защищенный контур Saby (СБИС). Водитель может открыть приложение для подписания приступать к рейсу.\n\n` +
      `_ID сессии сохранен в логах._`,
      Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel')]])
    );
  } else {
    // ВАЖНО: ВОЗВРАЩАЕМ ЛИМИТ ПРИ ОШИБКЕ СБИС
    await pool.query('UPDATE users SET etrn_count = GREATEST(etrn_count - 1, 0) WHERE telegram_id = $1', [userId]);

    if (result.isAuthError) {
      await pool.query("UPDATE users SET sbis_sid = NULL, state = 'WAITING_AUTH_RETRY' WHERE telegram_id = $1", [userId]);
      await ctx.replyWithMarkdown(
        `❌ *Сессия СБИС истекла.*\n\nПожалуйста, введите логин пароль заново (через пробел), чтобы отправить этот черновик.`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
    } else {
      await pool.query("UPDATE users SET state = 'IDLE' WHERE telegram_id = $1", [userId]);
      await ctx.replyWithMarkdown(
        `❌ *Ошибка создания ЭТрН:*\n\n${result.message}\n\nПроверьте данные или попробуйте авторизоваться заново.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Исправить данные', 'edit_data')],
          [Markup.button.callback('🏠 В меню', 'cancel')]
        ])
      );
    }
  }
});

bot.action('edit_data', async (ctx) => {
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👤 Водитель (ФИО/Права)', 'edit_cat:driver')],
    [Markup.button.callback('🚛 Транспорт (Номер/Марка)', 'edit_cat:vehicle')],
    [Markup.button.callback('📦 Груз (Название/Вес)', 'edit_cat:cargo')],
    [Markup.button.callback('🏢 Стороны (Отпр./Получ./Перевозчик)', 'edit_cat:sides')],
    [Markup.button.callback('📅 Дата', 'edit_cat:extra')],
    [Markup.button.callback('🏠 Готово (назад)', 'back_to_report')]
  ]);

  return ctx.reply('Выберите категорию для исправления:', keyboard);
});

// Подменю для выбора конкретного поля
bot.action(/^edit_cat:(.+)$/, async (ctx) => {
  const cat = ctx.match[1];
  const userId = ctx.from.id;
  const currentData = (await getExtractedData(userId)) || {};
  const tKey = currentData.trailerKey || await dataBatch.get(`${userId}_trailer`) || 'container';
  const trailer = TRAILER_TYPES[tKey];

  let buttons = [];
  let title = '';

  if (cat === 'driver') {
    title = '👤 Водитель';
    buttons = [
      [Markup.button.callback('ФИО', 'edit_field:driver:fio')],
      [Markup.button.callback('Номер прав', 'edit_field:driver:license')]
    ];
  } else if (cat === 'vehicle') {
    title = '🚛 Транспорт';
    buttons = [
      [Markup.button.callback('Госномер', 'edit_field:vehicle:plate')],
      [Markup.button.callback('Марка', 'edit_field:vehicle:brand')]
      // Убрали СТС (по просьбе пользователя оставить только необходимое)
    ];
  } else if (cat === 'cargo') {
    title = '📦 Груз';
    buttons = [
      [Markup.button.callback('Название груза', 'edit_field:cargo:name')],
      [Markup.button.callback('Масса (тонн)', 'edit_field:cargo:weight')]
    ];
    if (trailer?.needsCount) {
      buttons.push([Markup.button.callback('Кол-во мест/паллет', 'edit_field:cargo:count')]);
    }
    if (trailer?.needsTemp) {
      buttons.push([Markup.button.callback('Темп. режим', 'edit_field:cargo:temp')]);
    }
  } else if (cat === 'sides') {
    title = '🏢 Стороны';
    buttons = [
      [Markup.button.callback('Грузоотправитель (Имя)', 'edit_field:shipper:name')],
      [Markup.button.callback('ИНН отправителя', 'edit_field:shipper:inn')],
      [Markup.button.callback('Адрес погрузки', 'edit_field:shipper:address')],
      [Markup.button.callback('Грузополучатель (Имя)', 'edit_field:consignee:name')],
      [Markup.button.callback('ИНН получателя', 'edit_field:consignee:inn')],
      [Markup.button.callback('Адрес выгрузки', 'edit_field:consignee:address')],
      [Markup.button.callback('Перевозчик', 'edit_field:carrier:name')],
      [Markup.button.callback('ИНН перевозчика', 'edit_field:carrier:inn')]
    ];
  } else if (cat === 'extra') {
    title = '📅 Дата';
    buttons = [[Markup.button.callback('Дата перевозки', 'edit_field:extra:date')]];
  }

  buttons.push([Markup.button.callback('⬅️ Назад', 'edit_data')]);

  await ctx.answerCbQuery();
  return ctx.editMessageText(`🛠 *Редактирование: ${title}*\nВыберите поле для изменения:`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// СЛОВАРЬ ПОЛЕЙ (для красивых названий в запросе)
const fieldNames = {
  'driver:fio': 'ФИО Водителя',
  'driver:license': 'Номер водительских прав',
  'vehicle:plate': 'Госномер транспорта',
  'vehicle:brand': 'Марка/Модель транспорта',
  'cargo:name': 'Название груза',
  'cargo:weight': 'Масса груза (тонн)',
  'cargo:count': 'Количество мест',
  'shipper:name': 'Грузоотправитель',
  'shipper:inn': 'ИНН грузоотправителя (10 цифр)',
  'shipper:address': 'Адрес погрузки',
  'consignee:name': 'Грузополучатель',
  'consignee:inn': 'ИНН грузополучателя (10 цифр)',
  'consignee:address': 'Адрес выгрузки',
  'carrier:name': 'Перевозчик',
  'carrier:inn': 'ИНН перевозчика (10 или 12 цифр)',
  'extra:date': 'Дата перевозки'
};

bot.action('mode:manual', async (ctx) => {
  const userId = ctx.from.id;
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['CHOOSING_TRAILER', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const trailerMsg = await ctx.replyWithMarkdown(
    `🚛 *Выберите тип вашего прицепа/ТС:*`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📦 Контейнер', 'trailer:container')],
      [Markup.button.callback('🏗️ Цементовоз', 'trailer:cement')],
      [Markup.button.callback('🧊 Рефрижератор', 'trailer:ref')],
      [Markup.button.callback('🚫 Отмена', 'cancel')],
    ])
  );
  await dataBatch.set(`${userId}_prompt_msg`, trailerMsg.message_id);
});

// 1. При нажатии "Скан ИИ" сразу спрашиваем тип прицепа
bot.action('mode:ocr', async (ctx) => {
  const userId = ctx.from.id;
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['CHOOSING_TRAILER_OCR', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  
  const msg = await ctx.replyWithMarkdown(
    `🚛 *Мастер создания ЭТрН (ИИ-сканирование)*\n\nДля точного распознавания данных выберите тип транспортного средства:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📦 Контейнер', 'ocr_trailer:container')],
      [Markup.button.callback('🏗️ Цементовоз', 'ocr_trailer:cement')],
      [Markup.button.callback('🧊 Рефрижератор', 'ocr_trailer:ref')],
      [Markup.button.callback('🚫 Отмена', 'cancel')]
    ])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
});

// 2. Юзер выбрал прицеп -> теперь просим фото
bot.action(/^ocr_trailer:(.+)$/, async (ctx) => {
  const tKey = ctx.match[1];
  const userId = ctx.from.id;
  
  await dataBatch.set(`${userId}_trailer`, tKey);
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_TTN_PHOTO', userId]);
  
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const trailerName = TRAILER_TYPES[tKey]?.label || 'Транспорт';

  const msg = await ctx.replyWithMarkdown(
    `✅ Тип ТС: *${trailerName}*\n\n` +
    `📸 *Загрузка документа*\n\n` +
    `Отправьте качественное фото бумажной Товарно-транспортной накладной (ТТН). ` +
    `_Убедитесь, что текст читаем, а документ попадает в кадр целиком._\n\n` +
    `⚠️ *Внимание:* Сканирование спишет 1 ЭТрН с вашего баланса.`,
    Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
});

// ВЫБОР ТИПА ПРИЦЕПА / ТС
bot.action(/^trailer:(.+)$/, async (ctx) => {
  const tKey = ctx.match[1];
  const trailer = TRAILER_TYPES[tKey];
  if (!trailer) return ctx.answerCbQuery('Неизвестный тип.');
  const userId = ctx.from.id;
  await dataBatch.set(`${userId}_trailer`, tKey);
  // Инициализируем пустой объект данных
  const emptyData = { trailerKey: tKey, driver: {}, vehicle: {}, cargo: {}, shipper: {}, consignee: {}, carrier: {}, extra: {} };
  await dataBatch.set(`${userId}_result`, emptyData);
  await pool.query('UPDATE users SET state = $1, last_extracted_data = $2 WHERE telegram_id = $3', ['WAITING_DRIVER_FIO', JSON.stringify(emptyData), userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const msg = await ctx.replyWithMarkdown(
    `✅ *${trailer.label}* — выбран.\n\n👤 *Шаг 1 — Водитель*\nВведи *ФИО водителя* (полностью):\n_Пример:_ Иванов Иван Иванович`,
    Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
});

// ОБРАБОТЧИК ВЫБОРА КОНКРЕТНОГО ПОЛЯ
bot.action(/^edit_field:(.+):(.+)$/, async (ctx) => {
  const category = ctx.match[1];
  const field = ctx.match[2];
  const userId = ctx.from.id;

  const state = `EDITING_${category.toUpperCase()}_${field.toUpperCase()}`;
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', [state, userId]);

  const fieldDisplayName = fieldNames[`${category}:${field}`] || field;

  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const msg = await ctx.reply(`📝 Введите новое значение для поля: *${fieldDisplayName}*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'back_to_report')]])
  });
  await dataBatch.set(`${userId}_edit_msg`, msg.message_id);
  return msg;
});

// ВОЗВРАТ К ОТЧЕТУ
bot.action('back_to_report', async (ctx) => {
  const userId = ctx.from.id;
  const extractedData = await getExtractedData(userId);

  if (!extractedData) {
    return ctx.answerCbQuery('Данные не найдены. Попробуйте начать заново.');
  }

  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['IDLE', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const tKey = extractedData.trailerKey || await dataBatch.get(`${userId}_trailer`) || 'container';
  return showReview(ctx, extractedData, tKey);
});
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const user = (await pool.query('SELECT state FROM users WHERE telegram_id = $1', [userId])).rows[0];
  const photoStates = ['WAITING_TTN_PHOTO', 'WAITING_TTN_PHOTO_BACK', 'WAITING_LICENSE', 'WAITING_STS', 'WAITING_TEMPLATE'];
  if (photoStates.includes(user?.state)) {
    return ctx.reply('❌ Пожалуйста, отправь документ **КАК ФОТО** (сжатое изображение), а не как файл (PDF/Документ). ИИ обрабатывает только картинки.', { parse_mode: 'Markdown' });
  }
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;

  // Защита от альбомов
  if (ctx.message.media_group_id) {
    if (processedMediaGroups.has(ctx.message.media_group_id)) return;
    processedMediaGroups.add(ctx.message.media_group_id);
    setTimeout(() => processedMediaGroups.delete(ctx.message.media_group_id), 10000);
  }

  const user = (await pool.query('SELECT state FROM users WHERE telegram_id = $1', [userId])).rows[0];
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  const mediaGroupId = ctx.message.media_group_id;

  if (user?.state === 'WAITING_TEMPLATE') {
    await pendingTemplate.set(userId, fileId);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['CONFIRMING_TEMPLATE', userId]);

    const confirmMsg = `
📸 *Фото получено!*

⚠️ *ВНИМАНИЕ:* Нажатие кнопки «Проверить» задействует агента расходует лимиты системы. Пожалуйста, убедись, что на фото именно *чистый бланк ТТН*.

Проверить этот бланк?
    `;

    return ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Проверить с помощью агента', 'confirm_template')],
      [Markup.button.callback('🚫 Отмена', 'cancel')]
    ]));
  }

  if (user?.state === 'CONFIRMING_TEMPLATE') {
    await pendingTemplate.set(userId, fileId);
    return ctx.reply('🔄 *Фото шаблона обновлено.*', Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Проверить с помощью агента', 'confirm_template')],
      [Markup.button.callback('🚫 Отмена', 'cancel')]
    ]));
  }

  // БЛОК: альбом (два фото сразу) — принимаем только одно фото
  if (ctx.message.media_group_id && ['WAITING_TTN_PHOTO', 'WAITING_TTN_PHOTO_BACK', 'WAITING_LICENSE', 'WAITING_STS'].includes(user?.state)) {
    return ctx.reply('❌ Пожалуйста, отправь ровно одно фото, а не несколько (альбом).');
  }

  // БЛОКИРОВКА: пока ждём подтверждения фото — игнорируем новые
  if (['PROCESSING', 'PRE_LICENSE', 'PRE_STS', 'PRE_TTN', 'PROCESSING_TTN'].includes(user?.state)) {
    return ctx.reply('⏳ Сначала ответь на предыдущий вопрос.');
  }

  // ШАГ ТТН: фото ЛИЦЕВОЙ стороны получено
  if (user?.state === 'WAITING_TTN_PHOTO') {
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }

    await dataBatch.set(`${userId}_ttn_file`, fileId);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['PRE_TTN', userId]);

    const msg = await ctx.replyWithMarkdown(
      `📸 *Фото лицевой стороны ТТН получено.*\n\n` +
      `Для *полного распознавания* (водитель, авто, маршрут) рекомендуется также прислать *оборотную сторону*.\n\n` +
      `Выбери действие:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📸 Добавить оборот', 'add_ttn_back')],
        [Markup.button.callback('✅ Сканировать как есть', 'analyze_ttn')],
        [Markup.button.callback('🔄 Другое фото', 'retake_ttn')]
      ])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  // ШАГ ТТН: фото ОБОРОТНОЙ стороны получено
  if (user?.state === 'WAITING_TTN_PHOTO_BACK') {
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }

    await dataBatch.set(`${userId}_ttn_file_back`, fileId);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['PRE_TTN', userId]);

    const msg = await ctx.replyWithMarkdown(
      `📸 *Оборотная сторона получена!*\n\n` +
      `Теперь у бота обе стороны ТТН — распознавание будет максимально полным.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Сканировать обе стороны', 'analyze_ttn')],
        [Markup.button.callback('🔄 Переснять оборот', 'add_ttn_back')],
        [Markup.button.callback('🗑 Отмена', 'cancel')]
      ])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  // ШАГ 1: фото получено — спрашиваем БЕЗ AI
  if (user?.state === 'WAITING_LICENSE') {
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }

    // Сохраняем fileId, AI пока НЕ запускаем
    await dataBatch.set(`${userId}_license_file`, fileId);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['PRE_LICENSE', userId]);

    const msg = await ctx.replyWithMarkdown(
      `📸 *Фото получено.*\n\nЭто фото *водительского удостоверения*?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, анализировать', 'analyze_license')],
        [Markup.button.callback('🔄 Другое фото', 'retake_license')]
      ])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  // ШАГ 2: фото получено — спрашиваем БЕЗ AI
  if (user?.state === 'WAITING_STS') {
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }

    await dataBatch.set(`${userId}_sts_file`, fileId);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['PRE_STS', userId]);

    const msg = await ctx.replyWithMarkdown(
      `📸 *Фото получено.*\n\nЭто фото *СТС* (свидетельство о регистрации ТС)?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, анализировать', 'analyze_sts')],
        [Markup.button.callback('🔄 Другое фото', 'retake_sts')]
      ])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }
});

// --- АНАЛИЗ ПРАВ (запускается только после подтверждения) ---
bot.action('analyze_license', async (ctx) => {
  const userId = ctx.from.id;
  const { hasLimit, plan, limit } = await checkLimit(userId);
  if (!hasLimit) {
    return ctx.replyWithMarkdown(`❌ *Лимит исчерпан!*\nНа тарифе *${plan}* доступно *${limit} ЭТрН*. Пожалуйста, пополните баланс.`);
  }

  const fId = await dataBatch.get(`${userId}_license_file`);
  if (!fId) return ctx.answerCbQuery('Фото не найдено, пришли заново.');

  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['PROCESSING', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const steps = [
    '🌀 *Анализирую права...*\n\n📡 _Считываю документ..._',
    '🌀 *Анализирую права...*\n\n🔍 _Распознаю ФИО номер..._'
  ];
  const statusMsg = await ctx.reply(steps[0], { parse_mode: 'Markdown' });
  const animInterval = animateStatus(ctx, statusMsg.message_id, steps);

  try {
    const url = await ctx.telegram.getFileLink(fId);
    const resp = await fetch(url.href);
    const buffer = Buffer.from(await resp.arrayBuffer());

    const result = await callAiWithRetry(modelJson, [
      { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } },
      `Ты — OCR агент. На фото ВОДИТЕЛЬСКОЕ УДОСТОВЕРЕНИЕ (права водителя РФ).\nИзвлеки данные строго в JSON без пояснений:\n{"fio":"Фамилия Имя Отчество","license":"серия номер"}\nЕсли это НЕ водительское удостоверение — {"error":"NOT_LICENSE"}\nТолько JSON, никакого лишнего текста.`
    ]);

    clearInterval(animInterval);
    const responseText = (await result.response.text()).replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(responseText); } catch (e) { parsed = { error: 'PARSE_ERROR' }; }

    await dataBatch.delete(`${userId}_license_file`);

    if (parsed.error) {
      await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_LICENSE', userId]);
      await safeDelete(ctx, statusMsg.message_id);
      const retryMsg = await ctx.replyWithMarkdown(
        `❌ Не удалось распознать права.\n\nПришли чёткое фото *лицевой стороны*:`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
      return await dataBatch.set(`${userId}_prompt_msg`, retryMsg.message_id);
    }

    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {} };
    currentData.driver = { fio: parsed.fio, license: parsed.license };
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2 WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_STS', userId]);

    await safeDelete(ctx, statusMsg.message_id);
    const stsMsg = await ctx.replyWithMarkdown(
      `✅ *Права распознаны!*\n` +
      `👤 ФИО: \`${parsed.fio}\`\n` +
      `🪪 Номер: \`${parsed.license}\`\n\n` +
      `📍 *Шаг 2 из 3 — СТС*\nПришли фото *СТС*:`,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    await dataBatch.set(`${userId}_prompt_msg`, stsMsg.message_id);
  } catch (e) {
    clearInterval(animInterval);
    console.error('[License OCR]', e);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_LICENSE', userId]);
    await safeDelete(ctx, statusMsg.message_id);
    ctx.reply('⚠️ Ошибка анализа. Попробуй ещё раз.');
  }
});

bot.action('retake_license', async (ctx) => {
  const userId = ctx.from.id;
  await dataBatch.delete(`${userId}_license_file`);
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_LICENSE', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const msg = await ctx.replyWithMarkdown(
    `🔄 Пришли другое фото *водительского удостоверения*:`,
    Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
});

// --- АНАЛИЗ СТС (запускается только после подтверждения) ---
bot.action('analyze_sts', async (ctx) => {
  const userId = ctx.from.id;
  const { hasLimit, plan, limit } = await checkLimit(userId);
  if (!hasLimit) {
    return ctx.replyWithMarkdown(`❌ *Лимит исчерпан!*\nНа тарифе *${plan}* доступно *${limit} ЭТрН*. Пожалуйста, пополните баланс.`);
  }

  const fId = await dataBatch.get(`${userId}_sts_file`);
  if (!fId) return ctx.answerCbQuery('Фото не найдено, пришли заново.');

  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['PROCESSING', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);

  const steps = [
    '🌀 *Анализирую СТС...*\n\n📡 _Считываю документ..._',
    '🌀 *Анализирую СТС...*\n\n🔍 _Распознаю госномер марку..._'
  ];
  const statusMsg = await ctx.reply(steps[0], { parse_mode: 'Markdown' });
  const animInterval = animateStatus(ctx, statusMsg.message_id, steps);

  try {
    const url = await ctx.telegram.getFileLink(fId);
    const resp = await fetch(url.href);
    const buffer = Buffer.from(await resp.arrayBuffer());

    const result = await callAiWithRetry(modelJson, [
      { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } },
      `Ты — OCR агент. На фото СТС (свидетельство о регистрации транспортного средства РФ).\nИзвлеки данные строго в JSON без пояснений:\n{"plate":"госномер","brand":"марка модель","sts":"серия номер"}\nЕсли это НЕ СТС — {"error":"NOT_STS"}\nТолько JSON, никакого лишнего текста.`
    ]);

    clearInterval(animInterval);
    const responseText = (await result.response.text()).replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(responseText); } catch (e) { parsed = { error: 'PARSE_ERROR' }; }

    await dataBatch.delete(`${userId}_sts_file`);

    if (parsed.error) {
      await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_STS', userId]);
      await safeDelete(ctx, statusMsg.message_id);
      const retryMsg = await ctx.replyWithMarkdown(
        `❌ Не удалось распознать СТС.\n\nПришли чёткое фото:`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
      return await dataBatch.set(`${userId}_prompt_msg`, retryMsg.message_id);
    }

    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {} };
    currentData.vehicle = { plate: parsed.plate, brand: parsed.brand, sts: parsed.sts };
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2 WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_CARGO_NAME', userId]);

    await safeDelete(ctx, statusMsg.message_id);
    const cargoMsg = await ctx.replyWithMarkdown(
      `✅ *СТС распознан!*\n` +
      `🚛 Авто: \`${parsed.brand}\`\n` +
      `🔢 Госномер: \`${parsed.plate}\`\n\n` +
      `📍 *Шаг 3 из 3 — Груз*\nВведи *название груза*:`,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    await dataBatch.set(`${userId}_prompt_msg`, cargoMsg.message_id);
  } catch (e) {
    clearInterval(animInterval);
    console.error('[STS OCR]', e);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_STS', userId]);
    await safeDelete(ctx, statusMsg.message_id);
    ctx.reply('⚠️ Ошибка анализа. Попробуй ещё раз.');
  }
});

bot.action('retake_sts', async (ctx) => {
  const userId = ctx.from.id;
  await dataBatch.delete(`${userId}_sts_file`);
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_STS', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const msg = await ctx.replyWithMarkdown(
    `🔄 Пришли другое фото *СТС*:`,
    Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
});

// === ТТН СКАН ACTIONS ===
bot.action('retake_ttn', async (ctx) => {
  const userId = ctx.from.id;
  await dataBatch.delete(`${userId}_ttn_file`);
  await dataBatch.delete(`${userId}_ttn_file_back`);
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_TTN_PHOTO', userId]);
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const msg = await ctx.replyWithMarkdown(
    `🔄 Пришли фото *лицевой стороны ТТН*:`,
    Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
});

bot.action('add_ttn_back', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_TTN_PHOTO_BACK', userId]);
  const msg = await ctx.replyWithMarkdown(
    `📸 Пришли фото *оборотной стороны ТТН* (транспортный раздел — где водитель, авто, маршрут):`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⏭ Пропустить, сканировать без оборота', 'analyze_ttn')],
      [Markup.button.callback('🚫 Отмена', 'cancel')]
    ])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
});

bot.action('analyze_ttn', async (ctx) => {
  const userId = ctx.from.id;
  const { hasLimit, plan, limit } = await checkLimit(userId);
  if (!hasLimit) {
    return ctx.replyWithMarkdown(`❌ *Лимит исчерпан!*\nНа тарифе *${plan}* доступно *${limit} ЭТрН*. Пожалуйста, пополните баланс.`);
  }

  const fId = await dataBatch.get(`${userId}_ttn_file`);
  if (!fId) return ctx.answerCbQuery('Ошибка: фото не найдено. Пришли снова.');

  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['PROCESSING_TTN', userId]);

  const steps = [
    '🔍 *ИИ анализирует документ...*\n\n📡 _Определяю тип документа..._',
    '🔍 *ИИ анализирует документ...*\n\n🧠 _Читаю данные накладной..._',
    '🔍 *ИИ анализирует документ...*\n\n✍️ _Извлекаю поля..._'
  ];
  const statusMsg = await ctx.reply(steps[0], { parse_mode: 'Markdown' });
  const animInterval = animateStatus(ctx, statusMsg.message_id, steps);

  try {
    const fileLink = await ctx.telegram.getFileLink(fId);
    const res = await fetch(fileLink.href);
    const buffer = Buffer.from(await res.arrayBuffer());
    const b64 = buffer.toString('base64');

    // ШАГ 1: Валидация (Бесплатная проверка)
    const checkResult = await callAiWithRetry(modelText, [
      { inlineData: { data: b64, mimeType: 'image/jpeg' } },
      `Посмотри на этот документ. Оцени два критерия:
1. Это Товарно-транспортная накладная (ТТН) для грузоперевозки?
2. Она заполнена реальными данными (есть хотя бы одно из: название организации, ФИО водителя, название груза, госномер, адрес, вес)?

Отвечай ТОЛЬКО "YES" если ОБА критерия выполнены.
Отвечай ТОЛЬКО "NO" если:
- это не ТТН (СТС, паспорт, права, счёт т.д.)
- или это ПУСТОЙ бланк (не заполненный шаблон без данных).`
    ]);

    clearInterval(animInterval);
    const checkText = checkResult.response.text().toUpperCase().replace(/[^A-Z]/g, '');

    if (checkText !== 'YES') {
      await safeDelete(ctx, statusMsg.message_id);
      await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_TTN_PHOTO', userId]);
      await dataBatch.delete(`${userId}_ttn_file`);
      return ctx.replyWithMarkdown(
        `❌ *Фото не подошло.*\n\nНужна *заполненная ТТН* — бумажная накладная с реальными данными (груз перевозчик).\nПустые шаблоны или другие документы не подходят.`,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Попробовать снова', 'mode:ocr'), Markup.button.callback('✍️ Ввести вручную', 'mode:manual')]])
      );
    }

    // Получаем выбранный тип прицепа
    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    
    // Проверяем наличие фото оборотной стороны
    const backFileId = await dataBatch.get(`${userId}_ttn_file_back`);
    let backB64 = null;
    if (backFileId) {
      try {
        const backLink = await ctx.telegram.getFileLink(backFileId);
        const backRes = await fetch(backLink.href);
        const backBuf = Buffer.from(await backRes.arrayBuffer());
        backB64 = backBuf.toString('base64');
      } catch (e) { console.log('[TTN] Не удалось загрузить оборот:', e.message); }
    }

    // ДИНАМИЧЕСКИЙ КОНТЕКСТ ДЛЯ ИИ
    let aiContext = '';
    if (tKey === 'ref') {
      aiContext = '\nДОП. КОНТЕКСТ: Это РЕФРИЖЕРАТОР. Обязательно найди ТЕМПЕРАТУРНЫЙ РЕЖИМ (например: -18°C, +2..+4°C). Запиши в поле "temp".';
    } else if (tKey === 'container') {
      aiContext = '\nДОП. КОНТЕКСТ: Это КОНТЕЙНЕРНАЯ ПЕРЕВОЗКА. Найди НОМЕР КОНТЕЙНЕРА (4 буквы + 7 цифр, напр. TGHU1234567). Запиши в поле "container_number".';
    } else if (tKey === 'cement') {
      aiContext = '\nДОП. КОНТЕКСТ: Это ЦЕМЕНТОВОЗ. В "name" укажи марку цемента (ЦЕМ II, ПЦ-400 т.д.).';
    }

    // Формируем мульти-имидж массив для Gemini
    const imageParts = [{ inlineData: { data: b64, mimeType: 'image/jpeg' } }];
    if (backB64) {
      imageParts.push({ inlineData: { data: backB64, mimeType: 'image/jpeg' } });
    }

    const imageNote = backB64 
      ? 'Тебе предоставлены ДВА фото: 1-е — ЛИЦЕВАЯ сторона (товарный раздел), 2-е — ОБОРОТНАЯ сторона (транспортный раздел). Извлеки данные из ОБОИХ фото.'
      : 'Тебе предоставлено ОДНО фото. Извлеки из него максимум данных. Некоторые поля (водитель, авто) могут быть на обороте — если их нет на фото, верни пустую строку.';

    // ШАГ 2: Извлечение данных — ЖЕЛЕЗОБЕТОННЫЙ ПРОМПТ
    const extractResult = await callAiWithRetry(modelJson, [
      ...imageParts,
      `Ты — эксперт по российским товарно-транспортным накладным (ТТН) формы 1-Т.
${imageNote}
${aiContext}

═══ СТРУКТУРА ФОРМЫ 1-Т ═══

ЛИЦЕВАЯ СТОРОНА (Товарный раздел):
┌─────────────────────────────────────────────────────┐
│ ШАПКА (верхняя часть бланка):                       │
│ • Строка «Грузоотправитель»: название организации,  │
│   юр.адрес, ИНН (10 цифр ЮЛ / 12 цифр ИП).        │
│   ИНН может быть написан как «ИНН 1234567890»,     │
│   «ИНН/КПП», или в скобках рядом с названием.      │
│ • Строка «Грузополучатель»: аналогично.             │
│ • Строка «Плательщик»: аналогично.                  │
│ • Справа вверху: номер ТТН дата составления       │
│   (формат ДД.ММ.ГГГГ или ДД.ММ.ГГ).               │
├─────────────────────────────────────────────────────┤
│ ТАБЛИЦА ТОВАРОВ (середина):                         │
│ Столбцы: №, Наименование, Ед.изм, Кол-во,          │
│ Цена, Сумма, Масса (брутто/нетто).                  │
│ Внизу таблицы: «Итого масса брутто/нетто».          │
├─────────────────────────────────────────────────────┤
│ ПОДПИСИ (низ): отпустил, принял, главбух.           │
└─────────────────────────────────────────────────────┘

ОБОРОТНАЯ СТОРОНА (Транспортный раздел):
┌─────────────────────────────────────────────────────┐
│ • Перевозчик: название организации + ИНН            │
│ • Водитель: ФИО (Фамилия Имя Отчество)             │
│ • Удостоверение: серия номер ВУ                   │
│ • Автомобиль: марка (КАМАЗ, МАЗ, Volvo, MAN др.) │
│ • Госномер: формат А000АА00 или А000АА000           │
│ • Прицеп: марка + госномер прицепа                  │
│ • Пункт погрузки: полный адрес                      │
│ • Пункт разгрузки: полный адрес                     │
└─────────────────────────────────────────────────────┘

═══ ПРАВИЛА ИЗВЛЕЧЕНИЯ ═══
1. ИНН — ТОЛЬКО цифры (10 для ЮЛ, 12 для ИП). Ищи после слов «ИНН», «ИНН/КПП», в скобках, или мелким шрифтом под названием.
2. Госномер — кириллица или латиница. Формат: буква + 3 цифры + 2 буквы + 2-3 цифры региона (напр. А001АА74).
3. ФИО — «Фамилия Имя Отчество» или «Фамилия И.О.». Если только инициалы — верни как есть.
4. Масса — число в тоннах. Если написано в кг (напр. «1100 кг»), переведи в тонны (1.1).
5. Дата — приведи к формату ДД.ММ.ГГГГ.
6. Адрес — полностью: индекс, город, улица, дом.
7. КРИТИЧЕСКИ ВАЖНО: если текст нечитаем, смазан или данных НЕТ на фото — верни ПУСТУЮ СТРОКУ "". НИКОГДА не выдумывай данные!
8. Рукописный текст: читай внимательно, учитывай характерные почерки. Если не уверен — лучше "".

Ответь СТРОГО в JSON:
{
  "doc": { "number": "", "date": "" },
  "driver": { "fio": "", "license": "" },
  "vehicle": { "plate": "", "brand": "", "trailer_plate": "", "trailer_brand": "" },
  "cargo": { "name": "", "weight": "", "count": "", "unit": "", "temp": "", "container_number": "" },
  "shipper": { "name": "", "inn": "", "address": "" },
  "consignee": { "name": "", "inn": "", "address": "" },
  "carrier": { "name": "", "inn": "" },
  "payer": { "name": "", "inn": "" },
  "route": { "loading_point": "", "unloading_point": "" }
}`
    ]);

    const extractedData = parseAiJson(extractResult.response.text());
    if (!extractedData) throw new Error('Не удалось разобрать данные накладной');

    // === ПОСТ-ОБРАБОТКА: Валидация нормализация ===
    
    // ИНН — проверка контрольной суммы
    if (extractedData.shipper) extractedData.shipper.inn = validateINN(extractedData.shipper.inn);
    if (extractedData.consignee) extractedData.consignee.inn = validateINN(extractedData.consignee.inn);
    if (extractedData.carrier) extractedData.carrier.inn = validateINN(extractedData.carrier.inn);
    if (extractedData.payer) extractedData.payer.inn = validateINN(extractedData.payer.inn);

    // Госномер — нормализация (латиница → кириллица, формат)
    if (extractedData.vehicle) {
      extractedData.vehicle.plate = normalizePlate(extractedData.vehicle.plate);
      extractedData.vehicle.trailer_plate = normalizePlate(extractedData.vehicle.trailer_plate);
    }

    // Масса — нормализация (кг → тонны, очистка)
    if (extractedData.cargo) {
      extractedData.cargo.weight = normalizeWeight(extractedData.cargo.weight);
    }

    // ФИО — валидация кириллицы
    if (extractedData.driver) {
      extractedData.driver.fio = validateFIO(extractedData.driver.fio);
    }

    // Обратная совместимость: добавляем extra.date из doc.date
    if (!extractedData.extra) extractedData.extra = {};
    extractedData.extra.date = extractedData.doc?.date || '';

    await dataBatch.set(`${userId}_result`, extractedData);
    await dataBatch.delete(`${userId}_ttn_file`);
    await dataBatch.delete(`${userId}_ttn_file_back`);

    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(extractedData), 'IDLE', userId]);

    await safeDelete(ctx, statusMsg.message_id);
    
    // Считаем сколько полей заполнено для статистики
    const filledFields = [
      extractedData.driver?.fio, extractedData.driver?.license,
      extractedData.vehicle?.plate, extractedData.vehicle?.brand,
      extractedData.cargo?.name, extractedData.cargo?.weight,
      extractedData.shipper?.name, extractedData.shipper?.inn,
      extractedData.consignee?.name, extractedData.consignee?.inn,
      extractedData.carrier?.name, extractedData.carrier?.inn
    ].filter(v => v && String(v).trim() !== '').length;
    
    await ctx.replyWithMarkdown(`✅ *Данные успешно распознаны!*\n📊 Заполнено полей: ${filledFields}/12`);
    return showReview(ctx, extractedData, tKey);

  } catch (e) {
    clearInterval(animInterval);
    console.error('[TTN OCR Error]', e);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_TTN_PHOTO', userId]);
    await safeDelete(ctx, statusMsg.message_id);
    await dataBatch.delete(`${userId}_ttn_file`);
    return ctx.reply('❌ Ошибка распознавания. Попробуйте сфотографировать ровнее ближе.');
  }
});


bot.action('confirm_template', async (ctx) => {
  const userId = ctx.from.id;
  const { hasLimit, plan, limit } = await checkLimit(userId);
  if (!hasLimit) {
    return ctx.replyWithMarkdown(`❌ *Лимит исчерпан!*\nНа тарифе *${plan}* доступно *${limit} ЭТрН*. Пожалуйста, пополните баланс.`);
  }

  const fId = await pendingTemplate.get(userId);
  if (!fId) return ctx.answerCbQuery('Ошибка: фото не найдено. Начните сначала.');

  await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['IDLE', ctx.from.id]); // Сбрасываем на время анализа

  const steps = [
    '🌀 *Агент приступает к проверке...*\n\n📡 _Считываю структуру бланка..._',
    '🌀 *Агент приступает к проверке...*\n\n🧠 _Анализирую чистоту шаблона..._',
    '🌀 *Агент приступает к проверке...*\n\n🔍 _Ищу признаки рукописного текста..._'
  ];
  const statusMsg = await ctx.reply(steps[0], { parse_mode: 'Markdown' });
  const animInterval = animateStatus(ctx, statusMsg.message_id, steps);

  try {
    const url = await ctx.telegram.getFileLink(fId);
    const resp = await fetch(url.href);
    const buffer = Buffer.from(await resp.arrayBuffer());

    const result = await callAiWithRetry(modelText, [
      { inlineData: { data: buffer.toString("base64"), mimeType: "image/jpeg" } },
      `CRITICAL TASK: Analyze this document image.
1. Is this a 'Товарно-транспортная накладная' (Waybill/TTN), 'Транспортная накладная' or a similar logistics form?
2. Is it a CLEAN, UNFILLED template?

DIRECTIONS:
- IGNORE all pre-printed text, form numbers (e.g., '1-Т', 'Приложение №...'), empty tables, and headers. They are part of the blank template.
- SEARCH ONLY for user-filled data: handwritten text, signatures, ink stamps (blue/red), or specific computer-filled details (like actual names, addresses, or cargo amounts in the cells).
- If the form has empty fields ready to be filled, it is an EMPTY template.

If it is a valid EMPTY template, reply ONLY with 'YES'.
Otherwise (if it's filled or not a waybill), reply ONLY with 'NO'.`
    ]);

    clearInterval(animInterval);

    const responseText = await result.response.text();
    console.log(`[AI Debug] Empty check response: "${responseText}"`);
    const text = responseText.toUpperCase();
    if (text.includes('YES')) {

      const countRes = await pool.query('SELECT COUNT(*) FROM templates WHERE telegram_id = $1', [ctx.from.id]);
      const nextType = parseInt(countRes.rows[0].count) + 1;

      await pool.query('UPDATE users SET current_template_id = $1, state = $2 WHERE telegram_id = $3', [fId, 'WAITING_NAME', ctx.from.id]);
      await pendingTemplate.delete(ctx.from.id);

      await safeDelete(ctx, statusMsg.message_id);
      const promptMsg = await ctx.reply(`✅ Шаблон подходит! Теперь введи название для этого шаблона (например, "Основной" или "Тип ${nextType}"):`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      });
      await dataBatch.set(`${ctx.from.id}_prompt_msg`, promptMsg.message_id);
      return promptMsg;
    } else {
      await safeDelete(ctx, statusMsg.message_id);
      return ctx.reply('❌ Это не похоже на пустой бланк ТТН. Пожалуйста, убедитесь, что вы прислали именно чистый шаблон накладной без рукописного текста.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Попробовать снова', 'upload_new_template')],
          [Markup.button.callback('🏠 В главное меню', 'cancel')]
        ])
      );
    }
  } catch (e) {
    clearInterval(animInterval);
    console.error(e);
    ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, 'Ошибка агента: ' + e.message);
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const user = (await pool.query('SELECT state, current_template_id FROM users WHERE telegram_id = $1', [userId])).rows[0];
  const input = ctx.message.text.trim();

  // --- ВЕРИФИКАЦИЯ КОМПАНИИ ---
  if (user?.state === 'WAITING_FOR_VERIFICATION_INFO') {
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['IDLE', userId]);
    
    const b2bMsg = `📝 <b>НОВАЯ ЗАЯВКА НА B2B ДОСТУП</b>\n\n` +
      `👤 <b>От:</b> ${ctx.from.first_name} (@${ctx.from.username || 'нет'})\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n\n` +
      `📄 <b>Данные компании:</b>\n${input}\n\n` +
      `<i>Для отправки счета скопируйте команду:</i>\n` +
      `<code>/invoice ${userId}</code>`;

    const supportChatId = await getSetting('support_chat_id');
    const supportThreadId = await getSetting('support_thread_id');

    if (supportChatId) {
      try {
        await ctx.telegram.sendMessage(supportChatId, b2bMsg, {
          parse_mode: 'HTML',
          message_thread_id: supportThreadId ? parseInt(supportThreadId) : undefined
        });
      } catch (e) { console.error(`Ошибка отправки B2B заявки в группу:`, e.message); }
    } else {
      for (const adminId of await getAdminIds()) {
        try {
          await ctx.telegram.sendMessage(adminId, b2bMsg, { parse_mode: 'HTML' });
        } catch (e) { /* ignore */ }
      }
    }

    return ctx.replyWithMarkdown(
      `✅ *Заявка принята!*\n\n` +
      `Данные отправлены администрации. Мы свяжемся с вами в ближайшее время для подтверждения доступа.\n\n` +
      `Если у вас есть срочные вопросы, напишите напрямую: ������ ��������� (������ � .env)`
    );
  }

  // 1. АВТОРИЗАЦИЯ СБИС
  if (user?.state === 'WAITING_AUTH_SBIS' || user?.state === 'WAITING_AUTH_RETRY') {
    const credentials = input.trim().split(' ');

    if (credentials.length < 2) {
      return ctx.reply('❌ Ошибка! Введите логин пароль через один пробел.\nПример: `79001112233 pass123`');
    }

    const login = credentials[0];
    const password = credentials.slice(1).join(' ');
    const statusMsg = await ctx.reply('⏳ Обращаюсь к серверу СБИС...');

    // Убираем кнопки у предыдущего сообщения с инструкцией
    const authMsgId = await dataBatch.get(`${userId}_auth_msg`);
    if (authMsgId) removeButtons(ctx, authMsgId);

    const authResult = await sbisAuthenticate(login, password);

    if (authResult.success) {
      const isRetry = user.state === 'WAITING_AUTH_RETRY';
      await pool.query('UPDATE users SET state = $1, sbis_sid = $2 WHERE telegram_id = $3', ['IDLE', authResult.sid, userId]);
      await safeDelete(ctx, statusMsg.message_id);

      if (isRetry) {
        // Возвращаем юзера к черновику
        const data = await getExtractedData(userId);
        const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
        await ctx.reply('✅ Авторизация обновлена. Возвращаемся к черновику...');
        return showReview(ctx, data, tKey);
      }

      return ctx.replyWithMarkdown(
        `✅ *Авторизация успешна!*\n\nКак вы хотите заполнить ЭТрН?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✍️ Ввести вручную (быстро, 7 шагов)', 'mode:manual')],
          [Markup.button.callback('📸 Сканировать бумажную ТТН (ИИ-распознавание)', 'mode:ocr')],
          [Markup.button.callback('🚫 Отмена', 'cancel')],
        ])
      );
    } else {
      await safeDelete(ctx, statusMsg.message_id);
      return ctx.replyWithMarkdown(
        `❌ *Ошибка входа:* \n${authResult.message}\n\nПроверь логин/пароль.`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
    }
  }

  // 2. РУЧНОЕ РЕДАКТИРОВАНИЕ (Любые поля)
  if (user?.state?.startsWith('EDITING_')) {
    if (input.length > 200) {
      return ctx.reply('❌ Ошибка: текст слишком длинный. Сократите до 200 символов попробуйте снова.');
    }
    const parts = user.state.split('_'); // Например: EDITING_CARGO_NAME
    const category = parts[1].toLowerCase();
    const field = parts[2].toLowerCase();

    let extractedData = await getExtractedData(userId);
    if (!extractedData) {
      extractedData = { driver: {}, vehicle: {}, cargo: {}, shipper: {}, consignee: {}, carrier: {}, extra: {} };
    }
    if (!extractedData[category]) extractedData[category] = {};

    // Валидация специфичных полей при редактировании
    if (category === 'extra' && field === 'date') {
      if (!/^(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[012])\.(20\d\d)$/.test(input.trim())) {
        return ctx.reply('❌ Ошибка! Дата должна быть строго в формате ДД.ММ.ГГГГ (например: 12.05.2024)');
      }
      extractedData[category][field] = input.trim();
    }
    else if (category === 'cargo' && field === 'weight') {
      const weight = parseFloat(input.replace(',', '.'));
      if (isNaN(weight) || weight <= 0) return ctx.reply('❌ Ошибка: введите корректный вес (число, например 5.2):');
      extractedData[category][field] = weight.toString();
    }
    else if (category === 'cargo' && field === 'count') {
      const count = parseInt(input);
      if (isNaN(count) || count <= 0) return ctx.reply('❌ Ошибка: введите целое число мест:');
      extractedData[category][field] = count.toString();
    }
    else if (category === 'vehicle' && field === 'plate') {
      const cleanPlate = input.replace(/[^А-ЯA-Z0-9]/gi, '').toUpperCase();
      const plateRegex = /^[А-ЯA-Z0-9]{6,10}$/i;
      if (!plateRegex.test(cleanPlate)) {
        return ctx.reply('⚠️ Не удалось распознать формат. Пожалуйста, введите госномер без пробелов (например: А001АА77):');
      }
      extractedData[category][field] = cleanPlate;
    }
    else {
      // Для текста (ФИО, названия компаний) убираем пробелы проверяем длину
      const cleanInput = input.trim();
      if (cleanInput.length < 2) {
        return ctx.reply('❌ Ошибка: значение слишком короткое. Введите корректные данные:');
      }
      extractedData[category][field] = cleanInput;
    }

    // Убираем кнопки у сообщения с запросом ввода
    const editMsgId = await dataBatch.get(`${userId}_edit_msg`);
    if (editMsgId) removeButtons(ctx, editMsgId);

    // Сохраняем в память, в БД
    await dataBatch.set(`${userId}_result`, extractedData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2 WHERE telegram_id = $3', [JSON.stringify(extractedData), 'IDLE', userId]);

    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    return showReview(ctx, extractedData, tKey);
  }

  // 0. ПОДДЕРЖКА (Обратная связь)
  if (user?.state === 'WAITING_SUPPORT_TEXT') {
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['IDLE', userId]);

    const { plan, limit, count } = await checkLimit(userId);
    const planNames = { trial: 'Пробный', custom: 'Индивидуальный', pack_10: 'Пакет 10', pack_100: 'Пакет 100', pack_300: 'Пакет 300' };

    const adminMsg =
      `🆘 <b>НОВОЕ ОБРАЩЕНИЕ В ПОДДЕРЖКУ</b>\n\n` +
      `👤 <b>От:</b> ${esc(ctx.from.first_name)} (@${esc(ctx.from.username || 'нет_юзвернейма')})\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n` +
      `💳 <b>Тариф:</b> ${planNames[plan] || plan}\n` +
      `📊 <b>Лимит:</b> ${count} / ${limit} ЭТрН\n\n` +
      `💬 <b>Текст:</b>\n${esc(input)}`;

    const supportChatId = await getSetting('support_chat_id');
    const supportThreadId = await getSetting('support_thread_id');

    if (supportChatId) {
      try {
        await ctx.telegram.sendMessage(supportChatId, adminMsg, {
          parse_mode: 'HTML',
          message_thread_id: supportThreadId ? parseInt(supportThreadId) : undefined
        });
      } catch (e) {
        console.error(`[Support] Ошибка отправки в группу ${supportChatId}:`, e.message);
      }
    } else {
      // Если группа не настроена — шлем админам в ЛС (старое поведение)
      const adminIds = await getAdminIds();
      for (const adminId of adminIds) {
        try {
          await ctx.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' });
        } catch (e) { console.error(`[Support] Ошибка пересылки админу ${adminId}:`, e.message); }
      }
    }

    await ctx.reply('✅ *Ваше сообщение отправлено администрации!* Мы свяжемся с вами в ближайшее время.',
      Markup.inlineKeyboard([[Markup.button.callback('🏠 В меню', 'cancel')]])
    );
    return;
  }

  // 3. НАЗВАНИЯ ШАБЛОНОВ
  if (user?.state === 'WAITING_NAME') {
    const nameRegex = /^[a-zA-Zа-яА-ЯёЁ0-9 ]+$/;

    if (input.length > 10 || !nameRegex.test(input)) {
      return ctx.reply('❌ Ошибка! Только буквы цифры до 10 знаков.');
    }

    // Убираем кнопки у "Введи название"
    const promptMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (promptMsgId) {
      removeButtons(ctx, promptMsgId);
      await dataBatch.delete(`${userId}_prompt_msg`);
    }

    await pool.query('INSERT INTO templates (telegram_id, file_id, name) VALUES ($1, $2, $3)', [userId, user.current_template_id, input]);
    await pool.query('UPDATE users SET state = $1 WHERE telegram_id = $2', ['WAITING_LICENSE', userId]);

    const promptMsg = await ctx.reply(`💾 Сохранено как "${input}". Присылай документы.`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    });
    await dataBatch.set(`${userId}_prompt_msg`, promptMsg.message_id);
    return promptMsg;
  }

  // 3б. ФИО ВОДИТЕЛЯ (ручной ввод без фото)
  if (user?.state === 'WAITING_DRIVER_FIO') {
    if (input.split(' ').length < 2 || input.length < 5 || input.length > 80)
      return ctx.reply('❌ Введи полное ФИО (минимум Фамилия Имя):');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {}, shipper: {}, consignee: {}, carrier: {}, extra: {} };
    if (!currentData.driver) currentData.driver = {};
    currentData.driver.fio = input;
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_VEHICLE_PLATE', userId]);
    const msg = await ctx.replyWithMarkdown(
      `✅ Водитель: \`${input}\`\n\n🚗 *Шаг 2 — Транспорт*\nВведи *госномер автомобиля*:\n_Пример:_ А001АА77`,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  // 3в. ГОСНОМЕР (ручной ввод без фото СТС)
  if (user?.state === 'WAITING_VEHICLE_PLATE') {
    const plateRegex = /^[А-ЯA-Z0-9]{6,10}$/i;
    const cleanPlate = input.replace(/[^А-ЯA-Z0-9]/gi, '').toUpperCase();
    if (!plateRegex.test(cleanPlate)) {
      return ctx.reply('⚠️ Не удалось распознать формат. Пожалуйста, введите госномер без пробелов (например: А001АА77):');
    }

    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {}, shipper: {}, consignee: {}, carrier: {}, extra: {} };
    if (!currentData.vehicle) currentData.vehicle = {};
    currentData.vehicle.plate = cleanPlate;
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_CARGO_NAME', userId]);
    const msg = await ctx.replyWithMarkdown(
      `✅ Госномер: \`${input.toUpperCase()}\`\n\n📦 *Шаг 3 — Груз*\nВведи *название груза* (${cp(tKey, 'name')}):`,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  // 4. ВВОД ДАННЫХ О ГРУЗЕ (динамически по типу ТС)
  if (user?.state === 'WAITING_CARGO_NAME') {
    if (input.length < 2 || input.length > 100)
      return ctx.reply('❌ Название от 2 до 100 символов. Попробуй ещё раз:');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {} };
    if (!currentData.cargo) currentData.cargo = {};
    currentData.cargo.name = input;
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2 WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_CARGO_WEIGHT', userId]);
    const msg = await ctx.replyWithMarkdown(
      `✅ Принято: \`${input}\`\n\nВведи *${cp(tKey, 'weight')}*:`,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  if (user?.state === 'WAITING_CARGO_WEIGHT') {
    const weight = parseFloat(input.replace(',', '.'));
    if (isNaN(weight) || weight <= 0 || weight > 9999)
      return ctx.reply('❌ Введи корректное значение (например: 5.2):');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    const trailer = TRAILER_TYPES[tKey] || TRAILER_TYPES.other;
    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {} };
    if (!currentData.cargo) currentData.cargo = {};
    currentData.cargo.weight = weight.toString();
    await dataBatch.set(`${userId}_result`, currentData);
    if (trailer.needsCount) {
      await pool.query('UPDATE users SET last_extracted_data = $1, state = $2 WHERE telegram_id = $3',
        [JSON.stringify(currentData), 'WAITING_CARGO_COUNT', userId]);
      const msg = await ctx.replyWithMarkdown(
        `✅ Принято: \`${weight}\`\n\nВведи *${cp(tKey, 'count')}*:`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
      await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    } else if (trailer.needsTemp) {
      await pool.query('UPDATE users SET last_extracted_data = $1, state = $2 WHERE telegram_id = $3',
        [JSON.stringify(currentData), 'WAITING_CARGO_TEMP', userId]);
      const msg = await ctx.replyWithMarkdown(
        `✅ Принято: \`${weight}\`\n\nВведи *${cp(tKey, 'temp')}*:`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
      await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    } else {
      await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
        [JSON.stringify(currentData), 'WAITING_SHIPPER', userId]);
      const msg = await ctx.replyWithMarkdown(
        `✅ Принято!\n\n🏢 *Грузоотправитель*\nВведи *Название компании или ФИО ИП* (от кого едет груз):`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
      await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    }
    return;
  }

  if (user?.state === 'WAITING_CARGO_COUNT') {
    const count = parseInt(input);
    if (isNaN(count) || count <= 0 || count > 99999)
      return ctx.reply('❌ Введи корректное число мест (целое число):');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    const trailer = TRAILER_TYPES[tKey] || TRAILER_TYPES.other;
    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {} };
    if (!currentData.cargo) currentData.cargo = {};
    currentData.cargo.count = count.toString();
    await dataBatch.set(`${userId}_result`, currentData);
    if (trailer.needsTemp) {
      await pool.query('UPDATE users SET last_extracted_data = $1, state = $2 WHERE telegram_id = $3',
        [JSON.stringify(currentData), 'WAITING_CARGO_TEMP', userId]);
      const msg = await ctx.replyWithMarkdown(
        `✅ Принято: \`${count}\`\n\nВведи *${cp(tKey, 'temp')}*:`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
      await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    } else {
      await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
        [JSON.stringify(currentData), 'WAITING_SHIPPER', userId]);
      const msg = await ctx.replyWithMarkdown(
        `✅ Принято!\n\n🏢 *Грузоотправитель*\nВведи *Название компании или ФИО ИП* (от кого едет груз):`,
        Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
      );
      await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    }
    return;
  }

  if (user?.state === 'WAITING_CARGO_TEMP') {
    if (input.length < 2 || input.length > 30)
      return ctx.reply('❌ Введи температурный режим (напр.: -18°C):');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    const currentData = (await getExtractedData(userId)) || { driver: {}, vehicle: {}, cargo: {} };
    if (!currentData.cargo) currentData.cargo = {};
    currentData.cargo.temp = input;
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_SHIPPER', userId]);
    const msg = await ctx.replyWithMarkdown(
      `✅ Принято!\n\n🏢 *Грузоотправитель*\nВведи *Название компании или ФИО ИП* (от кого едет груз):`,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  if (user?.state === 'WAITING_SHIPPER') {
    if (input.length < 2) return ctx.reply('❌ Введи название грузоотправителя:');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const currentData = (await getExtractedData(userId)) || {};
    currentData.shipper = { name: input.trim() };
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_CONSIGNEE', userId]);
    const msg = await ctx.replyWithMarkdown(
      `✅ Грузоотправитель: \`${input.trim()}\`\n\n🏢 *Грузополучатель*\nВведи *Название компании или ФИО ИП* (кому едет груз):`,
      Markup.inlineKeyboard([[Markup.button.callback('🚫 Отмена', 'cancel')]])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  if (user?.state === 'WAITING_CONSIGNEE') {
    if (input.length < 2) return ctx.reply('❌ Введи название грузополучателя:');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const currentData = (await getExtractedData(userId)) || {};
    currentData.consignee = { name: input.trim() };
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_CARRIER', userId]);
    const msg = await ctx.replyWithMarkdown(
      `✅ Грузополучатель: \`${input.trim()}\`\n\n🚚 *Перевозчик*\nВведи название транспортной компании или нажми кнопку ниже:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('👤 Я везу сам (как ИП/Физлицо)', 'carrier_self')],
        [Markup.button.callback('🏢 Совпадает с Отправителем', 'carrier_same')],
        [Markup.button.callback('🚫 Отмена', 'cancel')]
      ])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  if (user?.state === 'WAITING_CARRIER') {
    if (input.length < 2) return ctx.reply('❌ Введи название перевозчика:');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const currentData = (await getExtractedData(userId)) || {};
    currentData.carrier = { name: input.trim() };
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'WAITING_DATE', userId]);
    const today = new Date().toLocaleDateString('ru-RU');
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('ru-RU');
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('ru-RU');
    const msg = await ctx.replyWithMarkdown(
      `✅ Перевозчик: \`${input.trim()}\`\n\n📅 *Дата перевозки*\nВыбери или введи (ДД.ММ.ГГГГ):`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Вчера ${yesterday}`, 'date_yesterday')],
        [Markup.button.callback(`Сегодня ${today}`, 'date_today'), Markup.button.callback(`Завтра ${tomorrow}`, 'date_tomorrow')],
        [Markup.button.callback('🚫 Отмена', 'cancel')]
      ])
    );
    await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
    return;
  }

  if (user?.state === 'WAITING_DATE') {
    if (!/^(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[012])\.(20\d\d)$/.test(input.trim()))
      return ctx.reply('⚠️ Дата должна быть в формате ДД.ММ.ГГГГ (например: 12.05.2026). Попробуйте еще раз:');
    const prevMsgId = await dataBatch.get(`${userId}_prompt_msg`);
    if (prevMsgId) { await removeButtons(ctx, prevMsgId); await dataBatch.delete(`${userId}_prompt_msg`); }
    const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
    const currentData = (await getExtractedData(userId)) || {};
    if (!currentData.extra) currentData.extra = {};
    currentData.extra.date = input.trim();
    await dataBatch.set(`${userId}_result`, currentData);
    await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
      [JSON.stringify(currentData), 'IDLE', userId]);
    await showReview(ctx, currentData, tKey);
    return;
  }
});

// Действия: перевозчики + даты
const goToDate = async (ctx, carrierName) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const currentData = (await getExtractedData(userId)) || {};
  currentData.carrier = { name: carrierName };
  await dataBatch.set(`${userId}_result`, currentData);
  await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
    [JSON.stringify(currentData), 'WAITING_DATE', userId]);
  const today = new Date().toLocaleDateString('ru-RU');
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('ru-RU');
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('ru-RU');
  const msg = await ctx.replyWithMarkdown(
    `✅ Перевозчик: \`${carrierName}\`\n\n📅 *Дата перевозки*\nВыбери или введи (ДД.ММ.ГГГГ):`,
    Markup.inlineKeyboard([
      [Markup.button.callback(`Вчера ${yesterday}`, 'date_yesterday')],
      [Markup.button.callback(`Сегодня ${today}`, 'date_today'), Markup.button.callback(`Завтра ${tomorrow}`, 'date_tomorrow')],
      [Markup.button.callback('🚫 Отмена', 'cancel')]
    ])
  );
  await dataBatch.set(`${userId}_prompt_msg`, msg.message_id);
};

bot.action('carrier_self', async (ctx) => {
  const data = (await getExtractedData(ctx.from.id)) || {};
  await goToDate(ctx, data.driver?.fio || 'Водитель');
});
bot.action('carrier_same', async (ctx) => {
  const data = (await getExtractedData(ctx.from.id)) || {};
  await goToDate(ctx, data.shipper?.name || '—');
});

const setDate = async (ctx, dateStr) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery();
  await removeButtons(ctx, ctx.callbackQuery.message.message_id);
  const tKey = await dataBatch.get(`${userId}_trailer`) || 'other';
  const currentData = (await getExtractedData(userId)) || {};
  if (!currentData.extra) currentData.extra = {};
  currentData.extra.date = dateStr;
  await dataBatch.set(`${userId}_result`, currentData);
  await pool.query('UPDATE users SET last_extracted_data = $1, state = $2, state_updated_at = NOW() WHERE telegram_id = $3',
    [JSON.stringify(currentData), 'IDLE', userId]);
  await showReview(ctx, currentData, tKey);
};
bot.action('date_yesterday', ctx => setDate(ctx, new Date(Date.now() - 86400000).toLocaleDateString('ru-RU')));
bot.action('date_today', ctx => setDate(ctx, new Date().toLocaleDateString('ru-RU')));
bot.action('date_tomorrow', ctx => setDate(ctx, new Date(Date.now() + 86400000).toLocaleDateString('ru-RU')));

const start = async () => {
  await initDb();

  // Регистрация меню команд
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 ОТКРЫТЬ ГЛАВНОЕ МЕНЮ' },
    { command: 'create', description: '🚀 СОЗДАТЬ НОВУЮ ЭТрН' },
    { command: 'pricing', description: '💳 ТАРИФЫ И ЛИМИТЫ' },
    { command: 'support', description: '🛠 НАПИСАТЬ В ПОДДЕРЖКУ' },
    { command: 'legal', description: '⚖️ ЮРИДИЧЕСКАЯ ИНФОРМАЦИЯ' }
  ]);

  console.log('🚀 Бот запущен! Ожидаю сообщений...');
  bot.launch();
};

bot.catch(async (err, ctx) => {
  console.error(`🔴 Глобальная ошибка Telegraf:`, err);
  if (ctx && ctx.chat) {
    try {
      await ctx.reply('⚠️ Система перегружена. Попробуйте через минуту.');
    } catch (e) { console.error('Не смог отправить сообщение об ошибке', e); }
  }
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔴 Unhandled Rejection at:', promise, 'reason:', reason);
});
start();
process.once('SIGINT', () => { bot.stop('SIGINT'); pool.end().then(() => process.exit(0)); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); pool.end().then(() => process.exit(0)); });


