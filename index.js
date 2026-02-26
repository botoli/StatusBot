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

// Инициализация
const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });
const alerts = new AlertManager(bot);
const services = new ServiceManager(bot);

// ============== УТИЛИТЫ ==============

// Генератор меню
function menu(buttons) {
    return { reply_markup: { inline_keyboard: buttons } };
}

// Безопасное редактирование
async function safeEdit(ctx, text, buttons, parseMode = 'Markdown') {
    try {
        await ctx.bot.editMessageText(text, {
            chat_id: ctx.chatId,
            message_id: ctx.messageId,
            parse_mode: parseMode,
            ...menu(buttons)
        });
        return true;
    } catch (error) {
        if (error.code === 'ETELEGRAM' && error.response?.body?.description?.includes('message is not modified')) {
            await ctx.bot.answerCallbackQuery(ctx.query.id, { text: '✅ Данные актуальны' });
            return false;
        }
        throw error;
    }
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

// Создание контекста
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
    await safeEdit(
        ctx,
        `🖥 *Мониторинг сервера ${os.hostname()}*\n\nВыберите раздел:`,
        [
            [{ text: "📊 СТАТУС", callback_data: "menu_status" }],
            [{ text: "🧰 СЛУЖБЫ", callback_data: "menu_services" }],
            [{ text: "📈 ИСТОРИЯ", callback_data: "menu_history" }],
            [{ text: "🔔 АЛЕРТЫ", callback_data: "menu_alerts" }],
            [{ text: "⚙️ СИСТЕМА", callback_data: "menu_system" }]
        ]
    );
}

// Статус
async function handleStatus(ctx) {
    const metrics = await system.getAllMetrics();
    
    let text = `📊 *СТАТУС ${os.hostname()}*\n\n`;
    text += `⚡ CPU: ${metrics.cpu.current}%\n`;
    text += `🧠 RAM: ${metrics.memory.percent}%\n`;
    if (metrics.disk) text += `💽 DISK: ${metrics.disk.percent}%\n`;
    if (metrics.temperature.cpu) {
        const emoji = system.getTempEmoji(metrics.temperature.cpu);
        text += `${emoji} TEMP: ${metrics.temperature.cpu.toFixed(1)}°C\n`;
    }
    text += `\n⏱️ Uptime: ${metrics.uptime}`;
    
    await safeEdit(
        ctx,
        text,
        [
            [{ text: "🔄 Обновить", callback_data: "menu_status" }],
            [{ text: "🔴 LIVE 5s", callback_data: "live_status" }],
            [{ text: "◀️ Назад", callback_data: "back_main" }]
        ]
    );
}

// LIVE режим
async function handleLiveStatus(ctx) {
    let count = 0;
    const liveMsg = await ctx.bot.sendMessage(ctx.chatId, "🔴 *LIVE режим*\nОбновление каждые 5 секунд", { parse_mode: 'Markdown' });
    
    const interval = setInterval(async () => {
        try {
            const metrics = await system.getAllMetrics();
            let text = `🔴 *LIVE СТАТУС* (обновление 5с)\n\n`;
            text += `⚡ CPU: ${metrics.cpu.current}%\n`;
            text += `🧠 RAM: ${metrics.memory.percent}%\n`;
            if (metrics.temperature.cpu) {
                const emoji = system.getTempEmoji(metrics.temperature.cpu);
                text += `${emoji} TEMP: ${metrics.temperature.cpu.toFixed(1)}°C\n`;
            }
            
            await ctx.bot.editMessageText(text, {
                chat_id: ctx.chatId,
                message_id: liveMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "⏹️ Остановить", callback_data: "live_stop" }]
                    ]
                }
            });
            
            count++;
            if (count >= 12) { // 60 секунд (12 * 5с)
                clearInterval(interval);
                await ctx.bot.editMessageText("⏹️ *LIVE режим завершён*", {
                    chat_id: ctx.chatId,
                    message_id: liveMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "📊 Вернуться к статусу", callback_data: "menu_status" }]
                        ]
                    }
                });
            }
        } catch (error) {
            clearInterval(interval);
        }
    }, 5000);
    
    await ctx.bot.answerCallbackQuery(ctx.query.id);
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
    
    const buttons = servicesList.map(s => ([
        { text: `${s.emoji} ${s.name}`, callback_data: `service_${s.systemName}` }
    ]));
    
    buttons.push([{ text: "🔄 Обновить все", callback_data: "services_refresh" }]);
    buttons.push([{ text: "◀️ Назад", callback_data: "back_main" }]);
    
    await safeEdit(ctx, `🧰 *СЛУЖБЫ*\n\n🟢 active\n🟡 activating\n🔴 failed\n⚫ stopped`, buttons);
}

