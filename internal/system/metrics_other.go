//go:build !linux

package system

import (
	"fmt"
	"runtime"
	"strings"
	"time"
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
	return runtime.GOOS + " (non-Linux - run on Linux for full metrics)"
}

func GetCPULoad() CPULoad {
	return CPULoad{Current: "0", Load1: "0", Load5: "0", Load15: "0"}
}

func GetMemoryInfo() MemoryInfo {
	return MemoryInfo{Total: "0", Used: "0", Free: "0", Percent: "0"}
}

func GetDiskInfo() *DiskInfo {
	return &DiskInfo{Total: "0", Used: "0", Free: "0", Percent: "0"}
}

func GetUptime() string {
	return "N/A (Linux only)"
}

func GetNetworkInterfaces() []string {
	return nil
}

func GetMainInterface() string {
	return ""
}

func GetNetworkStats(iface string) *NetworkStats {
	return nil
}

func GetAllMetrics() (*Metrics, error) {
	return &Metrics{
		Timestamp:   time.Now().UnixMilli(),
		CPU:         GetCPULoad(),
		Memory:      GetMemoryInfo(),
		Disk:        GetDiskInfo(),
		Uptime:      GetUptime(),
		Temperature: TemperatureInfo{},
	}, nil
}
