// modules/alerts.js
const config = require('../config');
const system = require('./system');

class AlertManager {
    constructor(bot) {
        this.bot = bot;
        this.lastAlertTime = {};
        this.serverWasUp = true; // для отслеживания падения
        // Состояние включенных алертов (по умолчанию все включены)
        this.enabled = {
            cpu: true,
            ram: true,
            disk: true,
            temp: true,
            network: true
        };
        this.startHeartbeat();
    }

    // Проверка всех порогов
    async checkThresholds() {
        const metrics = await system.getAllMetrics();
        const alerts = [];
        const now = Date.now();

        // Проверка CPU (только если включен)
        if (this.enabled.cpu) {
            const cpuPercent = parseFloat(metrics.cpu.current);
            if (cpuPercent > config.THRESHOLDS.CPU) {
                alerts.push({
                    type: 'CPU',
                    value: `${cpuPercent}%`,
                    threshold: config.THRESHOLDS.CPU,
                    emoji: '⚡'
                });
            }
        }

        // Проверка RAM (только если включен)
        if (this.enabled.ram) {
            const ramPercent = parseFloat(metrics.memory.percent);
            if (ramPercent > config.THRESHOLDS.RAM) {
                alerts.push({
                    type: 'RAM',
                    value: `${ramPercent}%`,
                    threshold: config.THRESHOLDS.RAM,
                    emoji: '🧠'
                });
            }
        }

        // Проверка диска (только если включен)
        if (this.enabled.disk && metrics.disk) {
            const diskPercent = parseInt(metrics.disk.percent);
            if (diskPercent > config.THRESHOLDS.DISK) {
                alerts.push({
                    type: 'Диск',
                    value: `${diskPercent}%`,
                    threshold: config.THRESHOLDS.DISK,
                    emoji: '💽'
                });
            }
        }

        // Проверка температуры CPU (только если включен)
        if (this.enabled.temp && metrics.temperature.cpu && metrics.temperature.cpu > config.THRESHOLDS.TEMP_CPU) {
            alerts.push({
                type: 'Температура CPU',
                value: `${metrics.temperature.cpu.toFixed(1)}°C`,
                threshold: config.THRESHOLDS.TEMP_CPU,
                emoji: '🔥'
            });
        }

        // Проверка сетевой нагрузки (только если включен)
        if (this.enabled.network && metrics.network) {
            // Вычисляем скорость на основе предыдущих данных
            // Для упрощения проверяем общий трафик
            const totalBytes = metrics.network.rxBytes + metrics.network.txBytes;
            // Если трафик очень большой (более 1TB), это может быть проблемой
            // Но лучше проверять скорость, а не общий объем
            // Для скорости нужна история, поэтому пока пропускаем
        }

        // Отправляем только если прошло достаточно времени с последнего алерта
        for (const alert of alerts) {
            const key = alert.type;
            if (!this.lastAlertTime[key] || now - this.lastAlertTime[key] > config.INTERVALS.ALERT_COOLDOWN) {
                await this.sendAlert(alert);
                this.lastAlertTime[key] = now;
            }
        }
    }

    // Отправка уведомления
    async sendAlert(alert) {
        const message = `🚨 *Тревога!*\n\n` +
            `${alert.emoji} *${alert.type}*: ${alert.value}\n` +
            `Порог: ${alert.threshold}${alert.type.includes('Температура') ? '°C' : '%'}\n\n` +
            `🕐 ${new Date().toLocaleString('ru-RU')}`;

        await this.bot.sendMessage(config.ADMIN_ID, message, { parse_mode: 'Markdown' });
    }