// Детали службы
async function handleService(ctx, serviceName) {
    const service = config.SERVICES.find(s => s.systemName === serviceName);
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
    
    // Кнопки с подтверждением для опасных действий
    await safeEdit(
        ctx,
        text,
        [
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
        ]
    );
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
    await safeEdit(
        ctx,
        `📈 *ИСТОРИЯ*\n\nВыберите период:`,
        [
            [
                { text: "🕐 24ч", callback_data: "hist_24" },
                { text: "🕑 48ч", callback_data: "hist_48" }
            ],
            [
                { text: "📅 7д", callback_data: "hist_168" },
                { text: "📅 30д", callback_data: "hist_720" }
            ],
            [{ text: "◀️ Назад", callback_data: "back_main" }]
        ]
    );
}

// Показать статистику
async function handleHistPeriod(ctx, hours) {
    await ctx.bot.answerCallbackQuery(ctx.query.id, { text: `⏳ Загружаю статистику за ${hours}ч...` });
    
    const [cpuStats, memStats, diskStats, tempStats] = await Promise.all([
        history.getStats('cpu', hours),
        history.getStats('memory', hours),
        history.getStats('disk', hours),
        history.getStats('temperature', hours)
    ]);
    
    let text = `📈 *Статистика за ${hours}ч*\n\n`;
    if (cpuStats) text += `📊 CPU: min ${cpuStats.min}%, max ${cpuStats.max}%, avg ${cpuStats.avg}%\n`;
    if (memStats) text += `🧠 RAM: min ${memStats.min}%, max ${memStats.max}%, avg ${memStats.avg}%\n`;
    if (diskStats) text += `💽 DISK: min ${diskStats.min}%, max ${diskStats.max}%, avg ${diskStats.avg}%\n`;
    if (tempStats) {
        const emoji = system.getTempEmoji(parseFloat(tempStats.max));
        text += `${emoji} TEMP: min ${tempStats.min}°C, max ${tempStats.max}°C, avg ${tempStats.avg}°C\n`;
    }
    
    await safeEdit(ctx, text, [
        [
            { text: "🕐 24ч", callback_data: "hist_24" },
            { text: "🕑 48ч", callback_data: "hist_48" }
        ],
        [
            { text: "📅 7д", callback_data: "hist_168" },
            { text: "📅 30д", callback_data: "hist_720" }
        ],
        [{ text: "◀️ Назад", callback_data: "back_main" }]
    ]);
}

// Алерты
async function handleAlerts(ctx) {
    const text = `🔔 *АЛЕРТЫ*\n\n` +
        `⚡ CPU: ${config.THRESHOLDS.CPU}% (${alerts.enabled?.cpu ? '🔔' : '🔕'})\n` +
        `🧠 RAM: ${config.THRESHOLDS.RAM}% (${alerts.enabled?.ram ? '🔔' : '🔕'})\n` +
        `💽 DISK: ${config.THRESHOLDS.DISK}% (${alerts.enabled?.disk ? '🔔' : '🔕'})\n` +
        `🔥 TEMP: ${config.THRESHOLDS.TEMP_CPU}°C (${alerts.enabled?.temp ? '🔔' : '🔕'})`;
    
    await safeEdit(ctx, text, [
        [
            { text: "⚡ CPU +5", callback_data: "alert_cpu_plus" },
            { text: "⚡ CPU -5", callback_data: "alert_cpu_minus" },
            { text: alerts.enabled?.cpu ? "🔕" : "🔔", callback_data: "toggle_cpu" }
        ],
        [
            { text: "🧠 RAM +5", callback_data: "alert_ram_plus" },
            { text: "🧠 RAM -5", callback_data: "alert_ram_minus" },
            { text: alerts.enabled?.ram ? "🔕" : "🔔", callback_data: "toggle_ram" }
        ],
        [
            { text: "💽 DISK +5", callback_data: "alert_disk_plus" },
            { text: "💽 DISK -5", callback_data: "alert_disk_minus" },
            { text: alerts.enabled?.disk ? "🔕" : "🔔", callback_data: "toggle_disk" }
        ],
        [{ text: "◀️ Назад", callback_data: "back_main" }]
    ]);
}

