package bot

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"statusbot/internal/services"
	"statusbot/internal/system"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

const (
	cpuStatusThreshold      = 60.0
	ramStatusThreshold      = 70.0
	tempStatusThreshold     = 60.0
	diskDefaultThreshold    = 90.0
	statusWarningWindowSize = 5.0
)

type AlertController interface {
	DisableMetricAlerts(metricKey string)
	RestartServiceForMetric(metricKey string) string
}

type netSample struct {
	rx int64
	tx int64
	at time.Time
}

type metricSeverity int

const (
	severityOK metricSeverity = iota
	severityWarning
	severityCritical
)

func (b *Bot) SetAlertController(ctrl AlertController) {
	b.alertCtrl = ctrl
}

func parseFloatOrZero(raw string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return 0
	}
	return v
}

func parseSizeToGB(raw string) float64 {
	s := strings.ToUpper(strings.TrimSpace(raw))
	if s == "" {
		return 0
	}
	s = strings.TrimSuffix(s, "IB")
	s = strings.TrimSuffix(s, "B")

	unit := byte(0)
	if len(s) > 0 {
		last := s[len(s)-1]
		if last < '0' || last > '9' {
			unit = last
			s = strings.TrimSpace(s[:len(s)-1])
		}
	}

	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}

	switch unit {
	case 'K':
		return v / 1024 / 1024
	case 'M':
		return v / 1024
	case 'G':
		return v
	case 'T':
		return v * 1024
	case 'P':
		return v * 1024 * 1024
	default:
		if v > 1024*1024 {
			return v / 1024 / 1024 / 1024
		}
		return v
	}
}

func metricStatus(value, threshold float64) (string, string, metricSeverity) {
	if value > threshold {
		return "🔴", "critical", severityCritical
	}
	if value >= threshold-statusWarningWindowSize {
		return "🟡", "warning", severityWarning
	}
	return "🟢", "normal", severityOK
}

func overallStatus(levels ...metricSeverity) string {
	status := "OK"
	for _, lvl := range levels {
		if lvl == severityCritical {
			return "CRITICAL"
		}
		if lvl == severityWarning {
			status = "WARNING"
		}
	}
	return status
}

func (b *Bot) networkMBps(stats *system.NetworkStats) (float64, float64) {
	if stats == nil || stats.Interface == "" {
		return 0, 0
	}

	now := time.Now()
	b.netMu.Lock()
	prev, ok := b.netSamples[stats.Interface]
	b.netSamples[stats.Interface] = netSample{rx: stats.RxBytes, tx: stats.TxBytes, at: now}
	b.netMu.Unlock()
	if !ok {
		return 0, 0
	}

	deltaSec := now.Sub(prev.at).Seconds()
	if deltaSec <= 0 {
		return 0, 0
	}

	down := float64(stats.RxBytes-prev.rx) / 1024 / 1024 / deltaSec
	up := float64(stats.TxBytes-prev.tx) / 1024 / 1024 / deltaSec
	if down < 0 {
		down = 0
	}
	if up < 0 {
		up = 0
	}
	return down, up
}

func (b *Bot) buildRealtimeStatusText(metrics *system.Metrics) string {
	hostname, _ := os.Hostname()
	cpuPct := parseFloatOrZero(metrics.CPU.Current)
	ramPct := parseFloatOrZero(metrics.Memory.Percent)
	ramUsed := parseFloatOrZero(metrics.Memory.Used)
	ramTotal := parseFloatOrZero(metrics.Memory.Total)

	tempVal := 0.0
	if metrics.Temperature.CPU != nil {
		tempVal = *metrics.Temperature.CPU
	}

	diskPct := 0.0
	diskUsed := 0.0
	diskTotal := 0.0
	if metrics.Disk != nil {
		diskPct = parseFloatOrZero(metrics.Disk.Percent)
		diskUsed = parseSizeToGB(metrics.Disk.Used)
		diskTotal = parseSizeToGB(metrics.Disk.Total)
	}

	diskThreshold := float64(b.cfg.Thresholds.Disk)
	if diskThreshold <= 0 {
		diskThreshold = diskDefaultThreshold
	}

	cpuIcon, cpuText, cpuLevel := metricStatus(cpuPct, cpuStatusThreshold)
	tempIcon, tempText, tempLevel := metricStatus(tempVal, tempStatusThreshold)
	ramIcon, _, ramLevel := metricStatus(ramPct, ramStatusThreshold)
	diskIcon, _, diskLevel := metricStatus(diskPct, diskThreshold)
	systemStatus := overallStatus(cpuLevel, tempLevel, ramLevel, diskLevel)

	// NET line shows MB/s between two poll ticks.
	netDown, netUp := b.networkMBps(metrics.Network)

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("🖥 %s  •  %s uptime\n\n", hostname, metrics.Uptime))
	sb.WriteString(fmt.Sprintf("CPU      %.1f%%   %s %s\n", cpuPct, cpuIcon, cpuText))
	sb.WriteString(fmt.Sprintf("TEMP     %.1f°C  %s %s\n\n", tempVal, tempIcon, tempText))
	sb.WriteString(fmt.Sprintf("RAM      %.1f%%   %s %.1f / %.1f GB\n", ramPct, ramIcon, ramUsed, ramTotal))
	sb.WriteString(fmt.Sprintf("DISK     %.1f%%    %s %.1f / %.1f GB\n\n", diskPct, diskIcon, diskUsed, diskTotal))
	sb.WriteString(fmt.Sprintf("NET      ↓ %.1f MB/s   ↑ %.1f MB/s\n\n", netDown, netUp))
	sb.WriteString("────────────────\n\n")
	sb.WriteString(fmt.Sprintf("🧭 SYSTEM: %s", systemStatus))
	return sb.String()
}

