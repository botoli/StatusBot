//go:build linux

package system

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

var (
	distroCache      string
	mainIfaceCache   string
	diskCache        *DiskInfo
	diskCacheTime    int64
	cacheMu          sync.RWMutex
	diskCacheTTL     = int64(300) // 5 min в секундах
)

type CPULoad struct {
	Current string
	Load1   string
	Load5   string
	Load15  string
}

type MemoryInfo struct {
	Total   string
	Used    string
	Free    string
	Percent string
}

type DiskInfo struct {
	Total   string
	Used    string
	Free    string
	Percent string
}

type TemperatureInfo struct {
	CPU *float64
	GPU *float64
	SSD *float64
}

type NetworkStats struct {
	Interface string
	RxBytes   int64
	TxBytes   int64
	RxPackets int64
	TxPackets int64
}

type Metrics struct {
	Timestamp   int64
	CPU         CPULoad
	Memory      MemoryInfo
	Disk        *DiskInfo
	Uptime      string
	Temperature TemperatureInfo
	Voltage     *string
	Network     *NetworkStats
}

func FormatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	const k = 1024
	sizes := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	val := float64(bytes)
	for val >= k && i < len(sizes)-1 {
		val /= k
		i++
	}
	return fmt.Sprintf("%.2f %s", val, sizes[i])
}

func GetTempEmoji(temp float64) string {
	if temp >= 80 {
		return "🔥"
	}
	if temp >= 70 {
		return "🔴"
	}
	if temp >= 60 {
		return "🟠"
	}
	if temp >= 50 {
		return "🟡"
	}
	return "🟢"
}

func GetLoadBar(percent float64, length int) string {
	if length <= 0 {
		length = 20
	}
	filled := int(percent/100*float64(length) + 0.5)
	if filled > length {
		filled = length
	}
	if filled < 0 {
		filled = 0
	}
	empty := length - filled
	bar := strings.Repeat("█", filled) + strings.Repeat("░", empty)
	if percent >= 90 {
		return fmt.Sprintf("🔴 %s %.1f%%", bar, percent)
	}
	if percent >= 80 {
		return fmt.Sprintf("🟠 %s %.1f%%", bar, percent)
	}
	if percent >= 60 {
		return fmt.Sprintf("🟡 %s %.1f%%", bar, percent)
	}
	if percent >= 40 {
		return fmt.Sprintf("🟢 %s %.1f%%", bar, percent)
	}
	return fmt.Sprintf("⚪ %s %.1f%%", bar, percent)
}

func GetProgressBar(current, total float64, label, unit string, length int) string {
	if total == 0 {
		return label + "\n0 / 0 (0%)"
	}
	percent := (current / total) * 100
	filled := int(percent/100*float64(length) + 0.5)
	if filled > length {
		filled = length
	}
	if filled < 0 {
		filled = 0
	}
	empty := length - filled
	bar := strings.Repeat("█", filled) + strings.Repeat("░", empty)
	return fmt.Sprintf("%s\n%s %.1f%s / %.1f%s (%.1f%%)", label, bar, current, unit, total, unit, percent)
}

func GetLinuxDistro() string {
	cacheMu.RLock()
	if distroCache != "" {
		s := distroCache
		cacheMu.RUnlock()
		return s
	}
	cacheMu.RUnlock()

	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		if out, err := exec.Command("lsb_release", "-d").Output(); err == nil {
			re := regexp.MustCompile(`Description:\s*(.+)`)
			if m := re.FindSubmatch(out); len(m) > 1 {
				r := strings.TrimSpace(string(m[1]))
				cacheMu.Lock()
				distroCache = r
				cacheMu.Unlock()
				return r
			}
		}
		cacheMu.Lock()
		distroCache = "Linux"
		cacheMu.Unlock()
		return "Linux"
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			s := strings.TrimPrefix(line, "PRETTY_NAME=")
			s = strings.Trim(strings.TrimSpace(s), "\"")
			cacheMu.Lock()
			distroCache = s
			cacheMu.Unlock()
			return s
		}
	}
	var name, version string
	for _, line := range lines {
		if strings.HasPrefix(line, "NAME=") {
			name = strings.Trim(strings.TrimPrefix(line, "NAME="), "\"")
		} else if strings.HasPrefix(line, "VERSION=") {
			version = strings.Trim(strings.TrimPrefix(line, "VERSION="), "\"")
		}
	}
	var result string
	if version != "" && !strings.Contains(name, version) {
		result = name + " " + version
	} else {
		result = name
	}
	cacheMu.Lock()
	distroCache = result
	cacheMu.Unlock()
	return result
}

