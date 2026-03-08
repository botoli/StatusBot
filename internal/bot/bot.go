package bot

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"statusbot/internal/config"
	"statusbot/internal/history"
	"statusbot/internal/services"
	"statusbot/internal/system"
)

type liveSession struct {
	ticker    *time.Ticker
	done      chan struct{}
	messageID int
}

type Bot struct {
	api         *tgbotapi.BotAPI
	cfg         *config.Config
	history     *history.Manager
	liveSessions map[int64]*liveSession
	mu          sync.Mutex
}

func New(api *tgbotapi.BotAPI, cfg *config.Config, hist *history.Manager) *Bot {
	return &Bot{
		api:          api,
		cfg:          cfg,
		history:      hist,
		liveSessions: make(map[int64]*liveSession),
	}
}

func (b *Bot) Run() {
	u := tgbotapi.NewUpdate(0)
	u.Timeout = 60
	updates := b.api.GetUpdatesChan(u)

	for update := range updates {
		if update.Message != nil {
			if update.Message.Chat.ID != b.cfg.AdminID {
				b.send(update.Message.Chat.ID, "⛔ Нет доступа")
				continue
			}
			if update.Message.Text != "" && strings.HasPrefix(update.Message.Text, "/") {
				if strings.HasPrefix(update.Message.Text, "/start") {
					b.handleMainMenu(update.Message.Chat.ID, nil)
				}
				continue
			}
			if update.Message.Text != "" {
				b.handleMessage(update.Message)
			}
		}
		if update.CallbackQuery != nil {
			if update.CallbackQuery.Message.Chat.ID != b.cfg.AdminID {
				b.api.Request(tgbotapi.NewCallback(update.CallbackQuery.ID, "⛔ Нет доступа"))
				continue
			}
			b.handleCallback(update.CallbackQuery)
		}
	}
}

func (b *Bot) send(chatID int64, text string) {
	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	b.api.Send(msg)
}

func (b *Bot) sendWithKeyboard(chatID int64, text string, keyboard interface{}) {
	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	if k, ok := keyboard.(tgbotapi.ReplyKeyboardMarkup); ok {
		msg.ReplyMarkup = k
	}
	if k, ok := keyboard.(tgbotapi.InlineKeyboardMarkup); ok {
		msg.ReplyMarkup = k
	}
	b.api.Send(msg)
}

func (b *Bot) mainKeyboard() tgbotapi.ReplyKeyboardMarkup {
	return tgbotapi.NewReplyKeyboard(
		tgbotapi.NewKeyboardButtonRow(
			tgbotapi.NewKeyboardButton("📊 СТАТУС"),
			tgbotapi.NewKeyboardButton("🧰 СЛУЖБЫ"),
		),
		tgbotapi.NewKeyboardButtonRow(
			tgbotapi.NewKeyboardButton("📈 ИСТОРИЯ"),
			tgbotapi.NewKeyboardButton("⚙️ СИСТЕМА"),
		),
	)
}

func (b *Bot) statusKeyboard() tgbotapi.ReplyKeyboardMarkup {
	return tgbotapi.NewReplyKeyboard(
		tgbotapi.NewKeyboardButtonRow(tgbotapi.NewKeyboardButton("◀️ НАЗАД")),
	)
}

func (b *Bot) historyKeyboard() tgbotapi.ReplyKeyboardMarkup {
	return tgbotapi.NewReplyKeyboard(
		tgbotapi.NewKeyboardButtonRow(
			tgbotapi.NewKeyboardButton("🕐 24ч"),
			tgbotapi.NewKeyboardButton("🕑 48ч"),
		),
		tgbotapi.NewKeyboardButtonRow(
			tgbotapi.NewKeyboardButton("📅 7д"),
			tgbotapi.NewKeyboardButton("📅 30д"),
		),
		tgbotapi.NewKeyboardButtonRow(tgbotapi.NewKeyboardButton("◀️ НАЗАД")),
	)
}

