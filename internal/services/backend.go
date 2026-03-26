//go:build linux

package services

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

var backendUnits = []string{"backend-1", "backend-2", "backend-3"}

func validateBackendUnit(backend string) (string, error) {
	b := strings.TrimSpace(backend)
	for _, u := range backendUnits {
		if b == u {
			return b, nil
		}
	}
	return "", fmt.Errorf("invalid backend %q (allowed: %s)", backend, strings.Join(backendUnits, ", "))
}

func runCommand(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	s := strings.TrimSpace(string(out))
	if err != nil {
		if s == "" {
			s = err.Error()
		}
		return s, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, s)
	}
	return s, nil
}

func runSudoCommand(name string, args ...string) (string, error) {
	// First try passwordless sudo (NOPASSWD) without prompting.
	out, err := runCommand("sudo", append([]string{"-n", name}, args...)...)
	if err == nil {
		return out, nil
	}

	// If password is provided, retry with -S and feed it via stdin.
	pass := os.Getenv("SUDO_PASSWORD")
	if pass == "" {
		return out, err
	}

	cmd := exec.Command("sudo", append([]string{"-S", name}, args...)...)
	cmd.Stdin = strings.NewReader(pass + "\n")
	combined, cmdErr := cmd.CombinedOutput()
	s := strings.TrimSpace(string(combined))
	if cmdErr != nil {
		if s == "" {
			s = cmdErr.Error()
		}
		return s, fmt.Errorf("sudo -S %s %s: %w: %s", name, strings.Join(args, " "), cmdErr, s)
	}
	return s, nil
}

// GetBackendStatus checks each backend unit via: systemctl is-active backend-1|2|3
// Returns map like: {"backend-1":"active","backend-2":"inactive",...}
func GetBackendStatus() map[string]string {
	res := make(map[string]string, len(backendUnits))
	for _, unit := range backendUnits {
		out, err := runCommand("systemctl", "is-active", unit)
		if err != nil {
			// systemctl is-active returns non-zero for inactive/failed; output still contains status.
			if strings.TrimSpace(out) != "" {
				res[unit] = strings.TrimSpace(out)
			} else {
				res[unit] = "unknown"
			}
			continue
		}
		res[unit] = strings.TrimSpace(out)
	}
	return res
}

// StartBackend runs: sudo systemctl start backend-X
func StartBackend(backend string) (string, error) {
	unit, err := validateBackendUnit(backend)
	if err != nil {
		return "", err
	}
	out, runErr := runSudoCommand("systemctl", "start", unit)
	if runErr != nil {
		return out, runErr
	}
	if out == "" {
		out = "ok"
	}
	return out, nil
}

// StopBackend runs: sudo systemctl stop backend-X
func StopBackend(backend string) (string, error) {
	unit, err := validateBackendUnit(backend)
	if err != nil {
		return "", err
	}
	out, runErr := runSudoCommand("systemctl", "stop", unit)
	if runErr != nil {
		return out, runErr
	}
	if out == "" {
		out = "ok"
	}
	return out, nil
}

// RestartBackend runs: sudo systemctl restart backend-X
func RestartBackend(backend string) (string, error) {
	unit, err := validateBackendUnit(backend)
	if err != nil {
		return "", err
	}
	out, runErr := runSudoCommand("systemctl", "restart", unit)
	if runErr != nil {
		return out, runErr
	}
	if out == "" {
		out = "ok"
	}
	return out, nil
}

// GetBackendLog runs: journalctl -u backend-X -n <lines> --no-pager
func GetBackendLog(backend string, lines int) (string, error) {
	unit, err := validateBackendUnit(backend)
	if err != nil {
		return "", err
	}
	if lines <= 0 {
		return "", errors.New("lines must be > 0")
	}

	lineArg := fmt.Sprintf("%d", lines)

	// Prefer without sudo (often allowed). If it fails and sudo is available, retry with sudo.
	out, err := runCommand("journalctl", "-u", unit, "-n", lineArg, "--no-pager")
	if err == nil {
		return out, nil
	}
	out2, err2 := runSudoCommand("journalctl", "-u", unit, "-n", lineArg, "--no-pager")
	if err2 == nil {
		return out2, nil
	}
	// Return the sudo error as the final one (usually more informative in restricted setups).
	return out2, err2
}

