package bot

import (
	"fmt"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"statusbot/internal/services"
	"statusbot/internal/system"
)

const (
	haproxyLocalStatsURL  = "http://localhost:8404/stats"
	haproxyPublicStatsURL = "http://95.165.29.213:8404/stats"
	haproxyStatsLogin     = "admin"
	haproxyStatsPassword  = "123456"
)

func (b *Bot) handleSlashCommand(msg *tgbotapi.Message) {
	text := strings.TrimSpace(msg.Text)
	chatID := msg.Chat.ID

	switch {
	case strings.HasPrefix(text, "/start"):
		b.handleMainMenu(chatID, msg)
		return
	case strings.HasPrefix(text, "/status"):
		b.handleStatus(chatID)
		return
	case strings.HasPrefix(text, "/backend"):
		b.handleBackendSlash(chatID, text)
		return
	case strings.HasPrefix(text, "/haproxy"):
		b.handleHAProxySlash(chatID)
		return
	default:
		b.send(chatID, "❌ Неизвестная команда")
		return
	}
}

func backendEmoji(status string) string {
	switch strings.TrimSpace(status) {
	case "active":
		return "🟢"
	case "inactive", "failed", "deactivating":
		return "🔴"
	default:
		return "⚫"
	}
}

func backendUnitFromNumSuffix(s string) (string, bool) {
	switch s {
	case "1":
		return "backend-1", true
	case "2":
		return "backend-2", true
	case "3":
		return "backend-3", true
	default:
		return "", false
	}
}

func (b *Bot) handleBackendSlash(chatID int64, raw string) {
	// Examples:
	// /backend статус
	// /backend start1|2|3
	// /backend stop1|2|3
	// /backend restart1|2|3
	// /backend restartall
	// /backend log1|2|3
	fields := strings.Fields(raw)
	if len(fields) == 1 {
		b.send(chatID, "🧩 *BACKENDS*\n\nДоступные команды:\n- `/backend статус`\n- `/backend start1|2|3`\n- `/backend stop1|2|3`\n- `/backend restart1|2|3`\n- `/backend restartall`\n- `/backend log1|2|3`")
		return
	}

	arg := strings.ToLower(strings.TrimSpace(fields[1]))
	switch {
	case arg == "статус" || arg == "status":
		b.handleBackendStatus(chatID, 0)
		return
	case arg == "restartall":
		b.handleBackendRestartAll(chatID, 0)
		b.handleBackendStatus(chatID, 0)
		return
	case strings.HasPrefix(arg, "start"):
		unit, ok := backendUnitFromNumSuffix(strings.TrimPrefix(arg, "start"))
		if !ok {
			b.send(chatID, "❌ Укажите бэкенд: start1|2|3")
			return
		}
		b.handleBackendAction(chatID, "start", unit)
		b.handleBackendStatus(chatID, 0)
		return
	case strings.HasPrefix(arg, "stop"):
		unit, ok := backendUnitFromNumSuffix(strings.TrimPrefix(arg, "stop"))
		if !ok {
			b.send(chatID, "❌ Укажите бэкенд: stop1|2|3")
			return
		}
		b.handleBackendAction(chatID, "stop", unit)
		b.handleBackendStatus(chatID, 0)
		return
	case strings.HasPrefix(arg, "restart"):
		unit, ok := backendUnitFromNumSuffix(strings.TrimPrefix(arg, "restart"))
		if !ok {
			b.send(chatID, "❌ Укажите бэкенд: restart1|2|3 или restartall")
			return
		}
		b.handleBackendAction(chatID, "restart", unit)
		b.handleBackendStatus(chatID, 0)
		return
	case strings.HasPrefix(arg, "log"):
		unit, ok := backendUnitFromNumSuffix(strings.TrimPrefix(arg, "log"))
		if !ok {
			b.send(chatID, "❌ Укажите бэкенд: log1|2|3")
			return
		}
		b.handleBackendLog(chatID, unit, 20)
		return
	default:
		b.send(chatID, "❌ Неизвестная команда. Используйте `/backend статус`")
		return
	}
}