func getCPUTemperature() *float64 {
	sources := []string{
		"/sys/class/thermal/thermal_zone0/temp",
		"/sys/class/hwmon/hwmon0/temp1_input",
		"/sys/class/hwmon/hwmon1/temp1_input",
	}
	for _, src := range sources {
		data, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		temp, err := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
		if err != nil {
			continue
		}
		temp /= 1000
		if temp > 0 && temp < 150 {
			return &temp
		}
	}
	cmd := exec.Command("sh", "-c", "sensors -u 2>/dev/null | grep -E 'temp.*input' | head -1 | awk '{print $2}'")
	if out, err := cmd.Output(); err == nil {
		temp, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
		if err == nil && temp > 0 && temp < 150 {
			return &temp
		}
	}
	return nil
}

func getGPUTemperature() *float64 {
	cmd := exec.Command("nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader")
	if out, err := cmd.Output(); err == nil {
		temp, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
		if err == nil {
			return &temp
		}
	}
	data, err := os.ReadFile("/sys/class/drm/card0/device/hwmon/hwmon0/temp1_input")
	if err != nil {
		return nil
	}
	temp, err := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
	if err != nil {
		return nil
	}
	temp /= 1000
	if temp > 0 {
		return &temp
	}
	return nil
}

func getSSDTemperature() *float64 {
	cmd := exec.Command("sh", "-c", "sudo smartctl -A /dev/sda 2>/dev/null | grep -i temperature | awk '{print $10}' | head -1")
	if out, err := cmd.Output(); err == nil {
		temp, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
		if err == nil {
			return &temp
		}
	}
	cmd = exec.Command("sh", "-c", "sudo hddtemp /dev/sda 2>/dev/null | awk '{print $4}' | sed 's/°C//'")
	if out, err := cmd.Output(); err == nil {
		temp, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
		if err == nil {
			return &temp
		}
	}
	return nil
}

func getVoltage() *string {
	cmd := exec.Command("vcgencmd", "measure_volts", "core")
	if out, err := cmd.Output(); err == nil {
		s := strings.TrimSpace(string(out))
		if idx := strings.Index(s, "="); idx >= 0 {
			v := strings.TrimSpace(s[idx+1:])
			return &v
		}
	}
	return nil
}

func GetCPULoad() CPULoad {
	var load1, load5, load15 float64
	if info, err := os.ReadFile("/proc/loadavg"); err == nil {
		parts := strings.Fields(string(info))
		if len(parts) >= 3 {
			load1, _ = strconv.ParseFloat(parts[0], 64)
			load5, _ = strconv.ParseFloat(parts[1], 64)
			load15, _ = strconv.ParseFloat(parts[2], 64)
		}
	}

	info, err := os.ReadFile("/proc/stat")
	if err != nil {
		return CPULoad{
			Current: "0",
			Load1:   fmt.Sprintf("%.2f", load1),
			Load5:   fmt.Sprintf("%.2f", load5),
			Load15:  fmt.Sprintf("%.2f", load15),
		}
	}
	scanner := bufio.NewScanner(strings.NewReader(string(info)))
	var total, idle uint64
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			parts := strings.Fields(line)
			if len(parts) >= 5 {
				for i := 1; i < len(parts); i++ {
					v, _ := strconv.ParseUint(parts[i], 10, 64)
					total += v
				}
				idle, _ = strconv.ParseUint(parts[4], 10, 64)
			}
			break
		}
	}
	used := float64(0)
	if total > 0 {
		used = float64(total-idle) / float64(total) * 100
	}
	return CPULoad{
		Current: fmt.Sprintf("%.1f", used),
		Load1:   fmt.Sprintf("%.2f", load1),
		Load5:   fmt.Sprintf("%.2f", load5),
		Load15:  fmt.Sprintf("%.2f", load15),
	}
}

func GetMemoryInfo() MemoryInfo {
	var meminfo struct {
		MemTotal uint64
		MemFree  uint64
		Buffers  uint64
		Cached   uint64
	}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return MemoryInfo{Total: "0", Used: "0", Free: "0", Percent: "0"}
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		val, _ := strconv.ParseUint(parts[1], 10, 64)
		val *= 1024
		switch parts[0] {
		case "MemTotal:":
			meminfo.MemTotal = val
		case "MemFree:":
			meminfo.MemFree = val
		case "Buffers:":
			meminfo.Buffers = val
		case "Cached:":
			meminfo.Cached = val
		}
	}
	total := float64(meminfo.MemTotal) / 1024 / 1024 / 1024
	free := float64(meminfo.MemFree+meminfo.Buffers+meminfo.Cached) / 1024 / 1024 / 1024
	used := total - free
	if total <= 0 {
		return MemoryInfo{Total: "0", Used: "0", Free: "0", Percent: "0"}
	}
	percent := used / total * 100
	return MemoryInfo{
		Total:   fmt.Sprintf("%.1f", total),
		Used:    fmt.Sprintf("%.1f", used),
		Free:    fmt.Sprintf("%.1f", free),
		Percent: fmt.Sprintf("%.1f", percent),
	}
}

