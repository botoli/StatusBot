// config.js
module.exports = {
    // Telegram
    TELEGRAM_TOKEN: "8004959360:AAGWYRVOrvl9_B_073lCsgGAq4k35Mqxtp8",
    ADMIN_ID: 964264865, // замените на ваш ID
    
    // Пороги срабатывания
    THRESHOLDS: {
        CPU: 80,           // % загрузки CPU
        RAM: 85,           // % использования RAM
        DISK: 90,          // % заполнения диска
        TEMP_CPU: 80,      // температура CPU в °C
        TEMP_GPU: 80,      // температура GPU в °C
        TEMP_SSD: 65       // температура SSD в °C
    },
    
    // Интервалы проверки (в мс)
    INTERVALS: {
        CHECK: 60 * 1000,           // 1 минута
        HISTORY: 5 * 60 * 1000,     // 5 минут
        ALERT_COOLDOWN: 30 * 60 * 1000,  // 30 минут
        CLEANUP: 24 * 60 * 60 * 1000     // 24 часа
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
// config.js
module.exports = {
    // Telegram
    TELEGRAM_TOKEN: "8004959360:AAGWYRVOrvl9_B_073lCsgGAq4k35Mqxtp8",
    ADMIN_ID: 964264865, // ваш ID
    
    // Пороги срабатывания
    THRESHOLDS: {
        CPU: 80,
        RAM: 85,
        DISK: 90,
        TEMP_CPU: 80,
        TEMP_GPU: 80,
        TEMP_SSD: 65
    },
    
    // Интервалы проверки
    INTERVALS: {
        CHECK: 60 * 1000,
        HISTORY: 5 * 60 * 1000,
        ALERT_COOLDOWN: 30 * 60 * 1000,
        CLEANUP: 24 * 60 * 60 * 1000
    },
    
    // Службы
    SERVICES: [
        { name: '📁 File Browser', systemName: 'filebrowser' },
        { name: '📊 JSON Server', systemName: 'json-server' },
        { name: '🌐 Nginx', systemName: 'nginx' },
        { name: '🗄️ MySQL', systemName: 'mysql' },
        { name: '🐳 Docker', systemName: 'docker' },
        { name: '☁️ Cloudflared', systemName: 'cloudflared' }
    ]
};
