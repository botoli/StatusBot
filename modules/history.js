// modules/history.js
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

class HistoryManager {
    constructor() {
        this.dataFile = path.join(__dirname, '../data/history.json');
        this.maxPoints = 1000; // максимум точек в истории
        this.init();
    }

    async init() {
        try {
            await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
            
            // Проверяем существует ли файл
            try {
                await fs.access(this.dataFile);
            } catch {
                // Создаём пустую историю
                await this.saveHistory({
                    cpu: [],
                    memory: [],
                    disk: [],
                    temperature: []
                });
            }
        } catch (error) {
            console.error('Ошибка инициализации истории:', error);
        }
    }

    async loadHistory() {
        try {
            const data = await fs.readFile(this.dataFile, 'utf8');
            return JSON.parse(data);
        } catch {
            return {
                cpu: [],
                memory: [],
                disk: [],
                temperature: []
            };
        }
    }

    async saveHistory(history) {
        try {
            await fs.writeFile(this.dataFile, JSON.stringify(history, null, 2));
        } catch (error) {
            console.error('Ошибка сохранения истории:', error);
        }
    }

    // Добавить точку данных
    async addPoint(metrics) {
        const history = await this.loadHistory();
        const timestamp = Date.now();
        
        // CPU
        history.cpu.push({
            timestamp,
            value: parseFloat(metrics.cpu.current),
            load1: parseFloat(metrics.cpu.load1),
            load5: parseFloat(metrics.cpu.load5),
            load15: parseFloat(metrics.cpu.load15)
        });

        // Memory
        history.memory.push({
            timestamp,
            value: parseFloat(metrics.memory.percent),
            used: parseFloat(metrics.memory.used),
            total: parseFloat(metrics.memory.total)
        });

        // Disk
        if (metrics.disk) {
            history.disk.push({
                timestamp,
                value: parseInt(metrics.disk.percent),
                used: metrics.disk.used,
                total: metrics.disk.total
            });
        }

        // Temperature
        if (metrics.temperature.cpu) {
            history.temperature.push({
                timestamp,
                value: metrics.temperature.cpu,
                type: 'cpu'
            });
        }
        
        if (metrics.temperature.gpu) {
            history.temperature.push({
                timestamp,
                value: metrics.temperature.gpu,
                type: 'gpu'
            });
        }

        // Обрезаем старые данные
        ['cpu', 'memory', 'disk', 'temperature'].forEach(key => {
            if (history[key].length > this.maxPoints) {
                history[key] = history[key].slice(-this.maxPoints);
            }
        });

        await this.saveHistory(history);
    }

    // Получить историю за период
    async getHistory(type, hours = 24) {
        const history = await this.loadHistory();
        const cutoff = Date.now() - (hours * 60 * 60 * 1000);
        
        return history[type].filter(point => point.timestamp >= cutoff);
    }

    // Получить статистику за период
    async getStats(type, hours = 24) {
        const data = await this.getHistory(type, hours);
        
        if (data.length === 0) {
            return null;
        }

        const values = data.map(d => d.value);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;

        return {
            min: min.toFixed(1),
            max: max.toFixed(1),
            avg: avg.toFixed(1),
            points: data.length,
            period: hours
        };
    }

    // Форматировать историю для вывода
    formatHistoryStats(type, stats) {
        if (!stats) return `Нет данных за последние ${stats.period}ч`;
        
        const emoji = {
            cpu: '📊',
            memory: '🧠',
            disk: '💽',
            temperature: '🌡️'
        }[type] || '📋';

        return `${emoji} *${type.toUpperCase()}* за ${stats.period}ч:\n` +
               `📈 Макс: ${stats.max}%\n` +
               `📉 Мин: ${stats.min}%\n` +
               `📊 Среднее: ${stats.avg}%\n` +
               `📐 Точек: ${stats.points}`;
    }

    // Очистить старые данные (вызывать раз в день)
    async cleanup() {
        const history = await this.loadHistory();
        const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        
        ['cpu', 'memory', 'disk', 'temperature'].forEach(key => {
            history[key] = history[key].filter(point => point.timestamp >= weekAgo);
        });

        await this.saveHistory(history);
    }
}

module.exports = new HistoryManager();
