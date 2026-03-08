package services

type ServiceStatus struct {
	Name    string
	Status  string
	Loaded  string
	PID     string
	Memory  string
	Details string
}

type ControlResult struct {
	Success bool
	Message string
}