func (b *Bot) systemKeyboard() tgbotapi.ReplyKeyboardMarkup {
	return tgbotapi.NewReplyKeyboard(
		tgbotapi.NewKeyboardButtonRow(tgbotapi.NewKeyboardButton("📋 Детали")),
		tgbotapi.NewKeyboardButtonRow(tgbotapi.NewKeyboardButton("⏱️ Uptime")),
		tgbotapi.NewKeyboardButtonRow(tgbotapi.NewKeyboardButton("◀️ НАЗАД")),
	)
}

func (b *Bot) stopLiveSession(chatID int64, deleteMsg bool) {
	b.mu.Lock()
	sess := b.liveSessions[chatID]
	delete(b.liveSessions, chatID)
	b.mu.Unlock()
	if sess == nil {
		return
	}
	sess.done <- struct{}{}
	if deleteMsg && sess.messageID != 0 {
		b.api.Request(tgbotapi.NewDeleteMessage(chatID, sess.messageID))
	}
}

func (b *Bot) getStatusColor(percent float64) string {
	if percent >= 80 {
		return "🔴"
	}
	if percent >= 50 {
		return "🟡"
	}
	return "🟢"
}

func (b *Bot) getBlockBar(percent float64, blocks int) string {
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	filled := int(percent/100*float64(blocks) + 0.5)
	if filled > blocks {
		filled = blocks
	}
	empty := blocks - filled
	return strings.Repeat("🟩", filled) + strings.Repeat("⬜️", empty)
}

func (b *Bot) buildRealtimeStatusText(metrics *system.Metrics) string {
	hostname, _ := os.Hostname()
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("🖥 %s\n", hostname))
	sb.WriteString("────────────\n\n")

	cpuPct, _ := strconv.ParseFloat(metrics.CPU.Current, 64)
	ramPct, _ := strconv.ParseFloat(metrics.Memory.Percent, 64)
	sb.WriteString(fmt.Sprintf("CPU  %s %.0f%%\n", b.getStatusColor(cpuPct), cpuPct))
	sb.WriteString(b.getBlockBar(cpuPct, 10) + "\n\n")

	sb.WriteString(fmt.Sprintf("RAM  %s %.0f%%\n", b.getStatusColor(ramPct), ramPct))
	sb.WriteString(b.getBlockBar(ramPct, 10) + "\n")
	sb.WriteString(fmt.Sprintf("%sGB / %sGB\n\n", metrics.Memory.Used, metrics.Memory.Total))

	if metrics.Disk != nil {
		diskPct, _ := strconv.Atoi(metrics.Disk.Percent)
		sb.WriteString(fmt.Sprintf("DISK %s %d%%\n", b.getStatusColor(float64(diskPct)), diskPct))
		sb.WriteString(b.getBlockBar(float64(diskPct), 10) + "\n")
		sb.WriteString(fmt.Sprintf("%s / %s\n\n", metrics.Disk.Used, metrics.Disk.Total))
	}

	tempStr := "N/A"
	if metrics.Temperature.CPU != nil {
		tempStr = fmt.Sprintf("%.0f°C", *metrics.Temperature.CPU)
	}
	sb.WriteString(fmt.Sprintf("🌡️ %s   ⏱️ %s\n", tempStr, metrics.Uptime))
	if metrics.Network != nil {
		sb.WriteString(fmt.Sprintf("↓%s ↑%s", system.FormatBytes(metrics.Network.RxBytes), system.FormatBytes(metrics.Network.TxBytes)))
	}
	return sb.String()
}

func (b *Bot) handleMainMenu(chatID int64, msg *tgbotapi.Message) {
	text := "🖥 *Мониторинг сервера*\n\nВыберите раздел:"
	msgOut := tgbotapi.NewMessage(chatID, text)
	msgOut.ParseMode = "Markdown"
	msgOut.ReplyMarkup = b.mainKeyboard()
	b.api.Send(msgOut)
}

