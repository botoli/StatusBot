// modules/services.js
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const config = require('../config');

class ServiceManager {
    constructor(bot) {
        this.bot = bot;
    }

    // Получить статус конкретной службы
    async getServiceStatus(serviceName) {
        // Сначала пробуем без sudo
        try {
            const { stdout } = await execPromise(`systemctl status ${serviceName} --no-pager -n 5`);
            const activeMatch = stdout.match(/Active: (\w+)/);
            const status = activeMatch ? activeMatch[1] : 'unknown';
            
            // Парсим дополнительную информацию
            const loadMatch = stdout.match(/Loaded: (.+?)\n/);
            const loaded = loadMatch ? loadMatch[1] : 'unknown';
            
            const pidMatch = stdout.match(/Main PID: (\d+)/);
            const pid = pidMatch ? pidMatch[1] : null;
            
            const memoryMatch = stdout.match(/Memory: ([\d.]+[KMG])/i);
            const memory = memoryMatch ? memoryMatch[1] : null;
            
            return {
                name: serviceName,
                status,
                loaded,
                pid,
                memory,
                details: stdout.split('\n').slice(-5).join('\n')
            };
        } catch (error) {
            // Если не получилось без sudo, пробуем с sudo
            try {
                const sudoPassword = process.env.SUDO_PASSWORD;
                let stdout;
                
                if (sudoPassword) {
                    // Используем пароль из переменной окружения
                    const result = await execPromise(
                        `echo '${sudoPassword}' | sudo -S systemctl status ${serviceName} --no-pager -n 5`
                    );
                    stdout = result.stdout;
                } else {
                    // Пробуем без пароля
                    const result = await execPromise(`sudo systemctl status ${serviceName} --no-pager -n 5`);
                    stdout = result.stdout;
                }
                
                const activeMatch = stdout.match(/Active: (\w+)/);
                const status = activeMatch ? activeMatch[1] : 'unknown';
                
                const loadMatch = stdout.match(/Loaded: (.+?)\n/);
                const loaded = loadMatch ? loadMatch[1] : 'unknown';
                
                const pidMatch = stdout.match(/Main PID: (\d+)/);
                const pid = pidMatch ? pidMatch[1] : null;
                
                const memoryMatch = stdout.match(/Memory: ([\d.]+[KMG])/i);
                const memory = memoryMatch ? memoryMatch[1] : null;
                
                return {
                    name: serviceName,
                    status,
                    loaded,
                    pid,
                    memory,
                    details: stdout.split('\n').slice(-5).join('\n')
                };
            } catch (sudoError) {
                return {
                    name: serviceName,
                    status: 'inactive',
                    details: error.stdout || error.message || sudoError.message
                };
            }
        }
    }

    // Управление службой (start/stop/restart)
    async controlService(serviceName, action) {
        // Сначала пробуем без sudo
        try {
            const { stdout } = await execPromise(`systemctl ${action} ${serviceName}`);
            return { success: true, message: stdout || `Служба ${action} выполнена` };
        } catch (error) {
            // Если не получилось без sudo, пробуем с sudo
            try {
                // Проверяем, есть ли пароль в переменной окружения
                const sudoPassword = process.env.SUDO_PASSWORD;
                
                if (sudoPassword) {
                    // Используем echo для передачи пароля в sudo через -S
                    const { stdout } = await execPromise(
                        `echo '${sudoPassword}' | sudo -S systemctl ${action} ${serviceName}`
                    );
                    return { success: true, message: stdout || `Служба ${action} выполнена` };
                } else {
                    // Пробуем без пароля (если настроен NOPASSWD)
                    const { stdout } = await execPromise(`sudo systemctl ${action} ${serviceName}`);
                    return { success: true, message: stdout || `Служба ${action} выполнена` };
                }
            } catch (sudoError) {
                // Проверяем, требует ли sudo пароль
                if (sudoError.message && sudoError.message.includes('password')) {
                    return { 
                        success: false, 
                        message: 'Требуется настройка sudo. Варианты:\n\n' +
                                '1. Установите переменную окружения:\n' +
                                '   export SUDO_PASSWORD="ваш_пароль"\n\n' +
                                '2. Или настройте sudo без пароля:\n' +
                                '   sudo visudo\n' +
                                '   Добавьте: YOUR_USER ALL=(ALL) NOPASSWD: /bin/systemctl\n\n' +
                                '3. Или запустите бота от root пользователя.'
                    };
                }
                return { success: false, message: sudoError.message || error.message };
            }
        }
    }

