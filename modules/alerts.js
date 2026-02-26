// modules/alerts.js
const config = require('../config');
const system = require('./system');

class AlertManager {
    constructor(bot) {
        this.bot = bot;
        this.lastAlertTime = {};
        this.serverWasUp = true; // для отслеживания падения
        this.startHeartbeat();
    }

    // Проверка всех порогов
    async checkThresholds() {
        const metrics = await system.getAllMetrics();
        const alerts = [];
        const now = Date.now();

        // Проверка CPU
        const cpuPercent = parseFloat(metrics.cpu.current);
        if (cpuPercent > config.THRESHOLDS.CPU) {
            alerts.push({
                type: 'CPU',
                value: `${cpuPercent}%`,
                threshold: config.THRESHOLDS.CPU,
                emoji: '⚡'
            });
        }

        // Проверка RAM
        const ramPercent = parseFloat(metrics.memory.percent);
        if (ramPercent > config.THRESHOLDS.RAM) {
            alerts.push({
                type: 'RAM',
                value: `${ramPercent}%`,
                threshold: config.THRESHOLDS.RAM,
                emoji: '🧠'
            });
        }

        // Проверка диска
        if (metrics.disk) {
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

        // Проверка температуры CPU
        if (metrics.temperature.cpu && metrics.temperature.cpu > config.THRESHOLDS.TEMP_CPU) {
            alerts.push({
                type: 'Температура CPU',
                value: `${metrics.temperature.cpu.toFixed(1)}°C`,
                threshold: config.THRESHOLDS.TEMP_CPU,
                emoji: '🔥'
            });
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
        setInterval(() => this.checkThresholds(), config.INTERVALS.CHECK);
    }
}

module.exports = AlertManager;