func (b *Bot) handleStatus(chatID int64) {
	b.stopLiveSession(chatID, true)

	metrics, _ := system.GetAllMetrics()
	text := b.buildRealtimeStatusText(metrics)

	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	sent, _ := b.api.Send(msg)

	b.sendWithKeyboard(chatID, "Для выхода из live‑режима нажмите кнопку ◀️ НАЗАД.", b.statusKeyboard())

	done := make(chan struct{})
	ticker := time.NewTicker(time.Second)
	b.mu.Lock()
	b.liveSessions[chatID] = &liveSession{ticker: ticker, done: done, messageID: sent.MessageID}
	b.mu.Unlock()

	go func() {
		for {
			select {
			case <-done:
				ticker.Stop()
				return
			case <-ticker.C:
				m, err := system.GetAllMetrics()
				if err != nil {
					continue
				}
				t := b.buildRealtimeStatusText(m)
				edit := tgbotapi.NewEditMessageText(chatID, sent.MessageID, t)
				edit.ParseMode = "Markdown"
				_, err = b.api.Send(edit)
				if err != nil && !strings.Contains(err.Error(), "message is not modified") {
					// stop on real error
					b.stopLiveSession(chatID, false)
					return
				}
			}
		}
	}()
}

func (b *Bot) handleMessage(msg *tgbotapi.Message) {
	text := strings.TrimSpace(msg.Text)
	chatID := msg.Chat.ID

	switch text {
	case "📊 СТАТУС", "📊 Статус":
		b.handleStatus(chatID)
		return
	case "🧰 СЛУЖБЫ", "🧰 Службы":
		b.handleServices(chatID, 0)
		return
	case "📈 ИСТОРИЯ", "📈 История":
		b.stopLiveSession(chatID, true)
		b.sendWithKeyboard(chatID, "📈 *ИСТОРИЯ*\n\nВыберите период:", b.historyKeyboard())
		return
	case "⚙️ СИСТЕМА", "⚙️ Система":
		b.stopLiveSession(chatID, true)
		b.sendWithKeyboard(chatID, "⚙️ *СИСТЕМА*\n\nВыберите действие:", b.systemKeyboard())
		return
	case "◀️ НАЗАД", "◀️ Назад", "Назад":
		b.stopLiveSession(chatID, true)
		b.handleMainMenu(chatID, nil)
		return
	case "🕐 24ч":
		b.handleHistPeriod(chatID, 24)
		return
	case "🕑 48ч":
		b.handleHistPeriod(chatID, 48)
		return
	case "📅 7д":
		b.handleHistPeriod(chatID, 168)
		return
	case "📅 30д":
		b.handleHistPeriod(chatID, 720)
		return
	case "📋 Детали":
		b.handleSystemDetails(chatID)
		return
	case "⏱️ Uptime":
		b.stopLiveSession(chatID, false)
		metrics, _ := system.GetAllMetrics()
		b.sendWithKeyboard(chatID, "⏱️ *АПТАЙМ*: "+metrics.Uptime, b.systemKeyboard())
		return
	case "🔄 Обновить все":
		b.handleServices(chatID, 0)
		return
	}

	for _, svc := range b.cfg.Services {
		if strings.Contains(text, svc.Name) || text == "🟢 "+svc.Name || text == "🟡 "+svc.Name || text == "🔴 "+svc.Name || text == "⚫ "+svc.Name || text == "⚪ "+svc.Name {
			b.handleService(chatID, 0, svc.SystemName)
			return
		}
	}

	b.send(chatID, "❌ Неизвестная команда")
}