func (b *Bot) handleBackendStatus(chatID int64, editMsgID int) {
	st := services.GetBackendStatus()

	var sb strings.Builder
	sb.WriteString("🧩 *BACKENDS*\n\n")
	sb.WriteString("🟢 active\n🔴 inactive\n⚫ unknown\n\n")
	sb.WriteString("────────────\n")

	units := []string{"backend-1", "backend-2", "backend-3"}
	for _, u := range units {
		status := st[u]
		sb.WriteString(fmt.Sprintf("%s *%s* — `%s`\n", backendEmoji(status), u, strings.TrimSpace(status)))
	}

	rows := [][]tgbotapi.InlineKeyboardButton{
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("🔄 Restart All", "backend_restartall"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonURL("📊 HAProxy Stats", haproxyPublicStatsURL),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("📝 Log Backend-1", "backend_log_backend-1"),
			tgbotapi.NewInlineKeyboardButtonData("📝 Log Backend-2", "backend_log_backend-2"),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("📝 Log Backend-3", "backend_log_backend-3"),
			tgbotapi.NewInlineKeyboardButtonData("🔄 Обновить", "backend_status"),
		),
	}

	if editMsgID > 0 {
		edit := tgbotapi.NewEditMessageText(chatID, editMsgID, sb.String())
		edit.ParseMode = "Markdown"
		edit.ReplyMarkup = &tgbotapi.InlineKeyboardMarkup{InlineKeyboard: rows}
		b.api.Send(edit)
		return
	}

	msg := tgbotapi.NewMessage(chatID, sb.String())
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
	b.api.Send(msg)
}

func (b *Bot) handleBackendAction(chatID int64, action string, unit string) {
	var (
		out string
		err error
	)
	switch action {
	case "start":
		out, err = services.StartBackend(unit)
	case "stop":
		out, err = services.StopBackend(unit)
	case "restart":
		out, err = services.RestartBackend(unit)
	default:
		b.send(chatID, "❌ Неизвестное действие")
		return
	}

	if err != nil {
		b.send(chatID, fmt.Sprintf("❌ *%s*: ошибка %s\n`%s`", unit, action, strings.TrimSpace(err.Error())))
		return
	}
	if strings.TrimSpace(out) == "" || strings.TrimSpace(out) == "ok" {
		b.send(chatID, fmt.Sprintf("✅ *%s*: %s выполнен", unit, action))
		return
	}
	b.send(chatID, fmt.Sprintf("✅ *%s*: %s\n`%s`", unit, action, strings.TrimSpace(out)))
}

func (b *Bot) handleBackendRestartAll(chatID int64, editMsgID int) {
	units := []string{"backend-1", "backend-2", "backend-3"}
	var sb strings.Builder
	sb.WriteString("🔄 *Restart All*\n\n")

	okCount := 0
	for _, u := range units {
		_, err := services.RestartBackend(u)
		if err != nil {
			sb.WriteString(fmt.Sprintf("❌ *%s* — `%s`\n", u, err.Error()))
			continue
		}
		okCount++
		sb.WriteString(fmt.Sprintf("✅ *%s* — ok\n", u))
	}

	sb.WriteString("\n────────────\n")
	sb.WriteString(fmt.Sprintf("Готово: *%d/%d*", okCount, len(units)))

	if editMsgID > 0 {
		edit := tgbotapi.NewEditMessageText(chatID, editMsgID, sb.String())
		edit.ParseMode = "Markdown"
		b.api.Send(edit)
		return
	}
	b.send(chatID, sb.String())
}

func (b *Bot) handleBackendLog(chatID int64, unit string, lines int) {
	logs, err := services.GetBackendLog(unit, lines)
	if err != nil && strings.TrimSpace(logs) == "" {
		logs = err.Error()
	}
	if len(logs) > 3500 {
		logs = logs[:3500]
	}
	text := fmt.Sprintf("📝 *Log %s (%d строк)*\n```\n%s\n```", unit, lines, logs)
	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	b.api.Send(msg)
}

func (b *Bot) handleHAProxySlash(chatID int64) {
	status := system.CheckHAProxy()

	emoji := "🔴"
	statusText := "остановлен"
	if status == "running" {
		emoji = "🟢"
		statusText = "работает"
	}

	text := fmt.Sprintf(
		"📊 *HAProxy*\n"+
			"   %s Статус: %s\n"+
			"   🔗 Stats: %s\n"+
			"   🔐 Логин: %s / %s",
		emoji, statusText, haproxyPublicStatsURL, haproxyStatsLogin, haproxyStatsPassword,
	)

	rows := [][]tgbotapi.InlineKeyboardButton{
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonURL("📊 HAProxy Stats", haproxyPublicStatsURL),
		),
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("🔄 Обновить", "backend_status"),
		),
	}

	msg := tgbotapi.NewMessage(chatID, text)
	msg.ParseMode = "Markdown"
	msg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(rows...)
	b.api.Send(msg)
}

