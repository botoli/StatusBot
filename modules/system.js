// modules/system.js
const { exec } = require('child_process');
const util = require('util');
const os = require('os');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;

class SystemMonitor {
    // Получить информацию о дистрибутиве Linux
    async getLinuxDistro() {
        try {
            // Пробуем прочитать /etc/os-release
            const osRelease = await fs.readFile('/etc/os-release', 'utf8');
            const lines = osRelease.split('\n');
            
            // Сначала ищем PRETTY_NAME - он содержит полное название
            for (const line of lines) {
                if (line.startsWith('PRETTY_NAME=')) {
                    const prettyName = line.split('=')[1].replace(/"/g, '').trim();
                    if (prettyName) return prettyName;
                }
            }
            
            // Если PRETTY_NAME нет, собираем из NAME и VERSION
            let name = 'Linux';
            let version = '';
            
            for (const line of lines) {
                if (line.startsWith('NAME=')) {
                    name = line.split('=')[1].replace(/"/g, '').trim();
                } else if (line.startsWith('VERSION=')) {
                    version = line.split('=')[1].replace(/"/g, '').trim();
                }
            }
            
            if (version && !name.includes(version)) {
                return `${name} ${version}`;
            }
            return name;
        } catch (error) {
            // Fallback на lsb_release
            try {
                const { stdout } = await execPromise('lsb_release -d 2>/dev/null');
                const match = stdout.match(/Description:\s*(.+)/);
                if (match) return match[1].trim();
            } catch {}
            
            // Если ничего не получилось, возвращаем просто Linux
            return 'Linux';
        }
    }
    
    // Температура CPU (из нескольких источников)
    async getCPUTemperature() {
        const sources = [
            '/sys/class/thermal/thermal_zone0/temp',
            '/sys/class/hwmon/hwmon0/temp1_input',
            '/sys/class/hwmon/hwmon1/temp1_input'
        ];
        
        for (const source of sources) {
            try {
                const data = await fs.readFile(source, 'utf8');
                const temp = parseInt(data) / 1000;
                // Принимаем температуру от 0 до 150 (расширенный диапазон для стресс-тестов)
                if (temp > 0 && temp < 150) return temp;
            } catch {}
        }
        
        try {
            const { stdout } = await execPromise('sensors -u 2>/dev/null | grep -E "temp.*input" | head -1 | awk \'{print $2}\'');
            const temp = parseFloat(stdout);
            if (!isNaN(temp) && temp > 0 && temp < 150) return temp;
        } catch {}
        
        return null;
    }

    // Температура GPU (для NVIDIA)
    async getGPUTemperature() {
        try {
            const { stdout } = await execPromise('nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null');
            const temp = parseFloat(stdout);
            if (!isNaN(temp)) return temp;
        } catch {}
        
        // Для Intel iGPU
        try {
            const { stdout } = await execPromise('cat /sys/class/drm/card0/device/hwmon/hwmon*/temp1_input 2>/dev/null');
            const temp = parseInt(stdout) / 1000;
            if (temp > 0) return temp;
        } catch {}
        
        return null;
    }

    // Температура SSD (через smartctl)
    async getSSDTemperature() {
        try {
            const { stdout } = await execPromise('sudo smartctl -A /dev/sda 2>/dev/null | grep -i temperature | awk \'{print $10}\' | head -1');
            const temp = parseFloat(stdout);
            if (!isNaN(temp)) return temp;
        } catch {}
        
        try {
            const { stdout } = await execPromise('sudo hddtemp /dev/sda 2>/dev/null | awk \'{print $4}\' | sed "s/°C//"');
            const temp = parseFloat(stdout);
            if (!isNaN(temp)) return temp;
        } catch {}
        
        return null;
    }

    // Скорость вентиляторов
    async getFanSpeeds() {
        try {
            const { stdout } = await execPromise('sensors 2>/dev/null | grep -i fan | awk \'{print $2}\'');
            if (stdout) {
                const speeds = stdout.split('\n').filter(s => s.trim()).map(s => parseInt(s));
                return speeds.filter(s => !isNaN(s) && s > 0);
            }
        } catch {}
        
        // Для ThinkPad (как у вас)
        try {
            const { stdout } = await execPromise('cat /proc/acpi/ibm/fan 2>/dev/null | grep speed | awk \'{print $2}\'');
            const speed = parseInt(stdout);
            if (!isNaN(speed) && speed > 0) return [speed];
        } catch {}
        
        return [];
    }

    // Напряжение (для SBC/Raspberry Pi)
    async getVoltage() {
        try {
            const { stdout } = await execPromise('vcgencmd measure_volts core 2>/dev/null | cut -d= -f2');
            if (stdout) return stdout.trim();
        } catch {}
        
        try {
            const { stdout } = await execPromise('cat /sys/devices/platform/*/cpu_dvfs_parameter/voltage 2>/dev/null');
            const voltage = parseFloat(stdout) / 1000;
            if (!isNaN(voltage)) return `${voltage.toFixed(2)}V`;
        } catch {}
        
        return null;
    }

    // Загрузка CPU с историей (средние значения)
    getCPULoad() {
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        
        let totalIdle = 0, totalTick = 0;
        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });
        
        const idle = totalIdle / cpus.length;
        const total = totalTick / cpus.length;
        
        return {
            current: ((total - idle) / total * 100).toFixed(1),
            load1: loadAvg[0].toFixed(2),
            load5: loadAvg[1].toFixed(2),
            load15: loadAvg[2].toFixed(2)
        };
    }

    // Память
    getMemoryInfo() {
        const total = os.totalmem() / 1024 / 1024 / 1024;
        const free = os.freemem() / 1024 / 1024 / 1024;
        const used = total - free;
        const percent = (used / total * 100).toFixed(1);
        
        return {
            total: total.toFixed(1),
            used: used.toFixed(1),
            free: free.toFixed(1),
            percent
        };
    }

    // Диск
    async getDiskInfo() {
        try {
            const { stdout } = await execPromise('df -h / | tail -1');
            const parts = stdout.split(/\s+/);
            return {
                total: parts[1],
                used: parts[2],
                free: parts[3],
                percent: parts[4].replace('%', '')
            };
        } catch {
            return null;
        }
    }

    // Uptime
    getUptime() {
        const uptime = os.uptime();
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        let str = '';
        if (days > 0) str += `${days}д `;
        if (hours > 0) str += `${hours}ч `;
        str += `${minutes}м`;
        return str;
    }

    // Полный сбор метрик
    async getAllMetrics() {
        // Синхронные метрики считаем сразу
        const cpu = this.getCPULoad();
        const mem = this.getMemoryInfo();

        // Все тяжёлые асинхронные операции запускаем параллельно,
        // чтобы не ждать их по очереди
        const [
            disk,
            [cpuTemp, gpuTemp, ssdTemp],
            fans,
            voltage,
            mainInterface
        ] = await Promise.all([
            this.getDiskInfo(),
            Promise.all([
                this.getCPUTemperature(),
                this.getGPUTemperature(),
                this.getSSDTemperature()
            ]),
            this.getFanSpeeds(),
            this.getVoltage(),
            this.getMainInterface()
        ]);

        const metrics = {
            timestamp: Date.now(),
            cpu,
            memory: mem,
            disk,
            uptime: this.getUptime(),
            temperature: {
                cpu: cpuTemp,
                gpu: gpuTemp,
                ssd: ssdTemp
            },
            fans,
            voltage
        };

        // Сетевую статистику также получаем, но не блокируемся на ошибках
        try {
            if (mainInterface) {
                const networkStat = await this.getNetworkStats(mainInterface);
                if (networkStat) {
                    metrics.network = {
                        interface: mainInterface,
                        rxBytes: networkStat.rxBytes,
                        txBytes: networkStat.txBytes,
                        rxPackets: networkStat.rxPackets,
                        txPackets: networkStat.txPackets
                    };
                }
            }
        } catch (error) {
            // Игнорируем ошибки сети
        }

        return metrics;
    }

    // Emoji для температуры
    getTempEmoji(temp) {
        if (!temp) return '⚪';
        if (temp >= 80) return '🔥';
        if (temp >= 70) return '🔴';
        if (temp >= 60) return '🟠';
        if (temp >= 50) return '🟡';
        return '🟢';
    }

    // Статус-бар загрузки (улучшенный)
    getLoadBar(percent, length = 20) {
        const filled = Math.round(percent / 100 * length);
        const empty = length - filled;
        
        // Используем разные символы для более плавного отображения
        let bar = '';
        for (let i = 0; i < filled; i++) {
            if (i === filled - 1 && percent % (100 / length) > 0) {
                // Последний блок может быть частично заполнен
                bar += '▓';
            } else {
                bar += '█';
            }
        }
        bar += '░'.repeat(empty);
        
        // Цветовые индикаторы
        if (percent >= 90) return `🔴 ${bar} ${percent.toFixed(1)}%`;
        if (percent >= 80) return `🟠 ${bar} ${percent.toFixed(1)}%`;
        if (percent >= 60) return `🟡 ${bar} ${percent.toFixed(1)}%`;
        if (percent >= 40) return `🟢 ${bar} ${percent.toFixed(1)}%`;
        return `⚪ ${bar} ${percent.toFixed(1)}%`;
    }

    // Красивый статус-бар с прогрессом
    getProgressBar(current, total, label, unit = '', length = 20) {
        const percent = (current / total) * 100;
        const filled = Math.round(percent / 100 * length);
        const empty = length - filled;
        
        let bar = '█'.repeat(filled) + '░'.repeat(empty);
        
        // Форматируем значения
        const currentFormatted = typeof current === 'number' ? current.toFixed(1) : current;
        const totalFormatted = typeof total === 'number' ? total.toFixed(1) : total;
        
        return `${label}\n${bar} ${currentFormatted}${unit} / ${totalFormatted}${unit} (${percent.toFixed(1)}%)`;
    }

    // Получить статус системы (красивый)
    getSystemStatus(metrics) {
        const lines = [];
        
        // Заголовок
        lines.push(`🖥 *${os.hostname()}*`);
        lines.push('═'.repeat(25));
        lines.push('');
        
        // CPU
        const cpuPercent = parseFloat(metrics.cpu.current);
        lines.push(`⚡ *CPU*`);
        lines.push(this.getLoadBar(cpuPercent));
        lines.push(`   Load: ${metrics.cpu.load1} | ${metrics.cpu.load5} | ${metrics.cpu.load15}`);
        lines.push('');
        
        // RAM
        const ramPercent = parseFloat(metrics.memory.percent);
        lines.push(`🧠 *RAM*`);
        lines.push(this.getLoadBar(ramPercent));
        lines.push(`   ${metrics.memory.used}GB / ${metrics.memory.total}GB`);
        lines.push('');
        
        // Disk
        if (metrics.disk) {
            const diskPercent = parseInt(metrics.disk.percent);
            lines.push(`💽 *DISK*`);
            lines.push(this.getLoadBar(diskPercent));
            lines.push(`   ${metrics.disk.used} / ${metrics.disk.total}`);
            lines.push('');
        }
        
        // Temperature
        if (metrics.temperature.cpu) {
            const temp = metrics.temperature.cpu;
            const emoji = this.getTempEmoji(temp);
            lines.push(`${emoji} *TEMPERATURE*`);
            lines.push(`   CPU: ${temp.toFixed(1)}°C`);
            if (metrics.temperature.gpu) {
                lines.push(`   GPU: ${metrics.temperature.gpu.toFixed(1)}°C`);
            }
            if (metrics.temperature.ssd) {
                lines.push(`   SSD: ${metrics.temperature.ssd.toFixed(1)}°C`);
            }
            lines.push('');
        }
        
        // Network
        if (metrics.network) {
            lines.push(`🌐 *NETWORK* (${metrics.network.interface})`);
            lines.push(`   ⬇️ RX: ${this.formatBytes(metrics.network.rxBytes)}`);
            lines.push(`   ⬆️ TX: ${this.formatBytes(metrics.network.txBytes)}`);
            lines.push('');
        }
        
        // Uptime
        lines.push(`⏱️ *Uptime*: ${metrics.uptime}`);
        
        return lines.join('\n');
    }

    // Форматирование байтов
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Получить список сетевых интерфейсов
    async getNetworkInterfaces() {
        try {
            const { stdout } = await execPromise('ip -o link show | awk \'{print $2}\' | sed \'s/://\'');
            const interfaces = stdout.split('\n').filter(iface => iface.trim() && !iface.includes('lo'));
            return interfaces.map(iface => iface.trim());
        } catch (error) {
            // Fallback на os.networkInterfaces()
            const nets = os.networkInterfaces();
            return Object.keys(nets || {}).filter(iface => iface !== 'lo');
        }
    }

    // Получить статистику сетевого интерфейса
    async getNetworkStats(interfaceName) {
        try {
            // Читаем из /proc/net/dev
            const { stdout } = await execPromise(`cat /proc/net/dev | grep ${interfaceName}`);
            const parts = stdout.trim().split(/\s+/);
            
            if (parts.length < 10) return null;

            const rxBytes = parseInt(parts[1]);
            const rxPackets = parseInt(parts[2]);
            const txBytes = parseInt(parts[9]);
            const txPackets = parseInt(parts[10]);

            return {
                interface: interfaceName,
                rxBytes,
                rxPackets,
                txBytes,
                txPackets,
                rxFormatted: this.formatBytes(rxBytes),
                txFormatted: this.formatBytes(txBytes),
                totalBytes: rxBytes + txBytes,
                totalFormatted: this.formatBytes(rxBytes + txBytes)
            };
        } catch (error) {
            return null;
        }
    }

    // Получить скорость сети (за секунду)
    async getNetworkSpeed(interfaceName, previousStats = null) {
        const currentStats = await this.getNetworkStats(interfaceName);
        if (!currentStats) return null;

        if (!previousStats) {
            return {
                interface: interfaceName,
                rxSpeed: 0,
                txSpeed: 0,
                totalSpeed: 0,
                rxSpeedFormatted: '0 B/s',
                txSpeedFormatted: '0 B/s',
                totalSpeedFormatted: '0 B/s'
            };
        }

        const timeDiff = 1; // предполагаем 1 секунду
        const rxSpeed = (currentStats.rxBytes - previousStats.rxBytes) / timeDiff;
        const txSpeed = (currentStats.txBytes - previousStats.txBytes) / timeDiff;
        const totalSpeed = rxSpeed + txSpeed;

        return {
            interface: interfaceName,
            rxSpeed,
            txSpeed,
            totalSpeed,
            rxSpeedFormatted: this.formatBytes(rxSpeed) + '/s',
            txSpeedFormatted: this.formatBytes(txSpeed) + '/s',
            totalSpeedFormatted: this.formatBytes(totalSpeed) + '/s',
            currentStats
        };
    }

    // Получить все сетевые интерфейсы со статистикой
    async getAllNetworkStats() {
        const interfaces = await this.getNetworkInterfaces();
        const stats = [];

        for (const iface of interfaces) {
            const stat = await this.getNetworkStats(iface);
            if (stat) {
                stats.push(stat);
            }
        }

        return stats;
    }

    // Получить основной интерфейс (обычно eth0, wlan0, или первый активный)
    async getMainInterface() {
        const interfaces = await this.getNetworkInterfaces();
        
        // Приоритет: eth0, enp*, wlan0, wlp*, первый активный
        const priority = ['eth0', 'enp', 'wlan0', 'wlp'];
        
        for (const priorityName of priority) {
            const found = interfaces.find(iface => iface.startsWith(priorityName));
            if (found) return found;
        }

        return interfaces[0] || null;
    }

    // Получить IP адреса интерфейса
    async getInterfaceIPs(interfaceName) {
        try {
            const { stdout } = await execPromise(`ip addr show ${interfaceName} | grep "inet "`);
            const ips = stdout.split('\n').map(line => {
                const match = line.match(/inet (\S+)/);
                return match ? match[1] : null;
            }).filter(ip => ip);

            return ips;
        } catch {
            const nets = os.networkInterfaces();
            const iface = nets[interfaceName];
            if (!iface) return [];
            
            return iface
                .filter(details => details.family === 'IPv4')
                .map(details => details.address);
        }
    }
}

module.exports = new SystemMonitor();