func (b *Bot) handleCallback(query *tgbotapi.CallbackQuery) {
	data := query.Data
	chatID := query.Message.Chat.ID
	msgID := query.Message.MessageID

	switch data {
	case "back_main":
		b.api.Request(tgbotapi.NewCallback(query.ID, ""))
		b.handleMainMenu(chatID, nil)
		return
	case "back_services":
		b.api.Request(tgbotapi.NewCallback(query.ID, ""))
		b.handleServices(chatID, msgID)
		return
	case "services_refresh":
		b.api.Request(tgbotapi.NewCallback(query.ID, ""))
		b.handleServices(chatID, msgID)
		return
	}

	if strings.HasPrefix(data, "hist_") {
		var h int
		fmt.Sscanf(data, "hist_%d", &h)
		b.api.Request(tgbotapi.NewCallback(query.ID, fmt.Sprintf("⏳ Загружаю статистику за %dч...", h)))
		b.handleHistPeriod(chatID, h)
		return
	}

	if strings.HasPrefix(data, "service_") {
		svcName := strings.TrimPrefix(data, "service_")
		b.api.Request(tgbotapi.NewCallback(query.ID, ""))
		b.handleService(chatID, msgID, svcName)
		return
	}

	if strings.HasPrefix(data, "confirm_") {
		parts := strings.SplitN(data, "_", 3)
		if len(parts) >= 3 {
			action := parts[1]
			svcName := parts[2]
			b.api.Request(tgbotapi.NewCallback(query.ID, ""))
			b.handleConfirm(chatID, msgID, action, svcName)
		}
		return
	}

	if strings.HasPrefix(data, "do_") {
		parts := strings.SplitN(data, "_", 3)
		if len(parts) >= 3 {
			action := parts[1]
			svcName := parts[2]
			b.api.Request(tgbotapi.NewCallback(query.ID, "⏳ Выполняю "+action+"..."))
			b.handleDoAction(chatID, msgID, action, svcName, query.ID)
		}
		return
	}

	if strings.HasPrefix(data, "logs_") {
		parts := strings.SplitN(data, "_", 3)
		if len(parts) >= 3 {
			svcName := parts[1]
			var lines int
			fmt.Sscanf(parts[2], "%d", &lines)
			b.handleLogs(chatID, svcName, lines, query.ID)
		}
		return
	}

	b.api.Request(tgbotapi.NewCallback(query.ID, ""))
}

func (b *Bot) handleServices(chatID int64, editMsgID int) {
	var statuses []*services.ServiceStatus
	for _, s := range b.cfg.Services {
		st, _ := services.GetServiceStatus(s.SystemName)
		statuses = append(statuses, st)
	}

	var sb strings.Builder
	sb.WriteString("🧰 *СЛУЖБЫ*\n\n🟢 active\n🟡 activating\n🔴 failed\n⚫ stopped\n\n")
	rows := [][]tgbotapi.InlineKeyboardButton{}
	for i, s := range b.cfg.Services {
		st := statuses[i]
		emoji := "⚪"
		switch st.Status {
		case "active":
			emoji = "🟢"
		case "failed":
			emoji = "🔴"
		case "activating":
			emoji = "🟡"
		default:
			emoji = "⚫"
		}
		sb.WriteString(fmt.Sprintf("%s %s\n", emoji, s.Name))
		rows = append(rows, tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData(emoji+" "+s.Name, "service_"+s.SystemName),
		))
	}
	rows = append(rows, tgbotapi.NewInlineKeyboardRow(
		tgbotapi.NewInlineKeyboardButtonData("🔄 Обновить все", "services_refresh"),
		tgbotapi.NewInlineKeyboardButtonData("◀️ Назад", "back_main"),
	))

	if editMsgID > 0 {
		edit := tgbotapi.NewEditMessageText(chatID, editMsgID, sb.String())
		edit.ParseMode = "Markdown"
		edit.ReplyMarkup = &tgbotapi.InlineKeyboardMarkup{InlineKeyboard: rows}
		b.api.Send(edit)
	} else {
		msg := tgbotapi.NewMessage(chatID, sb.String())
		msg.ParseMode = "Markdown"
		msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
		b.api.Send(msg)
	}
}

func (b *Bot) findService(systemName string) *config.Service {
	for i := range b.cfg.Services {
		if b.cfg.Services[i].SystemName == systemName {
			return &b.cfg.Services[i]
		}
	}
	return nil
}

