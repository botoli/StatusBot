package alerts

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"statusbot/internal/config"
	"statusbot/internal/services"
	"statusbot/internal/system"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

const (
	cpuAlertThreshold  = 60.0
	ramAlertThreshold  = 70.0
	tempAlertThreshold = 60.0
	alertCooldown      = 5 * time.Minute
)

type metricAlertState struct {
	Active         bool
	Disabled       bool
	LastAlertAt    time.Time
	LastAlertID    int64
	DisplayName    string
	RestartService string
}

type Manager struct {
	bot      *tgbotapi.BotAPI
	cfg      *config.Config
	mu       sync.Mutex
	states   map[string]*metricAlertState
	alertSeq int64
}

func NewManager(bot *tgbotapi.BotAPI, cfg *config.Config) *Manager {
	return &Manager{
		bot:    bot,
		cfg:    cfg,
		states: make(map[string]*metricAlertState),
	}
}

func (m *Manager) DisableMetricAlerts(metricKey string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.ensureStateLocked(metricKey)
	st.Disabled = true
	st.Active = false
}

func (m *Manager) RestartServiceForMetric(metricKey string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.states[metricKey]
	if st == nil {
		return ""
	}
	return st.RestartService
}

func (m *Manager) StartMonitoring() {
	interval := time.Duration(m.cfg.Intervals.Check) * time.Millisecond
	if interval <= 0 {
		interval = 30 * time.Second
	}

	go func() {
		m.checkOnce()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			m.checkOnce()
		}
	}()
}

func (m *Manager) checkOnce() {
	metrics, err := system.GetAllMetrics()
	if err == nil {
		m.checkHardware(metrics)
	}
	m.checkTrackedServices()
	m.checkEndpointTargets()
}

func (m *Manager) checkHardware(metrics *system.Metrics) {
	cpuPct := parseFloat(metrics.CPU.Current)
	m.handleMetricCondition(
		"cpu",
		"CPU",
		"CPU",
		fmt.Sprintf("%.1f%%", cpuPct),
		"60.0%",
		"Системная метрика CPU",
		cpuPct > cpuAlertThreshold,
		false,
		"",
	)

	ramPct := parseFloat(metrics.Memory.Percent)
	m.handleMetricCondition(
		"ram",
		"RAM",
		"RAM",
		fmt.Sprintf("%.1f%%", ramPct),
		"70.0%",
		"Системная метрика RAM",
		ramPct > ramAlertThreshold,
		false,
		"",
	)

	tempValue := 0.0
	if metrics.Temperature.CPU != nil {
		tempValue = *metrics.Temperature.CPU
	}
	m.handleMetricCondition(
		"temp",
		"TEMP",
		"TEMP",
		fmt.Sprintf("%.1f°C", tempValue),
		"60.0°C",
		"Системная метрика температуры CPU",
		tempValue > tempAlertThreshold,
		false,
		"",
	)
}

func (m *Manager) checkTrackedServices() {
	for _, svc := range m.cfg.Services {
		key := "service_" + normalizeMetricKey(strings.TrimSpace(svc.SystemName))
		displayName := strings.TrimSpace(svc.SystemName)
		if displayName == "" {
			displayName = strings.TrimSpace(svc.Name)
		}

		current := "UP"
		ctx := "Service check OK"
		breached := false

		status, err := services.GetServiceStatus(svc.SystemName)
		if err != nil {
			breached = true
			current = "DOWN"
			ctx = "check error: " + strings.TrimSpace(err.Error())
		} else if status == nil || strings.TrimSpace(status.Status) != "active" {
			breached = true
			current = "DOWN"
			serviceStatus := "unknown"
			if status != nil {
				serviceStatus = strings.TrimSpace(status.Status)
			}
			ctx = "status: " + serviceStatus
		}

		m.handleMetricCondition(
			key,
			displayName,
			"SERVICE DOWN: "+displayName,
			current,
			"UP",
			ctx,
			breached,
			true,
			svc.SystemName,
		)
	}
}

func (m *Manager) checkEndpointTargets() {
	for _, target := range m.cfg.Checks {
		name := strings.TrimSpace(target.Name)
		if name == "" {
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(target.Type))
		if kind != "tcp" && kind != "http" {
			continue
		}

		metricKey := kind + "_" + normalizeMetricKey(name)
		ok, errText := checkTarget(target)
		breached := !ok
		current := "UP"
		ctx := strings.ToUpper(kind) + " check OK"
		if breached {
			current = "DOWN"
			ctx = errText
		}

		m.handleMetricCondition(
			metricKey,
			name,
			strings.ToUpper(kind)+" DOWN: "+name,
			current,
			"UP",
			ctx,
			breached,
			true,
			target.RestartService,
		)
	}
}

