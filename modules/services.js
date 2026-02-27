// modules/services.js
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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
}

module.exports = ServiceManager;