func (b *Bot) handleService(chatID int64, editMsgID int, serviceName string) {
	svc := b.findService(serviceName)
	if svc == nil {
		b.send(chatID, "❌ Служба не найдена")
		return
	}

	st, _ := services.GetServiceStatus(serviceName)
	emoji := "⚪"
	switch st.Status {
	case "active":
		emoji = "🟢"
	case "failed":
		emoji = "🔴"
	case "activating":
		emoji = "🟡"
	default:
		emoji = "⚫"
	}

	text := fmt.Sprintf("%s *%s*\n\nСтатус: *%s*\n", emoji, svc.Name, st.Status)
	if st.PID != "" {
		text += "PID: " + st.PID + "\n"
	}
	if st.Memory != "" {
		text += "Память: " + st.Memory + "\n"
	}
	text += "\nВыберите действие:"

	rows := [][]tgbotapi.InlineKeyboardButton{
		{
			tgbotapi.NewInlineKeyboardButtonData("▶️ Start", "confirm_start_"+serviceName),
			tgbotapi.NewInlineKeyboardButtonData("⏹️ Stop", "confirm_stop_"+serviceName),
		},
		{tgbotapi.NewInlineKeyboardButtonData("🔄 Restart", "confirm_restart_"+serviceName)},
		{
			tgbotapi.NewInlineKeyboardButtonData("📋 Logs 20", "logs_"+serviceName+"_20"),
			tgbotapi.NewInlineKeyboardButtonData("📋 Logs 50", "logs_"+serviceName+"_50"),
		},
		{
			tgbotapi.NewInlineKeyboardButtonData("🔄 Обновить", "service_"+serviceName),
			tgbotapi.NewInlineKeyboardButtonData("◀️ Назад", "back_services"),
		},
	}

	if editMsgID > 0 {
		edit := tgbotapi.NewEditMessageText(chatID, editMsgID, text)
		edit.ParseMode = "Markdown"
		edit.ReplyMarkup = &tgbotapi.InlineKeyboardMarkup{InlineKeyboard: rows}
		b.api.Send(edit)
	} else {
		msg := tgbotapi.NewMessage(chatID, text)
		msg.ParseMode = "Markdown"
		msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
		b.api.Send(msg)
	}
}

func (b *Bot) handleConfirm(chatID int64, msgID int, action, serviceName string) {
	svc := b.findService(serviceName)
	if svc == nil {
		return
	}
	text := fmt.Sprintf("⚠️ *Подтверждение*\n\n%s службу *%s*?", action, svc.Name)
	rows := [][]tgbotapi.InlineKeyboardButton{
		{
			tgbotapi.NewInlineKeyboardButtonData("✅ ДА", "do_"+action+"_"+serviceName),
			tgbotapi.NewInlineKeyboardButtonData("❌ НЕТ", "service_"+serviceName),
		},
	}
	edit := tgbotapi.NewEditMessageText(chatID, msgID, text)
	edit.ParseMode = "Markdown"
	edit.ReplyMarkup = &tgbotapi.InlineKeyboardMarkup{InlineKeyboard: rows}
	b.api.Send(edit)
}

func (b *Bot) handleDoAction(chatID int64, msgID int, action, serviceName, callbackID string) {
	svc := b.findService(serviceName)
	if svc == nil {
		return
	}
	result := services.ControlService(serviceName, action)
	if result.Success {
		b.send(chatID, "✅ *"+svc.Name+"*: "+action+" выполнен")
		b.handleService(chatID, 0, serviceName)
	} else {
		b.send(chatID, "❌ Ошибка: "+result.Message)
	}
}

func (b *Bot) handleLogs(chatID int64, serviceName string, lines int, callbackID string) {
	svc := b.findService(serviceName)
	if svc == nil {
		return
	}
	logs := services.GetServiceLogs(serviceName, lines)
	if len(logs) > 3500 {
		logs = logs[:3500]
	}
	text := fmt.Sprintf("📋 *Логи %s (%d строк)*\n```\n%s\n```", svc.Name, lines, logs)
	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	b.api.Send(msg)
	b.api.Request(tgbotapi.NewCallback(callbackID, ""))
}

