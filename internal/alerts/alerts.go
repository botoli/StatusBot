package alerts

import (
	"fmt"
	"log"
	"statusbot/internal/config"
	"statusbot/internal/system"
	"sync"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type Manager struct {
	bot           *tgbotapi.BotAPI
	cfg           *config.Config
	lastAlertTime map[string]int64
	serverWasUp   bool
	mu            sync.Mutex
}

func NewManager(bot *tgbotapi.BotAPI, cfg *config.Config) *Manager {
	m := &Manager{
		bot:           bot,
		cfg:           cfg,
		lastAlertTime: make(map[string]int64),
		serverWasUp:   true,
	}
	m.startHeartbeat()
	return m
}

func (m *Manager) sendAlert(alertType, value string, threshold int, emoji string, isTemp bool) {
	m.mu.Lock()
	now := time.Now().UnixMilli()
	if last, ok := m.lastAlertTime[alertType]; ok && now-last < m.cfg.Intervals.AlertCooldown {
		m.mu.Unlock()
		return
	}
	m.lastAlertTime[alertType] = now
	m.mu.Unlock()

	unit := "%"
	if isTemp {
		unit = "°C"
	}
	msg := fmt.Sprintf("🚨 *Тревога!*\n\n%s *%s*: %s\nПорог: %d%s\n\n🕐 %s",
		emoji, alertType, value, threshold, unit, time.Now().Format("02.01.2006 15:04:05"))

	botMsg := tgbotapi.NewMessage(m.cfg.AdminID, msg)
	botMsg.ParseMode = "Markdown"
	if _, err := m.bot.Send(botMsg); err != nil {
		log.Printf("Alert send error: %v", err)
	}
}

func (m *Manager) CheckThresholds() {
	metrics, err := system.GetAllMetrics()
	if err != nil {
		return
	}

	cpuPct, _ := parseFloat(metrics.CPU.Current)
	if cpuPct > float64(m.cfg.Thresholds.CPU) {
		m.sendAlert("CPU", fmt.Sprintf("%.0f%%", cpuPct), m.cfg.Thresholds.CPU, "⚡", false)
	}

	ramPct, _ := parseFloat(metrics.Memory.Percent)
	if ramPct > float64(m.cfg.Thresholds.RAM) {
		m.sendAlert("RAM", fmt.Sprintf("%.0f%%", ramPct), m.cfg.Thresholds.RAM, "🧠", false)
	}

	if metrics.Disk != nil {
		diskPct, _ := parseInt(metrics.Disk.Percent)
		if diskPct > m.cfg.Thresholds.Disk {
			m.sendAlert("Диск", fmt.Sprintf("%d%%", diskPct), m.cfg.Thresholds.Disk, "💽", false)
		}
	}

	if metrics.Temperature.CPU != nil && *metrics.Temperature.CPU > float64(m.cfg.Thresholds.TEMP_CPU) {
		m.sendAlert("Температура CPU", fmt.Sprintf("%.1f°C", *metrics.Temperature.CPU), m.cfg.Thresholds.TEMP_CPU, "🔥", true)
	}
}

func (m *Manager) startHeartbeat() {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			_, err := system.GetAllMetrics()
			if err != nil {
				if m.serverWasUp {
					msg := tgbotapi.NewMessage(m.cfg.AdminID, "⚠️ *Сервер недоступен!*\n\nПотеря связи с сервером.")
					msg.ParseMode = "Markdown"
					m.bot.Send(msg)
					m.serverWasUp = false
				}
			} else {
				m.serverWasUp = true
			}
		}
	}()

	time.AfterFunc(5*time.Second, func() {
		_, err := system.GetAllMetrics()
		msg := tgbotapi.NewMessage(m.cfg.AdminID, "✅ *Бот мониторинга запущен*\n\nСистема работает нормально.")
		if err != nil {
			msg.Text = "⚠️ *Бот запущен, но сервер недоступен!*"
		}
		msg.ParseMode = "Markdown"
		m.bot.Send(msg)
	})
}

func (m *Manager) StartMonitoring() {
	go func() {
		ticker := time.NewTicker(time.Duration(m.cfg.Intervals.Check) * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			m.CheckThresholds()
		}
	}()

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			metrics, err := system.GetAllMetrics()
			if err != nil {
				continue
			}
			cpuPct, _ := parseFloat(metrics.CPU.Current)
			if cpuPct > float64(m.cfg.Thresholds.CPU) {
				m.mu.Lock()
				now := time.Now().UnixMilli()
				if last, ok := m.lastAlertTime["CPU"]; !ok || now-last > m.cfg.Intervals.AlertCooldown {
					m.lastAlertTime["CPU"] = now
					m.mu.Unlock()
					msg := tgbotapi.NewMessage(m.cfg.AdminID, fmt.Sprintf("⚡ *CPU превышен: %s%%*\nПорог: %d%%", metrics.CPU.Current, m.cfg.Thresholds.CPU))
					msg.ParseMode = "Markdown"
					m.bot.Send(msg)
				} else {
					m.mu.Unlock()
				}
			}
			ramPct, _ := parseFloat(metrics.Memory.Percent)
			if ramPct > float64(m.cfg.Thresholds.RAM) {
				m.mu.Lock()
				now := time.Now().UnixMilli()
				if last, ok := m.lastAlertTime["RAM"]; !ok || now-last > m.cfg.Intervals.AlertCooldown {
					m.lastAlertTime["RAM"] = now
					m.mu.Unlock()
					msg := tgbotapi.NewMessage(m.cfg.AdminID, fmt.Sprintf("🧠 *RAM превышен: %s%%*\nПорог: %d%%", metrics.Memory.Percent, m.cfg.Thresholds.RAM))
					msg.ParseMode = "Markdown"
					m.bot.Send(msg)
				} else {
					m.mu.Unlock()
				}
			}
		}
	}()
}

func parseFloat(s string) (float64, error) {
	var f float64
	_, err := fmt.Sscanf(s, "%f", &f)
	return f, err
}

func parseInt(s string) (int, error) {
	var i int
	_, err := fmt.Sscanf(s, "%d", &i)
	return i, err
}
