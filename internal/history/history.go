package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"statusbot/internal/system"
	"time"
)

type HistoryData struct {
	CPU         []HistoryPoint   `json:"cpu"`
	Memory      []MemoryPoint    `json:"memory"`
	Disk        []DiskPoint      `json:"disk"`
	Temperature []TempPoint      `json:"temperature"`
	Network     []NetworkPoint   `json:"network"`
}

type HistoryPoint struct {
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
	Load1     float64 `json:"load1,omitempty"`
	Load5     float64 `json:"load5,omitempty"`
	Load15    float64 `json:"load15,omitempty"`
}

type MemoryPoint struct {
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
	Used      float64 `json:"used"`
	Total     float64 `json:"total"`
}

type DiskPoint struct {
	Timestamp int64  `json:"timestamp"`
	Value     int    `json:"value"`
	Used      string `json:"used"`
	Total     string `json:"total"`
}

type TempPoint struct {
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
	Type      string  `json:"type"`
}

type NetworkPoint struct {
	Timestamp int64  `json:"timestamp"`
	Interface string `json:"interface"`
	RxBytes   int64  `json:"rxBytes"`
	TxBytes   int64  `json:"txBytes"`
}

type Stats struct {
	Min    string
	Max    string
	Avg    string
	Points int
	Period int
}

type Manager struct {
	dataFile  string
	maxPoints int
}

func NewManager(baseDir string) *Manager {
	return &Manager{
		dataFile:  filepath.Join(baseDir, "data", "history.json"),
		maxPoints: 1000,
	}
}

func (m *Manager) ensureDir() error {
	return os.MkdirAll(filepath.Dir(m.dataFile), 0755)
}

func (m *Manager) load() (*HistoryData, error) {
	data, err := os.ReadFile(m.dataFile)
	if err != nil {
		return &HistoryData{
			CPU:         []HistoryPoint{},
			Memory:      []MemoryPoint{},
			Disk:        []DiskPoint{},
			Temperature: []TempPoint{},
			Network:     []NetworkPoint{},
		}, nil
	}
	var h HistoryData
	if err := json.Unmarshal(data, &h); err != nil {
		return &HistoryData{}, nil
	}
	if h.CPU == nil {
		h.CPU = []HistoryPoint{}
	}
	if h.Memory == nil {
		h.Memory = []MemoryPoint{}
	}
	if h.Disk == nil {
		h.Disk = []DiskPoint{}
	}
	if h.Temperature == nil {
		h.Temperature = []TempPoint{}
	}
	if h.Network == nil {
		h.Network = []NetworkPoint{}
	}
	return &h, nil
}

