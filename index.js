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
        ['📊 СТАТУС', '🧰 СЛУЖБЫ'],
        ['📈 ИСТОРИЯ', '⚙️ СИСТЕМА']
    ]);
}

// Клавиатура статуса
function getStatusKeyboard() {
    return createKeyboard([
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

const liveSessions = {}; // Хранилище активных live-сессий статуса { interval, messageId }

// Остановка live-сессии для чата (статус/система)
async function stopLiveSession(chatId, deleteMessage = false) {
    const prev = liveSessions[chatId];
    if (!prev) return;

    if (prev.interval) {
        clearInterval(prev.interval);
    }

    if (deleteMessage && prev.messageId) {
        try {
            await bot.deleteMessage(chatId, prev.messageId);
        } catch (e) {
            // Сообщение уже могло быть удалено — игнорируем ошибку
        }
    }

    delete liveSessions[chatId];
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
    // Останавливаем предыдущий live, если был, и удаляем старое сообщение
    await stopLiveSession(ctx.chatId, true);

    const metrics = await system.getAllMetrics();
    const text = buildRealtimeStatusText(metrics);

    // 1) Отправляем live‑сообщение БЕЗ reply‑клавиатуры (его будем обновлять)
    const msg = await bot.sendMessage(ctx.chatId, text, { parse_mode: 'Markdown' });

    // 2) Отправляем отдельное сообщение с кнопкой "Назад" (клавиатура живёт в чате и так)
    await sendWithKeyboard(
        bot,
        ctx.chatId,
        'Для выхода из live‑режима нажмите кнопку ◀️ НАЗАД.',
        getStatusKeyboard(),
        'Markdown'
    );

    const interval = setInterval(async () => {
        try {
            const m = await system.getAllMetrics();
            const t = buildRealtimeStatusText(m);
            await bot.editMessageText(t, {
                chat_id: ctx.chatId,
                message_id: msg.message_id,
                parse_mode: 'Markdown'
            });
        } catch (error) {
            // Если текст не изменился, Telegram возвращает ошибку "message is not modified".
            // В этом случае не останавливаем live‑обновление.
            if (
                error.code === 'ETELEGRAM' &&
                error.response &&
                error.response.body &&
                typeof error.response.body.description === 'string' &&
                error.response.body.description.includes('message is not modified')
            ) {
                return;
            }

            console.error('Ошибка в live-статусе:', error);
            const session = liveSessions[ctx.chatId];
            if (session && session.interval) {
                clearInterval(session.interval);
            }
            delete liveSessions[ctx.chatId];
        }
    }, 1000);

    liveSessions[ctx.chatId] = { interval, messageId: msg.message_id };
}

// Службы
async function handleServices(ctx) {
    // Получаем статусы всех служб параллельно, чтобы не ждать каждую по очереди
    const statuses = await Promise.all(
        config.SERVICES.map(s => services.getServiceStatus(s.systemName))
    );

    const servicesList = config.SERVICES.map((s, index) => {
        const status = statuses[index];
        let emoji = '⚪';
        if (status.status === 'active') emoji = '🟢';
        else if (status.status === 'failed') emoji = '🔴';
        else if (status.status === 'activating') emoji = '🟡';
        else emoji = '⚫';

        return {
            ...s,
            emoji,
            status: status.status
        };
    });
    
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
    // При входе в раздел истории останавливаем live‑обновления
    await stopLiveSession(ctx.chatId, true);
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

// Система
async function handleSystem(ctx) {
    // При входе в раздел системы останавливаем live‑обновления
    await stopLiveSession(ctx.chatId, true);
    const text = `⚙️ *СИСТЕМА*\n\nВыберите действие:`;
    await sendWithKeyboard(bot, ctx.chatId, text, getSystemKeyboard());
}

// Построение текста детальной системной информации
function buildSystemDetailsText(metrics, distro) {
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
    return text;
}

// Детали системы в live-режиме (обновление сообщения каждую секунду)
async function handleSystemDetails(ctx) {
    // Останавливаем предыдущий live, если был, и удаляем старое сообщение
    await stopLiveSession(ctx.chatId, true);

    const metrics = await system.getAllMetrics();
    const distro = await system.getLinuxDistro();
    const text = buildSystemDetailsText(metrics, distro);

    const msg = await sendWithKeyboard(bot, ctx.chatId, text, getSystemKeyboard());

    const interval = setInterval(async () => {
        try {
            const m = await system.getAllMetrics();
            const t = buildSystemDetailsText(m, distro);
            await bot.editMessageText(t, {
                chat_id: ctx.chatId,
                message_id: msg.message_id,
                parse_mode: 'Markdown',
                reply_markup: getSystemKeyboard().reply_markup
            });
        } catch (error) {
            // Аналогично статусу — игнорируем "message is not modified"
            if (
                error.code === 'ETELEGRAM' &&
                error.response &&
                error.response.body &&
                typeof error.response.body.description === 'string' &&
                error.response.body.description.includes('message is not modified')
            ) {
                return;
            }

            console.error('Ошибка в live-системе:', error);
            const session = liveSessions[ctx.chatId];
            if (session && session.interval) {
                clearInterval(session.interval);
            }
            delete liveSessions[ctx.chatId];
        }
    }, 1000);

    liveSessions[ctx.chatId] = { interval, messageId: msg.message_id };
}

// Uptime
async function handleSystemUptime(ctx) {
    // Дополнительно останавливаем live‑обновления, если они идут
    await stopLiveSession(ctx.chatId, false);
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
    'menu_system': handleSystem,
    
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
        
        if (text === '🧰 СЛУЖБЫ' || text === '🧰 Службы') {
            await handleServices(ctx);
            return;
        }
        
        if (text === '📈 ИСТОРИЯ' || text === '📈 История') {
            await handleHistory(ctx);
            return;
        }

        if (text === '⚙️ СИСТЕМА' || text === '⚙️ Система') {
            await handleSystem(ctx);
            return;
        }
        
        // Навигация
        if (text === '◀️ НАЗАД' || text === '◀️ Назад' || text === 'Назад') {
            // При возврате в главное меню останавливаем все live‑обновления
            await stopLiveSession(ctx.chatId, true);
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
        
        // Система
        if (text === '📋 Детали') {
            await handleSystemDetails(ctx);
            return;
        }
        
        if (text === '⏱️ Uptime') {
            await handleSystemUptime(ctx);
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
