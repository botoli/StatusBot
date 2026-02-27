// index.js
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const system = require('./modules/system');
const AlertManager = require('./modules/alerts');
const ServiceManager = require('./modules/services');
const history = require('./modules/history');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');

// Инициализация
const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });
const alerts = new AlertManager(bot);
const services = new ServiceManager(bot);

// Загрузка серверов
let servers = [];
const serversPath = path.join(__dirname, 'servers.json');
try {
    if (fs.existsSync(serversPath)) {
        servers = JSON.parse(fs.readFileSync(serversPath, 'utf8'));
    } else {
        // Создаем дефолтный сервер
        servers = [{ name: 'local', host: 'localhost', token: '', isLocal: true }];
        fs.writeFileSync(serversPath, JSON.stringify(servers, null, 2));
    }
} catch (error) {
    console.error('Ошибка загрузки servers.json:', error);
    servers = [{ name: 'local', host: 'localhost', token: '', isLocal: true }];
}

// Текущий выбранный сервер (по умолчанию первый)
let currentServerIndex = 0;
function getCurrentServer() {
    return servers[currentServerIndex] || servers[0];
}

// ============== УТИЛИТЫ ==============

// Генератор обычной клавиатуры (ReplyKeyboardMarkup)
function createKeyboard(buttons, resize = true, oneTime = false) {
    return {
        reply_markup: {
            keyboard: buttons,
            resize_keyboard: resize,
            one_time_keyboard: oneTime
        }
    };
}

// Удалить клавиатуру
function removeKeyboard() {
    return {
        reply_markup: {
            remove_keyboard: true
        }
    };
}

// Главная клавиатура
function getMainKeyboard() {
    return createKeyboard([
        ['📊 СТАТУС', '🌐 СЕТЬ'],
        ['🧰 СЛУЖБЫ', '📈 ИСТОРИЯ'],
        ['🔔 АЛЕРТЫ', '⚙️ СИСТЕМА'],
        ['🌐 Измерить интернет', '📊 Система'],
        ['🖥 СЕРВЕРЫ']
    ]);
}

// Клавиатура статуса
function getStatusKeyboard() {
    return createKeyboard([
        ['◀️ НАЗАД']
    ]);
}

// Клавиатура сети
function getNetworkKeyboard() {
    return createKeyboard([
        ['📊 Все интерфейсы', '⚡ Скорость'],
        ['◀️ НАЗАД']
    ]);
}

// Клавиатура истории
function getHistoryKeyboard() {
    return createKeyboard([
        ['🕐 24ч', '🕑 48ч'],
        ['📅 7д', '📅 30д'],
        ['◀️ НАЗАД']
    ]);
}

// Клавиатура алертов
function getAlertsKeyboard() {
    return createKeyboard([
        ['⚡ CPU +5', '⚡ CPU -5', '🔔 CPU'],
        ['🧠 RAM +5', '🧠 RAM -5', '🔔 RAM'],
        ['💽 DISK +5', '💽 DISK -5', '🔔 DISK'],
        ['🔥 TEMP +5', '🔥 TEMP -5', '🔔 TEMP'],
        ['🌐 СЕТЬ +10MB', '🌐 СЕТЬ -10MB', '🔔 СЕТЬ'],
        ['💾 Сохранить', '◀️ НАЗАД']
    ]);
}

// Клавиатура системы
function getSystemKeyboard() {
    return createKeyboard([
        ['📋 Детали'],
        ['⏱️ Uptime'],
        ['◀️ НАЗАД']
    ]);
}

// Отправка сообщения с клавиатурой
async function sendWithKeyboard(bot, chatId, text, keyboard, parseMode = 'Markdown') {
    return await bot.sendMessage(chatId, text, {
        parse_mode: parseMode,
        ...keyboard
    });
}