    // Получить логи службы
    async getServiceLogs(serviceName, lines = 20) {
        // Сначала пробуем без sudo
        try {
            const { stdout } = await execPromise(`journalctl -u ${serviceName} -n ${lines} --no-pager`);
            return stdout;
        } catch (error) {
            // Если не получилось без sudo, пробуем с sudo
            try {
                const sudoPassword = process.env.SUDO_PASSWORD;
                let stdout;
                
                if (sudoPassword) {
                    // Используем пароль из переменной окружения
                    const result = await execPromise(
                        `echo '${sudoPassword}' | sudo -S journalctl -u ${serviceName} -n ${lines} --no-pager`
                    );
                    stdout = result.stdout;
                } else {
                    // Пробуем без пароля
                    const result = await execPromise(`sudo journalctl -u ${serviceName} -n ${lines} --no-pager`);
                    stdout = result.stdout;
                }
                
                return stdout;
            } catch (sudoError) {
                return `❌ Ошибка получения логов: ${sudoError.message || error.message}`;
            }
        }
    }

    // Создать клавиатуру для службы
    getServiceKeyboard(serviceName, displayName) {
        return {
            inline_keyboard: [
                [
                    { text: '🔄 Restart', callback_data: `srv_restart_${serviceName}` },
                    { text: '▶️ Start', callback_data: `srv_start_${serviceName}` },
                    { text: '⏹️ Stop', callback_data: `srv_stop_${serviceName}` }
                ],
                [
                    { text: '📋 Logs (20)', callback_data: `srv_logs_${serviceName}_20` },
                    { text: '📋 Logs (50)', callback_data: `srv_logs_${serviceName}_50` },
                    { text: '📋 Logs (100)', callback_data: `srv_logs_${serviceName}_100` }
                ],
                [
                    { text: '🔄 Обновить статус', callback_data: `srv_status_${serviceName}` },
                    { text: '◀️ Назад к списку', callback_data: 'srv_back_to_list' }
                ]
            ]
        };
    }

    // Создать главное меню служб
    getMainMenuKeyboard() {
        const keyboard = [];
        
        // По 2 службы в ряд
        for (let i = 0; i < config.SERVICES.length; i += 2) {
            const row = [];
            row.push({ text: config.SERVICES[i].name, callback_data: `srv_select_${config.SERVICES[i].systemName}` });
            
            if (i + 1 < config.SERVICES.length) {
                row.push({ text: config.SERVICES[i + 1].name, callback_data: `srv_select_${config.SERVICES[i + 1].systemName}` });
            }
            
            keyboard.push(row);
        }
        
        // Кнопка обновить все
        keyboard.push([{ text: '🔄 Обновить все статусы', callback_data: 'srv_refresh_all' }]);
        
        return { inline_keyboard: keyboard };
    }

    // Обработка callback-запросов
    async handleCallback(query) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const data = query.data;

        // Разбираем callback_data
        const parts = data.split('_');
        const action = parts[1];
        