func (b *Bot) handleHistPeriod(chatID int64, hours int) {
	cpuStats := b.history.GetStats("cpu", hours)
	memStats := b.history.GetStats("memory", hours)
	diskStats := b.history.GetStats("disk", hours)
	tempStats := b.history.GetStats("temperature", hours)

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("📈 *ИСТОРИЯ ЗА %dЧ*\n", hours))
	sb.WriteString(strings.Repeat("═", 30) + "\n\n")

	if cpuStats != nil {
		avg, _ := strconv.ParseFloat(cpuStats.Avg, 64)
		sb.WriteString("⚡ *CPU*\n")
		sb.WriteString(system.GetLoadBar(avg, 20) + "\n")
		sb.WriteString(fmt.Sprintf("   📊 Среднее: *%s%%*\n", cpuStats.Avg))
		sb.WriteString(fmt.Sprintf("   📈 Максимум: *%s%%*\n", cpuStats.Max))
		sb.WriteString(fmt.Sprintf("   📉 Минимум: *%s%%*\n", cpuStats.Min))
		sb.WriteString(fmt.Sprintf("   📐 Точек данных: %d\n\n", cpuStats.Points))
	}
	if memStats != nil {
		avg, _ := strconv.ParseFloat(memStats.Avg, 64)
		sb.WriteString("🧠 *RAM*\n")
		sb.WriteString(system.GetLoadBar(avg, 20) + "\n")
		sb.WriteString(fmt.Sprintf("   📊 Среднее: *%s%%*\n", memStats.Avg))
		sb.WriteString(fmt.Sprintf("   📈 Максимум: *%s%%*\n", memStats.Max))
		sb.WriteString(fmt.Sprintf("   📉 Минимум: *%s%%*\n", memStats.Min))
		sb.WriteString(fmt.Sprintf("   📐 Точек данных: %d\n\n", memStats.Points))
	}
	if diskStats != nil {
		avg, _ := strconv.ParseFloat(diskStats.Avg, 64)
		sb.WriteString("💽 *DISK*\n")
		sb.WriteString(system.GetLoadBar(avg, 20) + "\n")
		sb.WriteString(fmt.Sprintf("   📊 Среднее: *%s%%*\n", diskStats.Avg))
		sb.WriteString(fmt.Sprintf("   📈 Максимум: *%s%%*\n", diskStats.Max))
		sb.WriteString(fmt.Sprintf("   📉 Минимум: *%s%%*\n", diskStats.Min))
		sb.WriteString(fmt.Sprintf("   📐 Точек данных: %d\n\n", diskStats.Points))
	}
	if tempStats != nil {
		maxTemp, _ := strconv.ParseFloat(tempStats.Max, 64)
		sb.WriteString(system.GetTempEmoji(maxTemp) + " *TEMPERATURE*\n")
		sb.WriteString(fmt.Sprintf("   📊 Среднее: *%s°C*\n", tempStats.Avg))
		sb.WriteString(fmt.Sprintf("   📈 Максимум: *%s°C*\n", tempStats.Max))
		sb.WriteString(fmt.Sprintf("   📉 Минимум: *%s°C*\n", tempStats.Min))
		sb.WriteString(fmt.Sprintf("   📐 Точек данных: %d\n\n", tempStats.Points))
	}
	if cpuStats == nil && memStats == nil && diskStats == nil && tempStats == nil {
		sb.WriteString(fmt.Sprintf("⚠️ *Нет данных за последние %dч*\nПопробуйте выбрать другой период.", hours))
	}

	b.sendWithKeyboard(chatID, sb.String(), b.historyKeyboard())
}

