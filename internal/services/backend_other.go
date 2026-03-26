//go:build !linux

package services

import (
	"fmt"
	"runtime"
)

func GetBackendStatus() map[string]string {
	return map[string]string{
		"backend-1": "unknown (run on Linux)",
		"backend-2": "unknown (run on Linux)",
		"backend-3": "unknown (run on Linux)",
	}
}

func StartBackend(backend string) (string, error) {
	return "", fmt.Errorf("systemctl доступен только на Linux (сейчас: %s)", runtime.GOOS)
}

func StopBackend(backend string) (string, error) {
	return "", fmt.Errorf("systemctl доступен только на Linux (сейчас: %s)", runtime.GOOS)
}

func RestartBackend(backend string) (string, error) {
	return "", fmt.Errorf("systemctl доступен только на Linux (сейчас: %s)", runtime.GOOS)
}

func GetBackendLog(backend string, lines int) (string, error) {
	return "", fmt.Errorf("journalctl доступен только на Linux (сейчас: %s)", runtime.GOOS)
}

