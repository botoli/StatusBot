package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

type Thresholds struct {
	CPU         int   `json:"cpu"`
	RAM         int   `json:"ram"`
	Disk        int   `json:"disk"`
	TEMP_CPU    int   `json:"temp_cpu"`
	TEMP_GPU    int   `json:"temp_gpu"`
	TEMP_SSD    int   `json:"temp_ssd"`
	NetworkSpeed int64 `json:"network_speed"` // bytes/s
}

type Intervals struct {
	Check        int64 `json:"check"`         // ms
	History      int64 `json:"history"`       // ms
	AlertCooldown int64 `json:"alert_cooldown"` // ms
	Cleanup      int64 `json:"cleanup"`       // ms
}

type Service struct {
	Name       string `json:"name"`
	SystemName string `json:"system_name"`
}

type Config struct {
	TelegramToken string      `json:"telegram_token"`
	AdminID       int64       `json:"admin_id"`
	Thresholds    Thresholds  `json:"thresholds"`
	Intervals     Intervals   `json:"intervals"`
	Services      []Service   `json:"services"`
}

var DefaultConfig = Config{
	TelegramToken: os.Getenv("TELEGRAM_TOKEN"),
	AdminID:       0,
	Thresholds: Thresholds{
		CPU:          80,
		RAM:          85,
		Disk:         90,
		TEMP_CPU:     80,
		TEMP_GPU:     80,
		TEMP_SSD:     65,
		NetworkSpeed: 100 * 1024 * 1024, // 100 MB/s
	},
	Intervals: Intervals{
		Check:        60 * 1000,
		History:      5 * 60 * 1000,
		AlertCooldown: 30 * 60 * 1000,
		Cleanup:      24 * 60 * 60 * 1000,
	},
	Services: []Service{
		{Name: "📁 File Browser", SystemName: "filebrowser"},
		{Name: "📊 JSON Server", SystemName: "json-server"},
		{Name: "🌐 Nginx", SystemName: "nginx"},
		{Name: "🗄️ MySQL", SystemName: "mysql"},
		{Name: "🐳 Docker", SystemName: "docker"},
		{Name: "☁️ Cloudflared", SystemName: "cloudflared"},
	},
}

func Load(baseDir string) (*Config, error) {
	cfg := DefaultConfig
	configPath := filepath.Join(baseDir, "config.json")

	if data, err := os.ReadFile(configPath); err == nil {
		var fileCfg struct {
			TelegramToken    *string     `json:"telegram_token"`
			TelegramTokenLegacy *string `json:"TELEGRAM_TOKEN"`
			AdminID          *int64      `json:"admin_id"`
			AdminIDLegacy    *int64      `json:"ADMIN_ID"`
			Thresholds       *Thresholds `json:"thresholds"`
			ThresholdsLegacy *struct {
				CPU int `json:"CPU"`
				RAM int `json:"RAM"`
				Disk int `json:"DISK"`
			} `json:"THRESHOLDS"`
			Intervals  *Intervals `json:"intervals"`
			Services   []Service  `json:"services"`
		}
		if err := json.Unmarshal(data, &fileCfg); err == nil {
			if fileCfg.TelegramToken != nil {
				cfg.TelegramToken = *fileCfg.TelegramToken
			}
			if fileCfg.TelegramTokenLegacy != nil {
				cfg.TelegramToken = *fileCfg.TelegramTokenLegacy
			}
			if token := os.Getenv("TELEGRAM_TOKEN"); token != "" {
				cfg.TelegramToken = token
			}
			if fileCfg.AdminID != nil {
				cfg.AdminID = *fileCfg.AdminID
			}
			if fileCfg.AdminIDLegacy != nil {
				cfg.AdminID = *fileCfg.AdminIDLegacy
			}
			if fileCfg.ThresholdsLegacy != nil {
				if fileCfg.ThresholdsLegacy.CPU > 0 {
					cfg.Thresholds.CPU = fileCfg.ThresholdsLegacy.CPU
				}
				if fileCfg.ThresholdsLegacy.RAM > 0 {
					cfg.Thresholds.RAM = fileCfg.ThresholdsLegacy.RAM
				}
				if fileCfg.ThresholdsLegacy.Disk > 0 {
					cfg.Thresholds.Disk = fileCfg.ThresholdsLegacy.Disk
				}
			}
			if fileCfg.Thresholds != nil {
				if fileCfg.Thresholds.CPU > 0 {
					cfg.Thresholds.CPU = fileCfg.Thresholds.CPU
				}
				if fileCfg.Thresholds.RAM > 0 {
					cfg.Thresholds.RAM = fileCfg.Thresholds.RAM
				}
				if fileCfg.Thresholds.Disk > 0 {
					cfg.Thresholds.Disk = fileCfg.Thresholds.Disk
				}
				if fileCfg.Thresholds.TEMP_CPU > 0 {
					cfg.Thresholds.TEMP_CPU = fileCfg.Thresholds.TEMP_CPU
				}
				if fileCfg.Thresholds.TEMP_GPU > 0 {
					cfg.Thresholds.TEMP_GPU = fileCfg.Thresholds.TEMP_GPU
				}
				if fileCfg.Thresholds.TEMP_SSD > 0 {
					cfg.Thresholds.TEMP_SSD = fileCfg.Thresholds.TEMP_SSD
				}
				if fileCfg.Thresholds.NetworkSpeed > 0 {
					cfg.Thresholds.NetworkSpeed = fileCfg.Thresholds.NetworkSpeed
				}
			}
			if fileCfg.Intervals != nil {
				if fileCfg.Intervals.Check > 0 {
					cfg.Intervals.Check = fileCfg.Intervals.Check
				}
				if fileCfg.Intervals.History > 0 {
					cfg.Intervals.History = fileCfg.Intervals.History
				}
				if fileCfg.Intervals.AlertCooldown > 0 {
					cfg.Intervals.AlertCooldown = fileCfg.Intervals.AlertCooldown
				}
				if fileCfg.Intervals.Cleanup > 0 {
					cfg.Intervals.Cleanup = fileCfg.Intervals.Cleanup
				}
			}
			if len(fileCfg.Services) > 0 {
				cfg.Services = fileCfg.Services
			}
		}
	}

	if idStr := os.Getenv("ADMIN_ID"); idStr != "" {
		if id, err := strconv.ParseInt(idStr, 10, 64); err == nil {
			cfg.AdminID = id
		}
	}

	return &cfg, nil
}