// Безопасное редактирование (для обратной совместимости с callback_query)
async function safeEdit(ctx, text, buttons, parseMode = 'Markdown') {
    try {
        // Если это callback_query, редактируем сообщение
        if (ctx.query) {
            await ctx.bot.editMessageText(text, {
                chat_id: ctx.chatId,
                message_id: ctx.messageId,
                parse_mode: parseMode,
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            // Если это обычное сообщение, отправляем новое с главной клавиатурой
            await sendWithKeyboard(bot, ctx.chatId, text, getMainKeyboard(), parseMode);
        }
        return true;
    } catch (error) {
        if (error.code === 'ETELEGRAM' && error.response?.body?.description?.includes('message is not modified')) {
            if (ctx.query) {
                await ctx.bot.answerCallbackQuery(ctx.query.id, { text: '✅ Данные актуальны' });
            }
            return false;
        }
        throw error;
    }
}

// ============== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ СТАТУСА ==============

const liveIntervals = {}; // Хранилище активных интервалов статуса

function stopLive(chatId) {
    if (liveIntervals[chatId]) {
        clearInterval(liveIntervals[chatId]);
        delete liveIntervals[chatId];
    }
}

function getStatusColor(percent) {
    if (percent >= 80) return '🔴';
    if (percent >= 50) return '🟡';
    return '🟢';
}

function getBlockBar(percent, blocks = 10) {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round(clamped / 100 * blocks);
    const empty = blocks - filled;
    return '🟩'.repeat(filled) + '⬜️'.repeat(empty);
}

function buildRealtimeStatusText(metrics) {
    let text = `🖥 ${os.hostname()}\n`;
    text += '────────────\n\n';

    // Название процессора
    const cpus = os.cpus && os.cpus();
    if (cpus && cpus.length > 0 && cpus[0].model) {
        text += `${cpus[0].model.trim()}\n\n`;
    }

    const cpuPercent = parseFloat(metrics.cpu.current) || 0;
    const ramPercent = parseFloat(metrics.memory.percent) || 0;
    const diskPercent = metrics.disk ? parseInt(metrics.disk.percent) || 0 : null;

    // CPU
    text += `CPU  ${getStatusColor(cpuPercent)} ${cpuPercent.toFixed(0)}%\n`;
    text += `${getBlockBar(cpuPercent)}\n\n`;

    // RAM
    text += `RAM  ${getStatusColor(ramPercent)} ${ramPercent.toFixed(0)}%\n`;
    text += `${getBlockBar(ramPercent)}\n`;
    // Объём RAM
    if (metrics.memory && metrics.memory.used && metrics.memory.total) {
        text += `${metrics.memory.used}GB / ${metrics.memory.total}GB\n\n`;
    } else {
        text += '\n';
    }

    // DISK
    if (diskPercent !== null) {
        text += `DISK ${getStatusColor(diskPercent)} ${diskPercent.toFixed(0)}%\n`;
        text += `${getBlockBar(diskPercent)}\n`;
        if (metrics.disk && metrics.disk.used && metrics.disk.total) {
            text += `${metrics.disk.used} / ${metrics.disk.total}\n\n`;
        } else {
            text += '\n';
        }
    }

    // Температура и аптайм
    let tempStr = 'N/A';
    if (metrics.temperature && metrics.temperature.cpu) {
        tempStr = `${metrics.temperature.cpu.toFixed(0)}°C`;
    }
    text += `🌡️ ${tempStr}   ⏱️ ${metrics.uptime}\n`;

    // Сеть
    if (metrics.network) {
        const rx = system.formatBytes(metrics.network.rxBytes);
        const tx = system.formatBytes(metrics.network.txBytes);
        text += `↓${rx} ↑${tx}`;
    }

    return text;
}

// Middleware
function adminOnly(handler) {
    return async (msg, ...args) => {
        if (msg.chat.id !== config.ADMIN_ID) {
            return bot.sendMessage(msg.chat.id, '⛔ Нет доступа');
        }
        try {
            return await handler(msg, ...args);
        } catch (error) {
            console.error(`❌ Ошибка:`, error);
            bot.sendMessage(msg.chat.id, '❌ Внутренняя ошибка');
        }
    };
}

// Создание контекста из сообщения
function createContextFromMessage(msg) {
    return {
        chatId: msg.chat.id,
        messageId: msg.message_id,
        msg: msg,
        bot: bot,
        services: services,
        system: system,
        history: history,
        config: config
    };
}

// Создание контекста из callback (для обратной совместимости)
function createContext(query) {
    return {
        chatId: query.message.chat.id,
        messageId: query.message.message_id,
        query: query,
        bot: bot,
        services: services,
        system: system,
        history: history,
        config: config
    };
}

// ============== ОБРАБОТЧИКИ ==============

// Главное меню
async function handleMainMenu(ctx) {
    const currentServer = getCurrentServer();
    const text = `🖥 *Мониторинг сервера ${currentServer.name}*\n\nВыберите раздел:`;
    
    if (ctx.msg) {
        // Обычное сообщение
        await sendWithKeyboard(bot, ctx.chatId, text, getMainKeyboard());
    } else {
        // Callback (для обратной совместимости)
        await bot.sendMessage(ctx.chatId, text, getMainKeyboard());
    }
}

// Статус
async function handleStatus(ctx) {
    // Останавливаем предыдущий live, если был
    stopLive(ctx.chatId);

    const metrics = await system.getAllMetrics();
    const text = buildRealtimeStatusText(metrics);

    const msg = await sendWithKeyboard(bot, ctx.chatId, text, getStatusKeyboard());

    const interval = setInterval(async () => {
        try {
            const m = await system.getAllMetrics();
            const t = buildRealtimeStatusText(m);
            await bot.editMessageText(t, {
                chat_id: ctx.chatId,
                message_id: msg.message_id,
                parse_mode: 'Markdown',
                reply_markup: getStatusKeyboard().reply_markup
            });
        } catch (error) {
            console.error('Ошибка в live-статусе:', error);
            stopLive(ctx.chatId);
        }
    }, 1000);

    liveIntervals[ctx.chatId] = interval;
}

// Службы
async function handleServices(ctx) {
    const servicesList = [];
    for (const s of config.SERVICES) {
        const status = await services.getServiceStatus(s.systemName);
        let emoji = '⚪';
        if (status.status === 'active') emoji = '🟢';
        else if (status.status === 'failed') emoji = '🔴';
        else if (status.status === 'activating') emoji = '🟡';
        else emoji = '⚫';
        
        servicesList.push({
            ...s,
            emoji,
            status: status.status
        });
    }
    
    let text = `🧰 *СЛУЖБЫ*\n\n🟢 active\n🟡 activating\n🔴 failed\n⚫ stopped\n\n`;
    servicesList.forEach(s => {
        text += `${s.emoji} ${s.name}\n`;
    });
    
    // Для обычных сообщений используем клавиатуру
    if (ctx.msg) {
        const servicesKeyboard = createKeyboard([
            ...servicesList.map(s => [`${s.emoji} ${s.name}`]),
            ['🔄 Обновить все', '◀️ НАЗАД']
        ]);
        await sendWithKeyboard(bot, ctx.chatId, text, servicesKeyboard);
    } else {
        // Для callback_query используем inline клавиатуру
        const buttons = servicesList.map(s => ([
            { text: `${s.emoji} ${s.name}`, callback_data: `service_${s.systemName}` }
        ]));
        buttons.push([{ text: "🔄 Обновить все", callback_data: "services_refresh" }]);
        buttons.push([{ text: "◀️ Назад", callback_data: "back_main" }]);
        await safeEdit(ctx, text, buttons);
    }
}

// Детали службы
async function handleService(ctx, serviceName) {
    const service = config.SERVICES.find(s => s.systemName === serviceName);
    if (!service) {
        await bot.sendMessage(ctx.chatId, '❌ Служба не найдена');
        return;
    }
    
    const status = await services.getServiceStatus(serviceName);
    
    let emoji = '⚪';
    if (status.status === 'active') emoji = '🟢';
    else if (status.status === 'failed') emoji = '🔴';
    else if (status.status === 'activating') emoji = '🟡';
    else emoji = '⚫';
    
    let text = `${emoji} *${service.name}*\n\n`;
    text += `Статус: *${status.status}*\n`;
    if (status.pid) text += `PID: ${status.pid}\n`;
    if (status.memory) text += `Память: ${status.memory}\n`;
    text += `\nВыберите действие:`;
    
    const buttons = [
        [
            { text: "▶️ Start", callback_data: `confirm_start_${serviceName}` },
            { text: "⏹️ Stop", callback_data: `confirm_stop_${serviceName}` }
        ],
        [
            { text: "🔄 Restart", callback_data: `confirm_restart_${serviceName}` }
        ],
        [
            { text: "📋 Logs 20", callback_data: `logs_${serviceName}_20` },
            { text: "📋 Logs 50", callback_data: `logs_${serviceName}_50` }
        ],
        [
            { text: "🔄 Обновить", callback_data: `service_${serviceName}` },
            { text: "◀️ Назад", callback_data: "back_services" }
        ]
    ];
    
    // Если это callback_query, редактируем сообщение
    if (ctx.query) {
        await safeEdit(ctx, text, buttons);
    } else {
        // Если это обычное сообщение, отправляем новое с inline-кнопками
        await bot.sendMessage(ctx.chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        });
    }
}

// Подтверждение действия
async function handleConfirm(ctx, action, serviceName) {
    const service = config.SERVICES.find(s => s.systemName === serviceName);
    
    await safeEdit(
        ctx,
        `⚠️ *Подтверждение*\n\n${action} службу *${service.name}*?`,
        [
            [
                { text: "✅ ДА", callback_data: `do_${action}_${serviceName}` },
                { text: "❌ НЕТ", callback_data: `service_${serviceName}` }
            ]
        ]
    );
}

// Выполнение действия
async function handleDoAction(ctx, action, serviceName) {
    const service = config.SERVICES.find(s => s.systemName === serviceName);
    
    await ctx.bot.answerCallbackQuery(ctx.query.id, { text: `⏳ Выполняю ${action}...` });
    
    const result = await services.controlService(serviceName, action);
    
    if (result.success) {
        await ctx.bot.sendMessage(ctx.chatId, `✅ *${service.name}*: ${action} выполнен`, {
            parse_mode: 'Markdown'
        });
        
        // Возвращаемся к службе
        await handleService(ctx, serviceName);
    } else {
        await ctx.bot.sendMessage(ctx.chatId, `❌ Ошибка: ${result.message}`);
    }
}

// Логи
async function handleLogs(ctx, serviceName, lines) {
    const service = config.SERVICES.find(s => s.systemName === serviceName);
    const logs = await services.getServiceLogs(serviceName, lines);
    
    await ctx.bot.sendMessage(
        ctx.chatId,
        `📋 *Логи ${service.name} (${lines} строк)*\n\`\`\`\n${logs.substring(0, 3500)}\n\`\`\``,
        { parse_mode: 'Markdown' }
    );
    
    await ctx.bot.answerCallbackQuery(ctx.query.id);
}

// История
async function handleHistory(ctx) {
    const text = `📈 *ИСТОРИЯ*\n\nВыберите период:`;
    await sendWithKeyboard(bot, ctx.chatId, text, getHistoryKeyboard());
}

// Показать статистику с красивым форматированием
async function handleHistPeriod(ctx, hours) {
    if (ctx.query) {
        await ctx.bot.answerCallbackQuery(ctx.query.id, { text: `⏳ Загружаю статистику за ${hours}ч...` });
    } else {
        await bot.sendMessage(ctx.chatId, `⏳ Загружаю статистику за ${hours}ч...`);
    }
    
    const [cpuHistory, memHistory, diskHistory, cpuStats, memStats, diskStats, tempStats] = await Promise.all([
        history.getHistory('cpu', hours),
        history.getHistory('memory', hours),
        history.getHistory('disk', hours),
        history.getStats('cpu', hours),
        history.getStats('memory', hours),
        history.getStats('disk', hours),
        history.getStats('temperature', hours)
    ]);
    
    // Красивое форматирование истории
    let text = `📈 *ИСТОРИЯ ЗА ${hours}Ч*\n`;
    text += '═'.repeat(30) + '\n\n';
    
    // CPU
    if (cpuStats && cpuHistory.length > 0) {
        const avgCpu = parseFloat(cpuStats.avg);
        const maxCpu = parseFloat(cpuStats.max);
        const minCpu = parseFloat(cpuStats.min);
        
        text += `⚡ *CPU*\n`;
        text += system.getLoadBar(avgCpu, 20) + '\n';
        text += `   📊 Среднее: *${avgCpu}%*\n`;
        text += `   📈 Максимум: *${maxCpu}%*\n`;
        text += `   📉 Минимум: *${minCpu}%*\n`;
        text += `   📐 Точек данных: ${cpuStats.points}\n\n`;
    }
    
    // RAM
    if (memStats && memHistory.length > 0) {
        const avgRam = parseFloat(memStats.avg);
        const maxRam = parseFloat(memStats.max);
        const minRam = parseFloat(memStats.min);
        
        text += `🧠 *RAM*\n`;
        text += system.getLoadBar(avgRam, 20) + '\n';
        text += `   📊 Среднее: *${avgRam}%*\n`;
        text += `   📈 Максимум: *${maxRam}%*\n`;
        text += `   📉 Минимум: *${minRam}%*\n`;
        text += `   📐 Точек данных: ${memStats.points}\n\n`;
    }
    
    // DISK
    if (diskStats && diskHistory.length > 0) {
        const avgDisk = parseFloat(diskStats.avg);
        const maxDisk = parseFloat(diskStats.max);
        const minDisk = parseFloat(diskStats.min);
        
        text += `💽 *DISK*\n`;
        text += system.getLoadBar(avgDisk, 20) + '\n';
        text += `   📊 Среднее: *${avgDisk}%*\n`;
        text += `   📈 Максимум: *${maxDisk}%*\n`;
        text += `   📉 Минимум: *${minDisk}%*\n`;
        text += `   📐 Точек данных: ${diskStats.points}\n\n`;
    }
    
    // TEMPERATURE
    if (tempStats) {
        const avgTemp = parseFloat(tempStats.avg);
        const maxTemp = parseFloat(tempStats.max);
        const minTemp = parseFloat(tempStats.min);
        const emoji = system.getTempEmoji(maxTemp);
        
        text += `${emoji} *TEMPERATURE*\n`;
        text += `   📊 Среднее: *${avgTemp}°C*\n`;
        text += `   📈 Максимум: *${maxTemp}°C*\n`;
        text += `   📉 Минимум: *${minTemp}°C*\n`;
        text += `   📐 Точек данных: ${tempStats.points}\n\n`;
    }
    
    if (!cpuStats && !memStats && !diskStats && !tempStats) {
        text += `⚠️ *Нет данных за последние ${hours}ч*\n`;
        text += `Попробуйте выбрать другой период.`;
    }
    
    await sendWithKeyboard(bot, ctx.chatId, text, getHistoryKeyboard());
}

// Алерты
async function handleAlerts(ctx) {
    const networkThreshold = system.formatBytes(config.THRESHOLDS.NETWORK_SPEED || 100 * 1024 * 1024) + '/s';
    
    let text = `🔔 *АЛЕРТЫ*\n`;
    text += '═'.repeat(25) + '\n\n';
    
    // CPU
    const cpuStatus = alerts.enabled?.cpu ? '🔔' : '🔕';
    text += `⚡ *CPU*\n`;
    text += `   Порог: *${config.THRESHOLDS.CPU}%* ${cpuStatus}\n\n`;
    
    // RAM
    const ramStatus = alerts.enabled?.ram ? '🔔' : '🔕';
    text += `🧠 *RAM*\n`;
    text += `   Порог: *${config.THRESHOLDS.RAM}%* ${ramStatus}\n\n`;
    
    // DISK
    const diskStatus = alerts.enabled?.disk ? '🔔' : '🔕';
    text += `💽 *DISK*\n`;
    text += `   Порог: *${config.THRESHOLDS.DISK}%* ${diskStatus}\n\n`;
    
    // TEMP
    const tempStatus = alerts.enabled?.temp ? '🔔' : '🔕';
    text += `🔥 *TEMP*\n`;
    text += `   Порог: *${config.THRESHOLDS.TEMP_CPU}°C* ${tempStatus}\n\n`;
    
    // NETWORK
    const networkStatus = alerts.enabled?.network ? '🔔' : '🔕';
    text += `🌐 *СЕТЬ*\n`;
    text += `   Порог: *${networkThreshold}* ${networkStatus}\n`;
    
    await sendWithKeyboard(bot, ctx.chatId, text, getAlertsKeyboard());
}

// Выбор сервера
async function handleServers(ctx) {
    let text = `🖥 *ВЫБОР СЕРВЕРА*\n\nТекущий: *${getCurrentServer().name}*\n\nВыберите сервер:`;
    
    // Для обычных сообщений используем клавиатуру
    if (ctx.msg) {
        const serversKeyboard = createKeyboard([
            ...servers.map((server, index) => {
                const prefix = index === currentServerIndex ? '✅' : '⚪';
                return [`${prefix} ${server.name}`];
            }),
            ['◀️ НАЗАД']
        ]);
        await sendWithKeyboard(bot, ctx.chatId, text, serversKeyboard);
    } else {
        // Для callback_query используем inline клавиатуру
        const buttons = servers.map((server, index) => {
            const prefix = index === currentServerIndex ? '✅' : '⚪';
            return [{ text: `${prefix} ${server.name}`, callback_data: `server_select_${index}` }];
        });
        buttons.push([{ text: "◀️ Назад", callback_data: "back_main" }]);
        await safeEdit(ctx, text, buttons);
    }
}

// Сетевой мониторинг
async function handleNetwork(ctx) {
    const text = `🌐 *СЕТЕВОЙ МОНИТОРИНГ*\n\nВыберите действие:`;
    await sendWithKeyboard(bot, ctx.chatId, text, getNetworkKeyboard());
}

// Все сетевые интерфейсы
async function handleNetworkAll(ctx) {
    if (ctx.query) {
        await ctx.bot.answerCallbackQuery(ctx.query.id, { text: '⏳ Загружаю статистику...' });
    }
    
    const allStats = await system.getAllNetworkStats();
    
    if (allStats.length === 0) {
        await sendWithKeyboard(bot, ctx.chatId, '❌ *Нет доступных сетевых интерфейсов*', getNetworkKeyboard());
        return;
    }
    
    let text = `🌐 *ВСЕ СЕТЕВЫЕ ИНТЕРФЕЙСЫ*\n`;
    text += '═'.repeat(30) + '\n\n';
    
    for (const stat of allStats) {
        const ips = await system.getInterfaceIPs(stat.interface);
        text += `📡 *${stat.interface}*\n`;
        if (ips.length > 0) {
            text += `   🌐 IP: \`${ips.join('`, `')}\`\n`;
        }
        text += `   ⬇️ RX: *${stat.rxFormatted}*\n`;
        text += `      📦 ${stat.rxPackets.toLocaleString()} пакетов\n`;
        text += `   ⬆️ TX: *${stat.txFormatted}*\n`;
        text += `      📦 ${stat.txPackets.toLocaleString()} пакетов\n`;
        text += `   📊 Всего: *${stat.totalFormatted}*\n`;
        text += '\n';
    }
    
    await sendWithKeyboard(bot, ctx.chatId, text, getNetworkKeyboard());
}

// Список интерфейсов для выбора
async function handleNetworkInterfaces(ctx) {
    const interfaces = await system.getNetworkInterfaces();
    
    if (interfaces.length === 0) {
        await sendWithKeyboard(bot, ctx.chatId, '❌ *Нет доступных сетевых интерфейсов*', getNetworkKeyboard());
        return;
    }
    
    // Создаем клавиатуру с интерфейсами
    const keyboardButtons = interfaces.map(iface => [`📡 ${iface}`]);
    keyboardButtons.push(['◀️ НАЗАД']);
    
    const text = `🌐 *ВЫБОР ИНТЕРФЕЙСА*\n\nВыберите интерфейс для детальной информации:`;
    await sendWithKeyboard(bot, ctx.chatId, text, createKeyboard(keyboardButtons));
}

// Детали конкретного интерфейса
async function handleNetworkInterface(ctx, interfaceName) {
    if (ctx.query) {
        await ctx.bot.answerCallbackQuery(ctx.query.id, { text: '⏳ Загружаю...' });
    }
    
    const stat = await system.getNetworkStats(interfaceName);
    const ips = await system.getInterfaceIPs(interfaceName);
    
    if (!stat) {
        await bot.sendMessage(ctx.chatId, `❌ Не удалось получить статистику для ${interfaceName}`);
        return;
    }
    
    let text = `📡 *${interfaceName}*\n`;
    text += '═'.repeat(30) + '\n\n';
    
    if (ips.length > 0) {
        text += `🌐 *IP адреса*\n`;
        ips.forEach(ip => {
            text += `   • \`${ip}\`\n`;
        });
        text += '\n';
    }
    
    text += `📊 *Статистика*\n`;
    text += `   ⬇️ Принято:\n`;
    text += `      ${stat.rxFormatted}\n`;
    text += `      📦 ${stat.rxPackets.toLocaleString()} пакетов\n\n`;
    text += `   ⬆️ Отправлено:\n`;
    text += `      ${stat.txFormatted}\n`;
    text += `      📦 ${stat.txPackets.toLocaleString()} пакетов\n\n`;
    text += `   📊 Всего: *${stat.totalFormatted}*\n`;
    
    // Создаем специальную клавиатуру для интерфейса
    const interfaceKeyboard = createKeyboard([
        ['⚡ Скорость'],
        ['◀️ НАЗАД']
    ]);
    
    await sendWithKeyboard(bot, ctx.chatId, text, interfaceKeyboard);
}

// Скорость сети
async function handleNetworkSpeed(ctx, interfaceName = null) {
    if (ctx.query) {
        await ctx.bot.answerCallbackQuery(ctx.query.id, { text: '⏳ Измеряю скорость...' });
    } else {
        await bot.sendMessage(ctx.chatId, '⏳ Измеряю скорость...');
    }
    
    if (!interfaceName) {
        interfaceName = await system.getMainInterface();
        if (!interfaceName) {
            await bot.sendMessage(ctx.chatId, '❌ Не удалось определить основной интерфейс');
            return;
        }
    }
    
    // Первое измерение
    const firstStat = await system.getNetworkStats(interfaceName);
    if (!firstStat) {
        await bot.sendMessage(ctx.chatId, `❌ Не удалось получить статистику для ${interfaceName}`);
        return;
    }
    
    // Ждем 1 секунду
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Второе измерение
    const speed = await system.getNetworkSpeed(interfaceName, firstStat);
    
    if (!speed) {
        await bot.sendMessage(ctx.chatId, `❌ Ошибка измерения скорости`);
        return;
    }
    
    let text = `⚡ *СКОРОСТЬ СЕТИ*\n`;
    text += `📡 *${interfaceName}*\n`;
    text += '═'.repeat(25) + '\n\n';
    text += `⬇️ *Входящая*\n   ${speed.rxSpeedFormatted}\n\n`;
    text += `⬆️ *Исходящая*\n   ${speed.txSpeedFormatted}\n\n`;
    text += `📊 *Общая*\n   *${speed.totalSpeedFormatted}*\n`;
    
    await sendWithKeyboard(bot, ctx.chatId, text, getNetworkKeyboard());
}

// График сетевой активности - удалено (графики убраны)

// Система
async function handleSystem(ctx) {
    const text = `⚙️ *СИСТЕМА*\n\nВыберите действие:`;
    await sendWithKeyboard(bot, ctx.chatId, text, getSystemKeyboard());
}

// Детали системы
async function handleSystemDetails(ctx) {
    const metrics = await system.getAllMetrics();
    const distro = await system.getLinuxDistro();
    
    let text = `📋 *ДЕТАЛЬНАЯ ИНФОРМАЦИЯ*\n`;
    text += '═'.repeat(30) + '\n\n';
    
    // Системная информация
    text += `🖥 *Система*\n`;
    text += `   Hostname: ${os.hostname()}\n`;
    text += `   OS: ${distro}\n`;
    text += `   Platform: ${os.platform()}\n`;
    text += `   Arch: ${os.arch()}\n`;
    text += `   Kernel: ${os.release()}\n`;
    text += `   ⏱️ Uptime: ${metrics.uptime}\n`;
    if (metrics.voltage) {
        text += `   ⚡ Voltage: ${metrics.voltage}\n`;
    }
    text += '\n';
    
    // CPU детально
    const cpuPercent = parseFloat(metrics.cpu.current);
    text += `⚡ *CPU*\n`;
    text += system.getLoadBar(cpuPercent) + '\n';
    text += `   Load Average:\n`;
    text += `   • 1 min:  ${metrics.cpu.load1}\n`;
    text += `   • 5 min:  ${metrics.cpu.load5}\n`;
    text += `   • 15 min: ${metrics.cpu.load15}\n`;
    text += `   Cores: ${os.cpus().length}\n`;
    text += '\n';
    
    // RAM детально
    const ramPercent = parseFloat(metrics.memory.percent);
    text += `🧠 *RAM*\n`;
    text += system.getLoadBar(ramPercent) + '\n';
    text += system.getProgressBar(
        parseFloat(metrics.memory.used),
        parseFloat(metrics.memory.total),
        '   ',
        'GB',
        15
    ) + '\n';
    text += `   Free: ${metrics.memory.free}GB\n`;
    text += '\n';
    
    // Disk детально
    if (metrics.disk) {
        const diskPercent = parseInt(metrics.disk.percent);
        text += `💽 *DISK*\n`;
        text += system.getLoadBar(diskPercent) + '\n';
        text += `   Used: ${metrics.disk.used}\n`;
        text += `   Free: ${metrics.disk.free}\n`;
        text += `   Total: ${metrics.disk.total}\n`;
        text += '\n';
    }
    
    // Temperature детально
    if (metrics.temperature.cpu || metrics.temperature.gpu || metrics.temperature.ssd) {
        text += `🌡️ *TEMPERATURE*\n`;
        if (metrics.temperature.cpu) {
            const emoji = system.getTempEmoji(metrics.temperature.cpu);
            text += `   ${emoji} CPU: ${metrics.temperature.cpu.toFixed(1)}°C\n`;
        }
        if (metrics.temperature.gpu) {
            const emoji = system.getTempEmoji(metrics.temperature.gpu);
            text += `   ${emoji} GPU: ${metrics.temperature.gpu.toFixed(1)}°C\n`;
        }
        if (metrics.temperature.ssd) {
            const emoji = system.getTempEmoji(metrics.temperature.ssd);
            text += `   ${emoji} SSD: ${metrics.temperature.ssd.toFixed(1)}°C\n`;
        }
        text += '\n';
    }
    
    // Network детально
    if (metrics.network) {
        text += `🌐 *NETWORK*\n`;
        text += `   Interface: ${metrics.network.interface}\n`;
        text += `   ⬇️ RX: ${system.formatBytes(metrics.network.rxBytes)} (${metrics.network.rxPackets.toLocaleString()} пакетов)\n`;
        text += `   ⬆️ TX: ${system.formatBytes(metrics.network.txBytes)} (${metrics.network.txPackets.toLocaleString()} пакетов)\n`;
        text += `   📊 Total: ${system.formatBytes(metrics.network.rxBytes + metrics.network.txBytes)}\n`;
    }
    
    await sendWithKeyboard(bot, ctx.chatId, text, getSystemKeyboard());
}

// Uptime
async function handleSystemUptime(ctx) {
    const metrics = await system.getAllMetrics();
    const text = `⏱️ *АПТАЙМ*: ${metrics.uptime}`;
    await sendWithKeyboard(bot, ctx.chatId, text, getSystemKeyboard());
}

// ============== РОУТЕР ==============
const routeHandlers = {
    // Навигация
    'back_main': handleMainMenu,
    'back_services': handleServices,
    
    // Меню
    'menu_status': handleStatus,
    'menu_services': handleServices,
    'menu_history': handleHistory,
    'menu_alerts': handleAlerts,
    'menu_system': handleSystem,
    'menu_network': handleNetwork,
    
    // Серверы
    'menu_servers': handleServers,
    
    // Сеть
    'network_all': handleNetworkAll,
    'network_interfaces': handleNetworkInterfaces,
    'network_speed': handleNetworkSpeed,
    
    // Система
    'system_details': handleSystemDetails,
    'system_uptime': handleSystemUptime,
    
    // Обновления
    'services_refresh': handleServices
};

// ============== ЗАПУСК ==============

// Автоматика
alerts.startMonitoring();

// Первая точка истории
(async () => {
    try {
        const metrics = await system.getAllMetrics();
        await history.addPoint(metrics);
        console.log('📊 Первая точка истории добавлена');
    } catch (error) {
        console.error('❌ Ошибка при первом сборе истории:', error);
    }
})();

// Сбор истории
setInterval(async () => {
    try {
        const metrics = await system.getAllMetrics();
        await history.addPoint(metrics);
        // Логируем для отладки температуры
        if (metrics.temperature) {
            if (metrics.temperature.cpu) {
                console.log(`🌡️ Температура CPU: ${metrics.temperature.cpu}°C - сохранена в историю`);
            } else {
                console.log(`⚠️ Температура CPU не получена (значение: ${metrics.temperature.cpu})`);
            }
        } else {
            console.log(`⚠️ Объект temperature отсутствует в метриках`);
        }
    } catch (error) {
        console.error('❌ Ошибка сбора истории:', error);
    }
}, config.INTERVALS.HISTORY);

// Очистка истории
setInterval(async () => {
    try {
        await history.cleanup();
        console.log('🧹 История очищена');
    } catch (error) {
        console.error('❌ Ошибка очистки истории:', error);
    }
}, config.INTERVALS.CLEANUP);

// ============== КОМАНДЫ ==============
bot.onText(/\/start/, adminOnly(async (msg) => {
    const currentServer = getCurrentServer();
    const ctx = createContextFromMessage(msg);
    await handleMainMenu(ctx);
}));

// Обработчик текстовых сообщений (кнопки клавиатуры)
bot.on('message', async (msg) => {
    if (msg.chat.id !== config.ADMIN_ID) {
        return bot.sendMessage(msg.chat.id, '⛔ Нет доступа');
    }
    
    // Игнорируем команды (они обрабатываются отдельно)
    if (msg.text && msg.text.startsWith('/')) {
        return;
    }
    
    if (!msg.text) return;
    
    const ctx = createContextFromMessage(msg);
    const text = msg.text.trim();
    
    try {
        // Главное меню
        if (text === '📊 СТАТУС' || text === '📊 Статус') {
            await handleStatus(ctx);
            return;
        }
        
        if (text === '🌐 СЕТЬ' || text === '🌐 Сеть') {
            await handleNetwork(ctx);
            return;
        }
        
        if (text === '🧰 СЛУЖБЫ' || text === '🧰 Службы') {
            await handleServices(ctx);
            return;
        }
        
        if (text === '📈 ИСТОРИЯ' || text === '📈 История') {
            await handleHistory(ctx);
            return;
        }
        
        if (text === '🔔 АЛЕРТЫ' || text === '🔔 Алерты') {
            await handleAlerts(ctx);
            return;
        }
        
        if (text === '⚙️ СИСТЕМА' || text === '⚙️ Система') {
            await handleSystem(ctx);
            return;
        }
        
        if (text === '🖥 СЕРВЕРЫ' || text === '🖥 Серверы') {
            await handleServers(ctx);
            return;
        }
        
        // Навигация
        if (text === '◀️ НАЗАД' || text === '◀️ Назад' || text === 'Назад') {
            await handleMainMenu(ctx);
            return;
        }
        
        
        // История
        if (text === '🕐 24ч') {
            await handleHistPeriod(ctx, 24);
            return;
        }
        
        if (text === '🕑 48ч') {
            await handleHistPeriod(ctx, 48);
            return;
        }
        
        if (text === '📅 7д') {
            await handleHistPeriod(ctx, 168);
            return;
        }
        
        if (text === '📅 30д') {
            await handleHistPeriod(ctx, 720);
            return;
        }
        
        // Сеть - выбор интерфейса
        if (text.startsWith('📡 ')) {
            const interfaceName = text.replace('📡 ', '');
            await handleNetworkInterface(ctx, interfaceName);
            return;
        }
        
        
        // Система
        if (text === '📋 Детали') {
            await handleSystemDetails(ctx);
            return;
        }
        
        if (text === '⏱️ Uptime') {
            await handleSystemUptime(ctx);
            return;
        }
        
        // Сеть
        if (text === '📊 Все интерфейсы') {
            await handleNetworkAll(ctx);
            return;
        }
        
        if (text === '🔍 Выбрать') {
            await handleNetworkInterfaces(ctx);
            return;
        }
        
        if (text === '⚡ Скорость') {
            await handleNetworkSpeed(ctx);
            return;
        }
        
        // Быстрые кнопки
        if (text === '🌐 Измерить интернет' || text === '🌐 Измерить Интернет') {
            await handleNetworkSpeed(ctx);
            return;
        }
        
        if (text === '📊 Система' || text === '📊 Система-данные') {
            await handleSystemDetails(ctx);
            return;
        }
        
        if (text === '🧰 Службы' || text === '🧰 СЛУЖБЫ') {
            await handleServices(ctx);
            return;
        }
        
        // Обработка нажатий на службы (кнопки клавиатуры)
        if (text === '🔄 Обновить все') {
            await handleServices(ctx);
            return;
        }
        
        // Проверяем, является ли текст названием службы
        // Кнопка имеет формат: "🟢 📁 File Browser" или "⚫ 🐳 Docker"
        // Проверяем по названию службы (без эмодзи статуса)
        const service = config.SERVICES.find(s => {
            // Убираем эмодзи статуса (🟢, 🟡, 🔴, ⚫) из начала текста
            const textWithoutStatusEmoji = text.replace(/^[🟢🟡🔴⚫⚪]\s*/, '');
            // Сравниваем с названием службы
            return textWithoutStatusEmoji === s.name || text.includes(s.name);
        });
        
        if (service) {
            await handleService(ctx, service.systemName);
            return;
        }
        
        // Алерты
        if (text.startsWith('⚡ CPU +5')) {
            config.THRESHOLDS.CPU = Math.min(100, config.THRESHOLDS.CPU + 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('⚡ CPU -5')) {
            config.THRESHOLDS.CPU = Math.max(10, config.THRESHOLDS.CPU - 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text === '🔔 CPU') {
            if (!alerts.enabled) alerts.enabled = {};
            alerts.enabled.cpu = !alerts.enabled.cpu;
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('🧠 RAM +5')) {
            config.THRESHOLDS.RAM = Math.min(100, config.THRESHOLDS.RAM + 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('🧠 RAM -5')) {
            config.THRESHOLDS.RAM = Math.max(10, config.THRESHOLDS.RAM - 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text === '🔔 RAM') {
            if (!alerts.enabled) alerts.enabled = {};
            alerts.enabled.ram = !alerts.enabled.ram;
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('💽 DISK +5')) {
            config.THRESHOLDS.DISK = Math.min(100, config.THRESHOLDS.DISK + 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('💽 DISK -5')) {
            config.THRESHOLDS.DISK = Math.max(10, config.THRESHOLDS.DISK - 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text === '🔔 DISK') {
            if (!alerts.enabled) alerts.enabled = {};
            alerts.enabled.disk = !alerts.enabled.disk;
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('🔥 TEMP +5')) {
            config.THRESHOLDS.TEMP_CPU = Math.min(120, config.THRESHOLDS.TEMP_CPU + 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('🔥 TEMP -5')) {
            config.THRESHOLDS.TEMP_CPU = Math.max(30, config.THRESHOLDS.TEMP_CPU - 5);
            await handleAlerts(ctx);
            return;
        }
        
        if (text === '🔔 TEMP') {
            if (!alerts.enabled) alerts.enabled = {};
            alerts.enabled.temp = !alerts.enabled.temp;
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('🌐 СЕТЬ +10MB')) {
            config.THRESHOLDS.NETWORK_SPEED = Math.min(1000 * 1024 * 1024, (config.THRESHOLDS.NETWORK_SPEED || 100 * 1024 * 1024) + 10 * 1024 * 1024);
            await handleAlerts(ctx);
            return;
        }
        
        if (text.startsWith('🌐 СЕТЬ -10MB')) {
            config.THRESHOLDS.NETWORK_SPEED = Math.max(10 * 1024 * 1024, (config.THRESHOLDS.NETWORK_SPEED || 100 * 1024 * 1024) - 10 * 1024 * 1024);
            await handleAlerts(ctx);
            return;
        }
        
        if (text === '🔔 СЕТЬ') {
            if (!alerts.enabled) alerts.enabled = {};
            alerts.enabled.network = !alerts.enabled.network;
            await handleAlerts(ctx);
            return;
        }
        
        if (text === '💾 Сохранить') {
            config.saveThresholds();
            await bot.sendMessage(ctx.chatId, '✅ Пороги сохранены');
            await handleAlerts(ctx);
            return;
        }
        
    } catch (error) {
        console.error('❌ Ошибка в обработчике сообщений:', error);
        await bot.sendMessage(msg.chat.id, '❌ Ошибка обработки команды');
    }
});

// ============== ОБРАБОТЧИК КНОПОК ==============
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    
    if (chatId !== config.ADMIN_ID) {
        return bot.answerCallbackQuery(query.id, { text: '⛔ Нет доступа' });
    }
    
    const ctx = createContext(query);
    const data = query.data;
    
    try {
        // Роутинг по точному совпадению
        if (routeHandlers[data]) {
            await routeHandlers[data](ctx);
            return;
        }
        
        // Динамические маршруты
        
        // История с периодом
        if (data.startsWith('hist_')) {
            const hours = parseInt(data.split('_')[1]);
            await handleHistPeriod(ctx, hours);
            return;
        }
        
        // Выбор службы
        if (data.startsWith('service_')) {
            const serviceName = data.split('_')[1];
            await handleService(ctx, serviceName);
            return;
        }
        
        // Подтверждения
        if (data.startsWith('confirm_')) {
            const parts = data.split('_');
            const action = parts[1];
            const serviceName = parts[2];
            await handleConfirm(ctx, action, serviceName);
            return;
        }
        
        // Выполнение действий
        if (data.startsWith('do_')) {
            const parts = data.split('_');
            const action = parts[1];
            const serviceName = parts[2];
            await handleDoAction(ctx, action, serviceName);
            return;
        }
        
        // Логи
        if (data.startsWith('logs_')) {
            const parts = data.split('_');
            const serviceName = parts[1];
            const lines = parseInt(parts[2]);
            await handleLogs(ctx, serviceName, lines);
            return;
        }
        
        // Алерты
        if (data.startsWith('alert_')) {
            const parts = data.split('_');
            const type = parts[1];
            const op = parts[2];
            
            let thresholdKey = type.toUpperCase();
            if (type === 'temp') thresholdKey = 'TEMP_CPU';
            if (type === 'network') thresholdKey = 'NETWORK_SPEED';
            
            let current = config.THRESHOLDS[thresholdKey] || (thresholdKey === 'NETWORK_SPEED' ? 100 * 1024 * 1024 : 80);
            
            if (op === 'plus') {
                if (thresholdKey === 'TEMP_CPU') current = Math.min(120, current + 5);
                else if (thresholdKey === 'NETWORK_SPEED') current = Math.min(1000 * 1024 * 1024, current + 10 * 1024 * 1024); // +10MB/s
                else current = Math.min(100, current + 5);
            }
            if (op === 'minus') {
                if (thresholdKey === 'TEMP_CPU') current = Math.max(30, current - 5);
                else if (thresholdKey === 'NETWORK_SPEED') current = Math.max(10 * 1024 * 1024, current - 10 * 1024 * 1024); // -10MB/s
                else current = Math.max(10, current - 5);
            }
            
            config.THRESHOLDS[thresholdKey] = current;
            await handleAlerts(ctx);
            return;
        }
        
        // Сохранение порогов
        if (data === 'alert_save') {
            config.saveThresholds();
            await ctx.bot.answerCallbackQuery(ctx.query.id, { text: '✅ Пороги сохранены' });
            await handleAlerts(ctx);
            return;
        }
        
        // Toggle алертов
        if (data.startsWith('toggle_')) {
            const type = data.split('_')[1];
            if (!alerts.enabled) alerts.enabled = {};
            alerts.enabled[type] = !alerts.enabled[type];
            await handleAlerts(ctx);
            return;
        }
        
        // Сетевые интерфейсы
        if (data.startsWith('network_iface_')) {
            const interfaceName = data.replace('network_iface_', '');
            await handleNetworkInterface(ctx, interfaceName);
            return;
        }
        
        // Скорость сети для конкретного интерфейса
        if (data.startsWith('network_speed_')) {
            const interfaceName = data.replace('network_speed_', '');
            await handleNetworkSpeed(ctx, interfaceName);
            return;
        }
        
        
        // Выбор сервера
        if (data.startsWith('server_select_')) {
            const index = parseInt(data.split('_')[2]);
            if (index >= 0 && index < servers.length) {
                currentServerIndex = index;
                await ctx.bot.answerCallbackQuery(ctx.query.id, { text: `✅ Выбран сервер: ${servers[index].name}` });
                await handleMainMenu(ctx);
            }
            return;
        }
        
        console.warn('Неизвестный callback:', data);
        await bot.answerCallbackQuery(query.id);
        
    } catch (error) {
        console.error('❌ Ошибка в callback:', error);
        await bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
    }
});

// ============== ЛОГИ ==============
console.log(`🖥 Host: ${os.hostname()}`);
console.log(`✅ Бот запущен с роутером и контекстом`);
console.log(`👤 Admin ID: ${config.ADMIN_ID}`);
console.log(`📊 Режим: профессиональный`);
