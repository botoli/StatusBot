//go:build linux

package services

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

func GetServiceStatus(serviceName string) (*ServiceStatus, error) {
	tryCmds := [][]string{
		{"systemctl", "status", serviceName, "--no-pager", "-n", "5"},
	}
	if os.Getenv("SUDO_PASSWORD") != "" {
		tryCmds = append(tryCmds, []string{"sh", "-c", "echo '" + os.Getenv("SUDO_PASSWORD") + "' | sudo -S systemctl status " + serviceName + " --no-pager -n 5"})
	}
	tryCmds = append(tryCmds, []string{"sudo", "systemctl", "status", serviceName, "--no-pager", "-n", "5"})

	for _, args := range tryCmds {
		cmd := exec.Command(args[0], args[1:]...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			continue
		}
		return parseSystemctlStatus(string(out), serviceName), nil
	}
	return &ServiceStatus{
		Name:   serviceName,
		Status: "inactive",
	}, nil
}

func parseSystemctlStatus(stdout, serviceName string) *ServiceStatus {
	s := &ServiceStatus{Name: serviceName}
	activeRe := regexp.MustCompile(`Active: (\w+)`)
	if m := activeRe.FindStringSubmatch(stdout); len(m) > 1 {
		s.Status = m[1]
	}
	loadRe := regexp.MustCompile(`Loaded: (.+?)\n`)
	if m := loadRe.FindStringSubmatch(stdout); len(m) > 1 {
		s.Loaded = strings.TrimSpace(m[1])
	}
	pidRe := regexp.MustCompile(`Main PID: (\d+)`)
	if m := pidRe.FindStringSubmatch(stdout); len(m) > 1 {
		s.PID = m[1]
	}
	memRe := regexp.MustCompile(`Memory: ([\d.]+[KMG])`)
	if m := memRe.FindStringSubmatch(stdout); len(m) > 1 {
		s.Memory = m[1]
	}
	lines := strings.Split(stdout, "\n")
	if len(lines) > 5 {
		s.Details = strings.Join(lines[len(lines)-5:], "\n")
	}
	return s
}

func ControlService(serviceName, action string) *ControlResult {
	tryCmds := [][]string{
		{"systemctl", action, serviceName},
	}
	if os.Getenv("SUDO_PASSWORD") != "" {
		tryCmds = append(tryCmds, []string{"sh", "-c", "echo '" + os.Getenv("SUDO_PASSWORD") + "' | sudo -S systemctl " + action + " " + serviceName})
	}
	tryCmds = append(tryCmds, []string{"sudo", "systemctl", action, serviceName})

	for _, args := range tryCmds {
		cmd := exec.Command(args[0], args[1:]...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			if strings.Contains(err.Error(), "password") || strings.Contains(string(out), "password") {
				return &ControlResult{
					Success: false,
					Message: "Требуется настройка sudo. Варианты:\n\n1. export SUDO_PASSWORD=\"ваш_пароль\"\n2. sudo visudo → NOPASSWD: /bin/systemctl\n3. Запустите от root",
				}
			}
			continue
		}
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = "Служба " + action + " выполнена"
		}
		return &ControlResult{Success: true, Message: msg}
	}
	return &ControlResult{Success: false, Message: "Не удалось выполнить " + action}
}

func GetServiceLogs(serviceName string, lines int) string {
	lineArg := fmt.Sprintf("%d", lines)
	tryCmds := [][]string{
		{"journalctl", "-u", serviceName, "-n", lineArg, "--no-pager"},
	}
	if os.Getenv("SUDO_PASSWORD") != "" {
		tryCmds = append(tryCmds, []string{"sh", "-c", "echo '" + os.Getenv("SUDO_PASSWORD") + "' | sudo -S journalctl -u " + serviceName + " -n " + lineArg + " --no-pager"})
	}
	tryCmds = append(tryCmds, []string{"sudo", "journalctl", "-u", serviceName, "-n", lineArg, "--no-pager"})

	for _, args := range tryCmds {
		cmd := exec.Command(args[0], args[1:]...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			continue
		}
		return string(out)
	}
	return "❌ Ошибка получения логов"
}