func (b *Bot) buildSystemDetailsText(metrics *system.Metrics, distro string) string {
	hostname, _ := os.Hostname()
	var sb strings.Builder
	sb.WriteString("📋 *ДЕТАЛЬНАЯ ИНФОРМАЦИЯ*\n")
	sb.WriteString(strings.Repeat("═", 30) + "\n\n")
	sb.WriteString(fmt.Sprintf("🖥 *Система*\n   Hostname: %s\n   OS: %s\n   ⏱️ Uptime: %s\n\n", hostname, distro, metrics.Uptime))
	if metrics.Voltage != nil {
		sb.WriteString("   ⚡ Voltage: " + *metrics.Voltage + "\n\n")
	}

	cpuPct, _ := strconv.ParseFloat(metrics.CPU.Current, 64)
	sb.WriteString("⚡ *CPU*\n" + system.GetLoadBar(cpuPct, 20) + "\n")
	sb.WriteString(fmt.Sprintf("   Load Average:\n   • 1 min:  %s\n   • 5 min:  %s\n   • 15 min: %s\n\n", metrics.CPU.Load1, metrics.CPU.Load5, metrics.CPU.Load15))

	ramPct, _ := strconv.ParseFloat(metrics.Memory.Percent, 64)
	memUsed, _ := strconv.ParseFloat(metrics.Memory.Used, 64)
	memTotal, _ := strconv.ParseFloat(metrics.Memory.Total, 64)
	sb.WriteString("🧠 *RAM*\n" + system.GetLoadBar(ramPct, 20) + "\n")
	sb.WriteString(system.GetProgressBar(memUsed, memTotal, "   ", "GB", 15) + "\n")
	sb.WriteString("   Free: " + metrics.Memory.Free + "GB\n\n")

	if metrics.Disk != nil {
		diskPct, _ := strconv.ParseFloat(metrics.Disk.Percent, 64)
		sb.WriteString("💽 *DISK*\n" + system.GetLoadBar(diskPct, 20) + "\n")
		sb.WriteString(fmt.Sprintf("   Used: %s\n   Free: %s\n   Total: %s\n\n", metrics.Disk.Used, metrics.Disk.Free, metrics.Disk.Total))
	}

	if (metrics.Temperature.CPU != nil && *metrics.Temperature.CPU > 0) ||
		(metrics.Temperature.GPU != nil && *metrics.Temperature.GPU > 0) ||
		(metrics.Temperature.SSD != nil && *metrics.Temperature.SSD > 0) {
		sb.WriteString("🌡️ *TEMPERATURE*\n")
		if metrics.Temperature.CPU != nil && *metrics.Temperature.CPU > 0 {
			sb.WriteString(fmt.Sprintf("   %s CPU: %.1f°C\n", system.GetTempEmoji(*metrics.Temperature.CPU), *metrics.Temperature.CPU))
		}
		if metrics.Temperature.GPU != nil && *metrics.Temperature.GPU > 0 {
			sb.WriteString(fmt.Sprintf("   %s GPU: %.1f°C\n", system.GetTempEmoji(*metrics.Temperature.GPU), *metrics.Temperature.GPU))
		}
		if metrics.Temperature.SSD != nil && *metrics.Temperature.SSD > 0 {
			sb.WriteString(fmt.Sprintf("   %s SSD: %.1f°C\n", system.GetTempEmoji(*metrics.Temperature.SSD), *metrics.Temperature.SSD))
		}
		sb.WriteString("\n")
	}

	if metrics.Network != nil {
		rx := metrics.Network.RxBytes + metrics.Network.TxBytes
		sb.WriteString(fmt.Sprintf("🌐 *NETWORK*\n   Interface: %s\n", metrics.Network.Interface))
		sb.WriteString(fmt.Sprintf("   ⬇️ RX: %s (%d пакетов)\n", system.FormatBytes(metrics.Network.RxBytes), metrics.Network.RxPackets))
		sb.WriteString(fmt.Sprintf("   ⬆️ TX: %s (%d пакетов)\n", system.FormatBytes(metrics.Network.TxBytes), metrics.Network.TxPackets))
		sb.WriteString("   📊 Total: " + system.FormatBytes(rx) + "\n")
	}
	return sb.String()
}

func (b *Bot) handleSystemDetails(chatID int64) {
	b.stopLiveSession(chatID, true)

	metrics, _ := system.GetAllMetrics()
	distro := system.GetLinuxDistro()
	text := b.buildSystemDetailsText(metrics, distro)

	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = b.systemKeyboard()
	sent, _ := b.api.Send(msg)

	done := make(chan struct{})
	ticker := time.NewTicker(time.Second)
	b.mu.Lock()
	b.liveSessions[chatID] = &liveSession{ticker: ticker, done: done, messageID: sent.MessageID}
	b.mu.Unlock()

	go func() {
		for {
			select {
			case <-done:
				ticker.Stop()
				return
			case <-ticker.C:
				m, err := system.GetAllMetrics()
				if err != nil {
					continue
				}
				t := b.buildSystemDetailsText(m, distro)
				edit := tgbotapi.NewEditMessageText(chatID, sent.MessageID, t)
				edit.ParseMode = "Markdown"
				edit.ReplyMarkup = &tgbotapi.InlineKeyboardMarkup{}
				_, err = b.api.Send(edit)
				if err != nil && !strings.Contains(err.Error(), "message is not modified") {
					b.stopLiveSession(chatID, false)
					return
				}
			}
		}
	}()
}
