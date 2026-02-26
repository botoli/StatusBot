// modules/system.js
const { exec } = require('child_process');
const util = require('util');
const os = require('os');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;

class SystemMonitor {
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
                if (temp > 0 && temp < 120) return temp;
            } catch {}
        }
        
        try {
            const { stdout } = await execPromise('sensors -u 2>/dev/null | grep -E "temp.*input" | head -1 | awk \'{print $2}\'');
            const temp = parseFloat(stdout);
            if (!isNaN(temp)) return temp;
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
        const cpu = this.getCPULoad();
        const mem = this.getMemoryInfo();
        const disk = await this.getDiskInfo();
        
        const metrics = {
            timestamp: Date.now(),
            cpu: cpu,
            memory: mem,
            disk: disk,
            uptime: this.getUptime()
        };
        
        // Добавляем опциональные метрики
        metrics.temperature = {
            cpu: await this.getCPUTemperature(),
            gpu: await this.getGPUTemperature(),
            ssd: await this.getSSDTemperature()
        };
        
        metrics.fans = await this.getFanSpeeds();
        metrics.voltage = await this.getVoltage();
        
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

    // Статус-бар загрузки
    getLoadBar(percent, length = 10) {
        const filled = Math.round(percent / 100 * length);
        const empty = length - filled;
        
        let bar = '█'.repeat(filled);
        bar += '░'.repeat(empty);
        
        if (percent >= 80) return `🔴 ${bar}`;
        if (percent >= 60) return `🟡 ${bar}`;
        return `🟢 ${bar}`;
    }
}

module.exports = new SystemMonitor();
