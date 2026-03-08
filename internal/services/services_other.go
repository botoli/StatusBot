//go:build !linux

package services

import (
	"runtime"
)

func GetServiceStatus(serviceName string) (*ServiceStatus, error) {
	return &ServiceStatus{
		Name:   serviceName,
		Status: "unknown (run on Linux)",
	}, nil
}

func ControlService(serviceName, action string) *ControlResult {
	return &ControlResult{
		Success: false,
		Message: "systemctl доступен только на Linux (сейчас: " + runtime.GOOS + ")",
	}
}

func GetServiceLogs(serviceName string, lines int) string {
	return "journalctl доступен только на Linux"
}
