package main

import (
	"log"
	"os"
	"time"

	"statusbot/internal/alerts"
	"statusbot/internal/bot"
	"statusbot/internal/config"
	"statusbot/internal/history"
	"statusbot/internal/system"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func main() {
	baseDir, _ := os.Getwd()
	if dir := os.Getenv("STATUSBOT_DIR"); dir != "" {
		baseDir = dir
	}

	cfg, err := config.Load(baseDir)
	if err != nil {
		log.Fatalf("Config load: %v", err)
	}
	if cfg.TelegramToken == "" {
		log.Fatal("TELEGRAM_TOKEN required")
	}
	if cfg.AdminID == 0 {
		log.Fatal("ADMIN_ID required (config.json or ADMIN_ID env)")
	}

	api, err := tgbotapi.NewBotAPI(cfg.TelegramToken)
	if err != nil {
		log.Fatalf("Telegram: %v", err)
	}
	api.Debug = false
	log.Printf("Authorized as %s", api.Self.UserName)

	histMgr := history.NewManager(baseDir)
	alertMgr := alerts.NewManager(api, cfg)
	alertMgr.StartMonitoring()

	if metrics, err := system.GetAllMetrics(); err == nil {
		histMgr.AddPoint(metrics)
		log.Println("📊 Первая точка истории добавлена")
	}

	go runHistoryCollector(histMgr, cfg)
	go runHistoryCleanup(histMgr, cfg)

	telegramBot := bot.New(api, cfg, histMgr)
	telegramBot.SetAlertController(alertMgr)
	telegramBot.Run()
}

func runHistoryCollector(hist *history.Manager, cfg *config.Config) {
	ticker := time.NewTicker(time.Duration(cfg.Intervals.History) * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		metrics, err := system.GetAllMetrics()
		if err != nil {
			log.Printf("History collect error: %v", err)
			continue
		}
		if err := hist.AddPoint(metrics); err != nil {
			log.Printf("History save error: %v", err)
		}
	}
}

func runHistoryCleanup(hist *history.Manager, cfg *config.Config) {
	ticker := time.NewTicker(time.Duration(cfg.Intervals.Cleanup) * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		if err := hist.Cleanup(); err != nil {
			log.Printf("History cleanup error: %v", err)
		} else {
			log.Println("🧹 История очищена")
		}
	}
}