func (b *Bot) handleStatusSnapshot(chatID int64) {
	metrics, err := system.GetAllMetrics()
	if err != nil {
		b.send(chatID, "❌ Не удалось получить метрики")
		return
	}
	msg := tgbotapi.NewMessage(chatID, b.buildRealtimeStatusText(metrics))
	msg.ReplyMarkup = b.statusKb
	b.api.Send(msg)
}

func parseMetricAlertCallback(data string) (metricKey, alertID, action string, ok bool) {
	parts := strings.Split(data, ":")
	if len(parts) < 5 {
		return "", "", "", false
	}
	if parts[0] != "metric" || parts[2] != "alert" {
		return "", "", "", false
	}
	return parts[1], parts[3], parts[4], true
}

func (b *Bot) handleAlertMetricCallback(query *tgbotapi.CallbackQuery) {
	metricKey, alertID, action, ok := parseMetricAlertCallback(query.Data)
	if !ok {
		b.api.Request(tgbotapi.NewCallback(query.ID, "Некорректный callback"))
		return
	}
	_ = alertID

	chatID := query.Message.Chat.ID

	switch action {
	case "logs":
		svcName := ""
		if b.alertCtrl != nil {
			svcName = b.alertCtrl.RestartServiceForMetric(metricKey)
		}
		if svcName == "" && strings.HasPrefix(metricKey, "service_") {
			svcName = strings.TrimPrefix(metricKey, "service_")
		}
		if svcName != "" {
			b.api.Request(tgbotapi.NewCallback(query.ID, "⏳ Загружаю логи..."))
			b.handleLogs(chatID, svcName, 50, query.ID)
			return
		}
		b.api.Request(tgbotapi.NewCallback(query.ID, "Логи доступны только для служб"))
		return
	case "status":
		b.api.Request(tgbotapi.NewCallback(query.ID, ""))
		b.handleStatusSnapshot(chatID)
		return
	case "restart":
		restartService := ""
		if b.alertCtrl != nil {
			restartService = b.alertCtrl.RestartServiceForMetric(metricKey)
		}
		if restartService == "" && strings.HasPrefix(metricKey, "service_") {
			restartService = strings.TrimPrefix(metricKey, "service_")
		}
		if restartService == "" {
			b.api.Request(tgbotapi.NewCallback(query.ID, "Перезапуск не настроен"))
			return
		}
		result := services.ControlService(restartService, "restart")
		if result.Success {
			b.api.Request(tgbotapi.NewCallback(query.ID, "✅ Перезапуск выполнен"))
		} else {
			b.api.Request(tgbotapi.NewCallback(query.ID, "❌ Ошибка перезапуска"))
		}
		return
	case "disable":
		if b.alertCtrl != nil {
			b.alertCtrl.DisableMetricAlerts(metricKey)
			b.api.Request(tgbotapi.NewCallback(query.ID, "Алерты отключены"))
			return
		}
		b.api.Request(tgbotapi.NewCallback(query.ID, "Модуль алертов недоступен"))
		return
	default:
		b.api.Request(tgbotapi.NewCallback(query.ID, "Неизвестное действие"))
		return
	}
}