func checkTarget(target config.CheckTarget) (bool, string) {
	timeout := 2 * time.Second
	if target.TimeoutMS > 0 {
		timeout = time.Duration(target.TimeoutMS) * time.Millisecond
	}

	switch strings.ToLower(strings.TrimSpace(target.Type)) {
	case "tcp":
		conn, err := net.DialTimeout("tcp", strings.TrimSpace(target.Target), timeout)
		if err != nil {
			return false, "TCP check failed: " + strings.TrimSpace(err.Error())
		}
		_ = conn.Close()
		return true, ""
	case "http":
		client := &http.Client{Timeout: timeout}
		resp, err := client.Get(strings.TrimSpace(target.Target))
		if err != nil {
			return false, "HTTP check failed: " + strings.TrimSpace(err.Error())
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return false, "HTTP status: " + strconv.Itoa(resp.StatusCode)
		}
		return true, ""
	default:
		return true, ""
	}
}

func normalizeMetricKey(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
	}
	out := b.String()
	if len(out) > 24 {
		out = out[:24]
	}
	if out == "" {
		return "unknown"
	}
	return out
}

func (m *Manager) handleMetricCondition(metricKey, displayName, alertTitle, currentValue, thresholdValue, context string, breached, isService bool, restartService string) {
	var (
		sendAlert    bool
		sendResolved bool
		alertID      int64
	)

	now := time.Now()

	m.mu.Lock()
	st := m.ensureStateLocked(metricKey)
	st.DisplayName = displayName
	if restartService != "" {
		st.RestartService = restartService
	}

	if st.Disabled {
		m.mu.Unlock()
		return
	}

	if breached {
		if !st.Active || now.Sub(st.LastAlertAt) >= alertCooldown {
			alertID = atomic.AddInt64(&m.alertSeq, 1)
			st.Active = true
			st.LastAlertAt = now
			st.LastAlertID = alertID
			sendAlert = true
		}
	} else if st.Active {
		st.Active = false
		sendResolved = true
	}
	m.mu.Unlock()

	if sendAlert {
		m.sendAlert(metricKey, alertID, alertTitle, currentValue, thresholdValue, context, isService)
	}
	if sendResolved {
		m.sendResolved(displayName)
	}
}

func (m *Manager) ensureStateLocked(metricKey string) *metricAlertState {
	st := m.states[metricKey]
	if st == nil {
		st = &metricAlertState{}
		m.states[metricKey] = st
	}
	return st
}

func (m *Manager) sendAlert(metricKey string, alertID int64, alertTitle, currentValue, thresholdValue, context string, isService bool) {
	hostname, _ := os.Hostname()
	timestamp := time.Now().Format("02.01.2006 15:04:05")

	text := fmt.Sprintf(
		"🚨 ALERT: %s\n🖥 Сервер: %s\n📊 Значение: %s\n⚠️ Лимит: %s\n🔌 %s\n🕐 Время: %s\n",
		alertTitle,
		hostname,
		currentValue,
		thresholdValue,
		context,
		timestamp,
	)

	actionLabel := "📊 Статус"
	actionKind := "status"
	if isService {
		actionLabel = "🔄 Перезапустить"
		actionKind = "restart"
	}

	base := fmt.Sprintf("metric:%s:alert:%d", metricKey, alertID)
	kb := tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("🔍 Логи", base+":logs"),
			tgbotapi.NewInlineKeyboardButtonData(actionLabel, base+":"+actionKind),
			tgbotapi.NewInlineKeyboardButtonData("🔕 Отключить алёрты", base+":disable"),
		),
	)

	msg := tgbotapi.NewMessage(m.cfg.AdminID, text)
	msg.ReplyMarkup = kb
	if _, err := m.bot.Send(msg); err != nil {
		log.Printf("Alert send error: %v", err)
	}
}

func (m *Manager) sendResolved(metricName string) {
	text := fmt.Sprintf("🟢 RESOLVED: %s вернулось в норму", metricName)
	msg := tgbotapi.NewMessage(m.cfg.AdminID, text)
	if _, err := m.bot.Send(msg); err != nil {
		log.Printf("Resolved send error: %v", err)
	}
}

func parseFloat(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return v
}