    // Сердцебиение (проверка что сервер жив)
    startHeartbeat() {
        // Отправляем "сердцебиение" каждые 5 минут
        setInterval(async () => {
            try {
                const metrics = await system.getAllMetrics();
                this.serverWasUp = true;
            } catch (error) {
                // Если не можем получить метрики - что-то не так
                if (this.serverWasUp) {
                    // Сервер только что упал
                    await this.bot.sendMessage(
                        config.ADMIN_ID,
                        '⚠️ *Сервер недоступен!*\n\n' +
                        'Потеря связи с сервером. Возможно отключение электричества.',
                        { parse_mode: 'Markdown' }
                    );
                    this.serverWasUp = false;
                }
            }
        }, 5 * 60 * 1000); // 5 минут

        // Проверка при запуске бота
        setTimeout(async () => {
            try {
                await system.getAllMetrics();
                await this.bot.sendMessage(
                    config.ADMIN_ID,
                    '✅ *Бот мониторинга запущен*\n\n' +
                    'Система работает нормально.',
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                await this.bot.sendMessage(
                    config.ADMIN_ID,
                    '⚠️ *Бот запущен, но сервер недоступен!*',
                    { parse_mode: 'Markdown' }
                );
            }
        }, 5000);
    }

    // Периодическая проверка
    startMonitoring() {
        // Основная проверка каждую минуту
        setInterval(() => this.checkThresholds(), config.INTERVALS.CHECK);
        
        // Дополнительная быстрая проверка каждые 5 секунд для критических алертов
        setInterval(async () => {
            try {
                const metrics = await system.getAllMetrics();
                
                // CPU push alert
                if (this.enabled.cpu && parseFloat(metrics.cpu.current) > config.THRESHOLDS.CPU) {
                    const key = 'CPU';
                    const now = Date.now();
                    if (!this.lastAlertTime[key] || now - this.lastAlertTime[key] > config.INTERVALS.ALERT_COOLDOWN) {
                        await this.bot.sendMessage(
                            config.ADMIN_ID,
                            `⚡ *CPU превышен: ${metrics.cpu.current}%*\nПорог: ${config.THRESHOLDS.CPU}%`,
                            { parse_mode: 'Markdown' }
                        );
                        this.lastAlertTime[key] = now;
                    }
                }
                
                // RAM push alert
                if (this.enabled.ram && parseFloat(metrics.memory.percent) > config.THRESHOLDS.RAM) {
                    const key = 'RAM';
                    const now = Date.now();
                    if (!this.lastAlertTime[key] || now - this.lastAlertTime[key] > config.INTERVALS.ALERT_COOLDOWN) {
                        await this.bot.sendMessage(
                            config.ADMIN_ID,
                            `🧠 *RAM превышен: ${metrics.memory.percent}%*\nПорог: ${config.THRESHOLDS.RAM}%`,
                            { parse_mode: 'Markdown' }
                        );
                        this.lastAlertTime[key] = now;
                    }
                }
                
                // Network speed alert (если есть данные о сети)
                if (this.enabled.network && metrics.network) {
                    // Проверяем скорость через измерение
                    const mainInterface = await system.getMainInterface();
                    if (mainInterface) {
                        const firstStat = await system.getNetworkStats(mainInterface);
                        if (firstStat) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            const speed = await system.getNetworkSpeed(mainInterface, firstStat);
                            if (speed && speed.totalSpeed > config.THRESHOLDS.NETWORK_SPEED) {
                                const key = 'Сеть';
                                const now = Date.now();
                                if (!this.lastAlertTime[key] || now - this.lastAlertTime[key] > config.INTERVALS.ALERT_COOLDOWN) {
                                    await this.bot.sendMessage(
                                        config.ADMIN_ID,
                                        `🌐 *Высокая сетевая нагрузка: ${speed.totalSpeedFormatted}*\nПорог: ${system.formatBytes(config.THRESHOLDS.NETWORK_SPEED)}/s\nИнтерфейс: ${mainInterface}`,
                                        { parse_mode: 'Markdown' }
                                    );
                                    this.lastAlertTime[key] = now;
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                // Игнорируем ошибки в быстрой проверке
            }
        }, 5000); // каждые 5 секунд
    }
}

module.exports = AlertManager;
