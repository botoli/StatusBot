# StatusBot (Go)

Telegram-бот для мониторинга системы и systemd-служб на Linux. Полный порт оригинального Node.js бота на Go.

## Сборка

```bash
go build -o statusbot ./cmd/statusbot
```

Для Linux (на Linux или cross-compile):

```bash
GOOS=linux GOARCH=amd64 go build -o statusbot ./cmd/statusbot
```

## Запуск

```bash
# Обязательные переменные окружения (или config.json):
export TELEGRAM_TOKEN="your_bot_token"
export ADMIN_ID=123456789

# Опционально для systemctl/journalctl без root:
export SUDO_PASSWORD="your_password"

# Опционально - рабочая директория (по умолчанию - текущая):
export STATUSBOT_DIR=/path/to/bot

./statusbot
```

## Конфигурация

Скопируйте `config.json.example` в `config.json` и заполните:
- `telegram_token` - токен бота от @BotFather
- `admin_id` - ваш Telegram user ID

Пороги и интервалы можно переопределить в `config.json`. Полный формат см. в `config.json.example`.

## Структура проекта

```
StatusBot/
├── cmd/statusbot/main.go     # Точка входа
├── internal/
│   ├── bot/                  # Telegram handlers
│   ├── config/               # Загрузка конфигурации
│   ├── system/               # CPU, RAM, disk, temp, network (Linux)
│   ├── services/             # systemctl, journalctl (Linux)
│   ├── history/              # История метрик (JSON)
│   └── alerts/               # Пороги и уведомления
├── data/history.json         # Персистентная история
├── config.json               # Конфигурация
├── servers.json              # Список серверов (legacy)
└── go.mod
```

## Функциональность

- **СТАТУС** — live-обновление метрик каждую секунду
- **СЛУЖБЫ** — список systemd-служб, start/stop/restart, логи
- **ИСТОРИЯ** — статистика за 24ч, 48ч, 7д, 30д
- **СИСТЕМА** — детальная информация, uptime
- Алерты при превышении порогов CPU, RAM, disk, температура
- Heartbeat и уведомление при старте

## Требования

- **Linux** — для полного функционала (systemctl, /proc, /sys, sensors)
- Go 1.21+