func (m *Manager) save(h *HistoryData) error {
	if err := m.ensureDir(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(h, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.dataFile, data, 0644)
}

func (m *Manager) trim(h *HistoryData) {
	if len(h.CPU) > m.maxPoints {
		h.CPU = h.CPU[len(h.CPU)-m.maxPoints:]
	}
	if len(h.Memory) > m.maxPoints {
		h.Memory = h.Memory[len(h.Memory)-m.maxPoints:]
	}
	if len(h.Disk) > m.maxPoints {
		h.Disk = h.Disk[len(h.Disk)-m.maxPoints:]
	}
	if len(h.Temperature) > m.maxPoints {
		h.Temperature = h.Temperature[len(h.Temperature)-m.maxPoints:]
	}
	if len(h.Network) > m.maxPoints {
		h.Network = h.Network[len(h.Network)-m.maxPoints:]
	}
}

func (m *Manager) AddPoint(metrics *system.Metrics) error {
	h, err := m.load()
	if err != nil {
		return err
	}
	ts := metrics.Timestamp

	cpuVal, _ := parseFloat(metrics.CPU.Current)
	load1, _ := parseFloat(metrics.CPU.Load1)
	load5, _ := parseFloat(metrics.CPU.Load5)
	load15, _ := parseFloat(metrics.CPU.Load15)
	h.CPU = append(h.CPU, HistoryPoint{
		Timestamp: ts,
		Value:     cpuVal,
		Load1:     load1,
		Load5:     load5,
		Load15:    load15,
	})

	memUsed, _ := parseFloat(metrics.Memory.Used)
	memTotal, _ := parseFloat(metrics.Memory.Total)
	memPct, _ := parseFloat(metrics.Memory.Percent)
	h.Memory = append(h.Memory, MemoryPoint{
		Timestamp: ts,
		Value:     memPct,
		Used:      memUsed,
		Total:     memTotal,
	})

	if metrics.Disk != nil {
		diskPct := 0
		if _, err := parseInt(metrics.Disk.Percent); err == nil {
			diskPct, _ = parseInt(metrics.Disk.Percent)
		}
		h.Disk = append(h.Disk, DiskPoint{
			Timestamp: ts,
			Value:     diskPct,
			Used:      metrics.Disk.Used,
			Total:     metrics.Disk.Total,
		})
	}

	if metrics.Temperature.CPU != nil && *metrics.Temperature.CPU > 0 {
		h.Temperature = append(h.Temperature, TempPoint{
			Timestamp: ts,
			Value:     *metrics.Temperature.CPU,
			Type:      "cpu",
		})
	}
	if metrics.Temperature.GPU != nil && *metrics.Temperature.GPU > 0 {
		h.Temperature = append(h.Temperature, TempPoint{
			Timestamp: ts,
			Value:     *metrics.Temperature.GPU,
			Type:      "gpu",
		})
	}
	if metrics.Temperature.SSD != nil && *metrics.Temperature.SSD > 0 {
		h.Temperature = append(h.Temperature, TempPoint{
			Timestamp: ts,
			Value:     *metrics.Temperature.SSD,
			Type:      "ssd",
		})
	}

	if metrics.Network != nil {
		h.Network = append(h.Network, NetworkPoint{
			Timestamp: ts,
			Interface: metrics.Network.Interface,
			RxBytes:   metrics.Network.RxBytes,
			TxBytes:   metrics.Network.TxBytes,
		})
	}

	m.trim(h)
	return m.save(h)
}

func parseFloat(s string) (float64, error) {
	return strconv.ParseFloat(s, 64)
}

func parseInt(s string) (int, error) {
	return strconv.Atoi(s)
}

func (m *Manager) getFiltered(typeKey string, hours int) ([]float64, int) {
	h, err := m.load()
	if err != nil {
		return nil, 0
	}
	cutoff := time.Now().UnixMilli() - int64(hours)*60*60*1000

	switch typeKey {
	case "cpu":
		var vals []float64
		for _, p := range h.CPU {
			if p.Timestamp >= cutoff {
				vals = append(vals, p.Value)
			}
		}
		return vals, len(vals)
	case "memory":
		var vals []float64
		for _, p := range h.Memory {
			if p.Timestamp >= cutoff {
				vals = append(vals, p.Value)
			}
		}
		return vals, len(vals)
	case "disk":
		var vals []float64
		for _, p := range h.Disk {
			if p.Timestamp >= cutoff {
				vals = append(vals, float64(p.Value))
			}
		}
		return vals, len(vals)
	case "temperature":
		var vals []float64
		for _, p := range h.Temperature {
			if p.Timestamp >= cutoff && p.Type == "cpu" {
				vals = append(vals, p.Value)
			}
		}
		if len(vals) == 0 {
			for _, p := range h.Temperature {
				if p.Timestamp >= cutoff {
					vals = append(vals, p.Value)
				}
			}
		}
		return vals, len(vals)
	default:
		return nil, 0
	}
}

func (m *Manager) GetHistory(typeKey string, hours int) int {
	_, count := m.getFiltered(typeKey, hours)
	return count
}

func (m *Manager) GetStats(typeKey string, hours int) *Stats {
	vals, _ := m.getFiltered(typeKey, hours)
	if len(vals) == 0 {
		return nil
	}
	min, max, sum := vals[0], vals[0], 0.0
	for _, v := range vals {
		if v < min {
			min = v
		}
		if v > max {
			max = v
		}
		sum += v
	}
	avg := sum / float64(len(vals))
	return &Stats{
		Min:    strconv.FormatFloat(min, 'f', 1, 64),
		Max:    strconv.FormatFloat(max, 'f', 1, 64),
		Avg:    strconv.FormatFloat(avg, 'f', 1, 64),
		Points: len(vals),
		Period: hours,
	}
}

func (m *Manager) Cleanup() error {
	h, err := m.load()
	if err != nil {
		return err
	}
	weekAgo := time.Now().UnixMilli() - 7*24*60*60*1000
	filter := func(ts int64) bool { return ts >= weekAgo }

	var newCPU []HistoryPoint
	for _, p := range h.CPU {
		if filter(p.Timestamp) {
			newCPU = append(newCPU, p)
		}
	}
	h.CPU = newCPU

	var newMem []MemoryPoint
	for _, p := range h.Memory {
		if filter(p.Timestamp) {
			newMem = append(newMem, p)
		}
	}
	h.Memory = newMem

	var newDisk []DiskPoint
	for _, p := range h.Disk {
		if filter(p.Timestamp) {
			newDisk = append(newDisk, p)
		}
	}
	h.Disk = newDisk

	var newTemp []TempPoint
	for _, p := range h.Temperature {
		if filter(p.Timestamp) {
			newTemp = append(newTemp, p)
		}
	}
	h.Temperature = newTemp

	var newNet []NetworkPoint
	for _, p := range h.Network {
		if filter(p.Timestamp) {
			newNet = append(newNet, p)
		}
	}
	h.Network = newNet

	return m.save(h)
}