func GetDiskInfo() *DiskInfo {
	now := time.Now().Unix()
	cacheMu.RLock()
	if diskCache != nil && now-diskCacheTime < diskCacheTTL {
		d := diskCache
		cacheMu.RUnlock()
		return d
	}
	cacheMu.RUnlock()

	cmd := exec.Command("df", "-h", "/")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return nil
	}
	parts := strings.Fields(lines[len(lines)-1])
	if len(parts) < 5 {
		return nil
	}
	d := &DiskInfo{
		Total:   parts[1],
		Used:    parts[2],
		Free:    parts[3],
		Percent: strings.TrimSuffix(parts[4], "%"),
	}
	cacheMu.Lock()
	diskCache = d
	diskCacheTime = now
	cacheMu.Unlock()
	return d
}

func GetUptime() string {
	var uptime unix.Sysinfo_t
	if err := unix.Sysinfo(&uptime); err != nil {
		return "N/A"
	}
	sec := uptime.Uptime
	days := sec / 86400
	hours := (sec % 86400) / 3600
	minutes := (sec % 3600) / 60
	var s strings.Builder
	if days > 0 {
		s.WriteString(fmt.Sprintf("%dд ", days))
	}
	if hours > 0 {
		s.WriteString(fmt.Sprintf("%dч ", hours))
	}
	s.WriteString(fmt.Sprintf("%dм", minutes))
	return s.String()
}

func GetNetworkInterfaces() []string {
	cmd := exec.Command("sh", "-c", "ip -o link show | awk '{print $2}' | sed 's/://'")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var ifaces []string
	for _, name := range strings.Split(string(out), "\n") {
		name = strings.TrimSpace(name)
		if name != "" && name != "lo" && !strings.Contains(name, "lo") {
			ifaces = append(ifaces, name)
		}
	}
	return ifaces
}

func GetMainInterface() string {
	cacheMu.RLock()
	if mainIfaceCache != "" {
		s := mainIfaceCache
		cacheMu.RUnlock()
		return s
	}
	cacheMu.RUnlock()

	ifaces := GetNetworkInterfaces()
	priority := []string{"eth0", "enp", "wlan0", "wlp"}
	for _, p := range priority {
		for _, iface := range ifaces {
			if strings.HasPrefix(iface, p) || iface == p {
				cacheMu.Lock()
				mainIfaceCache = iface
				cacheMu.Unlock()
				return iface
			}
		}
	}
	var result string
	if len(ifaces) > 0 {
		result = ifaces[0]
	}
	cacheMu.Lock()
	mainIfaceCache = result
	cacheMu.Unlock()
	return result
}

func GetNetworkStats(iface string) *NetworkStats {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return nil
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.Contains(line, iface+":") {
			continue
		}
		line = strings.TrimPrefix(line, iface+":")
		parts := strings.Fields(line)
		if len(parts) < 10 {
			return nil
		}
		rxBytes, _ := strconv.ParseInt(parts[0], 10, 64)
		rxPackets, _ := strconv.ParseInt(parts[1], 10, 64)
		txBytes, _ := strconv.ParseInt(parts[8], 10, 64)
		txPackets, _ := strconv.ParseInt(parts[9], 10, 64)
		return &NetworkStats{
			Interface: iface,
			RxBytes:   rxBytes,
			TxBytes:   txBytes,
			RxPackets: rxPackets,
			TxPackets: txPackets,
		}
	}
	return nil
}

func GetAllMetrics() (*Metrics, error) {
	// Синхронные (быстрые /proc и syscall) — выполняем сразу
	cpu := GetCPULoad()
	mem := GetMemoryInfo()
	uptime := GetUptime()

	// Асинхронные тяжёлые операции — параллельно
	var disk *DiskInfo
	var cpuTemp, gpuTemp, ssdTemp *float64
	var voltage *string
	var network *NetworkStats

	var wg sync.WaitGroup
	wg.Add(5)
	go func() { defer wg.Done(); disk = GetDiskInfo() }()
	go func() { defer wg.Done(); cpuTemp = getCPUTemperature() }()
	go func() { defer wg.Done(); gpuTemp = getGPUTemperature() }()
	go func() { defer wg.Done(); ssdTemp = getSSDTemperature() }()
	go func() { defer wg.Done(); voltage = getVoltage() }()

	iface := GetMainInterface()
	if iface != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			network = GetNetworkStats(iface)
		}()
	}
	wg.Wait()

	return &Metrics{
		Timestamp: time.Now().UnixMilli(),
		CPU:       cpu,
		Memory:    mem,
		Disk:      disk,
		Uptime:    uptime,
		Temperature: TemperatureInfo{CPU: cpuTemp, GPU: gpuTemp, SSD: ssdTemp},
		Voltage:   voltage,
		Network:   network,
	}, nil
}
