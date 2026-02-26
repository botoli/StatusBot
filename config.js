// config.js
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');

// Загружаем конфиг из JSON файла, если существует
let config = {
    // Telegram
    TELEGRAM_TOKEN: "8004959360:AAGWYRVOrvl9_B_073lCsgGAq4k35Mqxtp8",
    ADMIN_ID: 964264865,
    
    // Пороги срабатывания
    THRESHOLDS: {
        CPU: 80,
        RAM: 85,
        DISK: 90,
        TEMP_CPU: 80,
        TEMP_GPU: 80,
        TEMP_SSD: 65,
        NETWORK_SPEED: 100 * 1024 * 1024 // 100 MB/s по умолчанию
    },
    
    // Интервалы проверки (в мс)
    INTERVALS: {
        CHECK: 60 * 1000,
        HISTORY: 5 * 60 * 1000,
        ALERT_COOLDOWN: 30 * 60 * 1000,
        CLEANUP: 24 * 60 * 60 * 1000
    },
    
    // Службы для мониторинга
    SERVICES: [
        { name: '📁 File Browser', systemName: 'filebrowser' },
        { name: '📊 JSON Server', systemName: 'json-server' },
        { name: '🌐 Nginx', systemName: 'nginx' },
        { name: '🗄️ MySQL', systemName: 'mysql' },
        { name: '🐳 Docker', systemName: 'docker' },
        { name: '☁️ Cloudflared', systemName: 'cloudflared' }
    ]
};

// Пытаемся загрузить из JSON
try {
    if (fs.existsSync(configPath)) {
        const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        // Объединяем с сохраненными значениями
        if (savedConfig.THRESHOLDS) {
            config.THRESHOLDS = { ...config.THRESHOLDS, ...savedConfig.THRESHOLDS };
        }
        if (savedConfig.ADMIN_ID) {
            config.ADMIN_ID = savedConfig.ADMIN_ID;
        }
        if (savedConfig.TELEGRAM_TOKEN) {
            config.TELEGRAM_TOKEN = savedConfig.TELEGRAM_TOKEN;
        }
    }
} catch (error) {
    console.error('Ошибка загрузки config.json:', error);
}

// Функция сохранения порогов в config.json
function saveThresholds() {
    try {
        const configToSave = {
            THRESHOLDS: config.THRESHOLDS,
            ADMIN_ID: config.ADMIN_ID,
            TELEGRAM_TOKEN: config.TELEGRAM_TOKEN
        };
        fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2));
        console.log('✅ Пороги сохранены в config.json');
    } catch (error) {
        console.error('❌ Ошибка сохранения порогов:', error);
    }
}

// Добавляем метод сохранения в экспорт
config.saveThresholds = saveThresholds;

module.exports = config;