        try {
            if (action === 'select') {
                // Выбрана служба - показываем её меню
                const serviceName = parts[2];
                const service = config.SERVICES.find(s => s.systemName === serviceName);
                const status = await this.getServiceStatus(serviceName);
                
                let emoji = '❌';
                if (status.status === 'active') emoji = '✅';
                else if (status.status === 'activating') emoji = '⏳';
                
                const statusText = `${emoji} *${service.name}*\n\n` +
                    `Статус: *${status.status}*\n` +
                    (status.pid ? `PID: ${status.pid}\n` : '') +
                    (status.memory ? `Память: ${status.memory}\n` : '') +
                    `\nВыберите действие:`;

                await this.bot.editMessageText(statusText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: this.getServiceKeyboard(serviceName, service.name)
                });

            } else if (action === 'restart' || action === 'start' || action === 'stop') {
                // Управление службой
                const serviceName = parts[2];
                const service = config.SERVICES.find(s => s.systemName === serviceName);
                
                // Отправляем уведомление о начале действия
                await this.bot.answerCallbackQuery(query.id, { text: `⏳ Выполняю ${action} для ${service.name}...` });
                
                const result = await this.controlService(serviceName, action);
                
                if (result.success) {
                    await this.bot.sendMessage(chatId, `✅ *${service.name}*: ${action} выполнен успешно`, {
                        parse_mode: 'Markdown'
                    });
                    
                    // Обновляем статус в меню
                    const status = await this.getServiceStatus(serviceName);
                    let emoji = status.status === 'active' ? '✅' : '❌';
                    
                    const statusText = `${emoji} *${service.name}*\n\n` +
                        `Статус: *${status.status}*\n` +
                        (status.pid ? `PID: ${status.pid}\n` : '') +
                        (status.memory ? `Память: ${status.memory}\n` : '') +
                        `\nВыберите действие:`;

                    await this.bot.editMessageText(statusText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: this.getServiceKeyboard(serviceName, service.name)
                    });
                } else {
                    await this.bot.sendMessage(chatId, `❌ Ошибка: ${result.message}`);
                }

            } else if (action === 'logs') {
                // Показать логи
                const serviceName = parts[2];
                const lines = parseInt(parts[3]) || 20;
                const service = config.SERVICES.find(s => s.systemName === serviceName);
                
                await this.bot.answerCallbackQuery(query.id, { text: `📋 Загружаю логи...` });
                
                const logs = await this.getServiceLogs(serviceName, lines);
                
                // Обрезаем если слишком длинные
                let logText = logs;
                if (logs.length > 3500) {
                    logText = logs.substring(0, 3500) + '\n...(обрезано)';
                }
                
                await this.bot.sendMessage(chatId, `📋 *Логи ${service.name} (${lines} строк)*\n\n\`\`\`\n${logText}\n\`\`\``, {
                    parse_mode: 'Markdown'
                });

            } else if (action === 'status') {
                // Обновить статус
                const serviceName = parts[2];
                const service = config.SERVICES.find(s => s.systemName === serviceName);
                
                const status = await this.getServiceStatus(serviceName);
                let emoji = status.status === 'active' ? '✅' : '❌';
                
                const statusText = `${emoji} *${service.name}*\n\n` +
                    `Статус: *${status.status}*\n` +
                    (status.pid ? `PID: ${status.pid}\n` : '') +
                    (status.memory ? `Память: ${status.memory}\n` : '') +
                    `\nВыберите действие:`;

                await this.bot.editMessageText(statusText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: this.getServiceKeyboard(serviceName, service.name)
                });
                
                await this.bot.answerCallbackQuery(query.id, { text: '✅ Статус обновлен' });

            } else if (action === 'back') {
                // Назад к списку служб
                await this.bot.editMessageText('📋 *Выберите службу для управления:*', {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: this.getMainMenuKeyboard()
                });

            } else if (action === 'refresh') {
                // Обновить все статусы
                await this.bot.answerCallbackQuery(query.id, { text: '🔄 Обновляю статусы...' });
                
                let statusText = '📊 *Статус всех служб*\n\n';
                
                for (const service of config.SERVICES) {
                    const status = await this.getServiceStatus(service.systemName);
                    const emoji = status.status === 'active' ? '✅' : '❌';
                    statusText += `${emoji} ${service.name}: ${status.status}\n`;
                    if (status.memory) {
                        statusText += `   📊 Память: ${status.memory}\n`;
                    }
                }
                
                await this.bot.editMessageText(statusText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: this.getMainMenuKeyboard()
                });
            }
        } catch (error) {
            console.error('Ошибка в handleCallback:', error);
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Произошла ошибка' });
        }
    }
}

module.exports = ServiceManager;