// Система
async function handleSystem(ctx) {
    await safeEdit(ctx, `⚙️ *СИСТЕМА*\n\nВыберите действие:`, [
        [{ text: "📊 Статус", callback_data: "menu_status" }],
        [{ text: "📋 Детали", callback_data: "system_details" }],
        [{ text: "📊 TOP", callback_data: "system_top" }],
        [{ text: "⏱️ Uptime", callback_data: "system_uptime" }],
        [{ text: "◀️ Назад", callback_data: "back_main" }]
    ]);
}

// Детали системы
async function handleSystemDetails(ctx) {
    const metrics = await system.getAllMetrics();
    
    let text = `📋 *ДЕТАЛЬНАЯ ИНФОРМАЦИЯ*\n\n`;
    text += `⏱️ Uptime: ${metrics.uptime}\n`;
    if (metrics.voltage) text += `⚡ Voltage: ${metrics.voltage}\n`;
    text += `\n📊 CPU: ${metrics.cpu.current}%\n`;
    text += `   Load: ${metrics.cpu.load1}, ${metrics.cpu.load5}, ${metrics.cpu.load15}\n`;
    text += `\n🧠 RAM: ${metrics.memory.used}GB / ${metrics.memory.total}GB (${metrics.memory.percent}%)\n`;
    if (metrics.disk) {
        text += `\n💽 DISK: ${metrics.disk.used} / ${metrics.disk.total} (${metrics.disk.percent}%)\n`;
    }
    
    await safeEdit(ctx, text, [
        [{ text: "🔄 Обновить", callback_data: "system_details" }],
        [{ text: "◀️ Назад", callback_data: "menu_system" }]
    ]);
}

// TOP
async function handleSystemTop(ctx) {
    const { stdout } = await execPromise('top -bn1 | head -15');
    await safeEdit(
        ctx,
        '📊 *TOP ПРОЦЕССОВ*\n```\n' + stdout + '\n```',
        [
            [{ text: "🔄 Обновить", callback_data: "system_top" }],
            [{ text: "◀️ Назад", callback_data: "menu_system" }]
        ],
        'Markdown'
    );
}

// Uptime
async function handleSystemUptime(ctx) {
    const metrics = await system.getAllMetrics();
    await safeEdit(
        ctx,
        `⏱️ *АПТАЙМ*: ${metrics.uptime}`,
        [
            [{ text: "🔄 Обновить", callback_data: "system_uptime" }],
            [{ text: "◀️ Назад", callback_data: "menu_system" }]
        ]
    );
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
    
    // LIVE
    'live_status': handleLiveStatus,
    'live_stop': handleMainMenu,
    
    // Система
    'system_details': handleSystemDetails,
    'system_top': handleSystemTop,
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
    await bot.sendMessage(
        msg.chat.id,
        `🖥 *Мониторинг сервера ${os.hostname()}*\n\nВыберите раздел:`,
        {
            parse_mode: 'Markdown',
            ...menu([
                [{ text: "📊 СТАТУС", callback_data: "menu_status" }],
                [{ text: "🧰 СЛУЖБЫ", callback_data: "menu_services" }],
                [{ text: "📈 ИСТОРИЯ", callback_data: "menu_history" }],
                [{ text: "🔔 АЛЕРТЫ", callback_data: "menu_alerts" }],
                [{ text: "⚙️ СИСТЕМА", callback_data: "menu_system" }]
            ])
        }
    );
}));

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
            
            let current = config.THRESHOLDS[type.toUpperCase()];
            if (op === 'plus') current = Math.min(100, current + 5);
            if (op === 'minus') current = Math.max(10, current - 5);
            
            config.THRESHOLDS[type.toUpperCase()] = current;
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
