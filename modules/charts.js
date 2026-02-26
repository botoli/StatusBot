// modules/charts.js
const https = require('https');
const http = require('http');

class ChartGenerator {
    /**
     * Генерирует URL для QuickChart API
     */
    generateChartUrl(chartConfig) {
        const encoded = encodeURIComponent(JSON.stringify(chartConfig));
        return `https://quickchart.io/chart?c=${encoded}`;
    }

    /**
     * Создает график для live мониторинга CPU/RAM
     */
    createLiveChart(cpuData, ramData, labels = null) {
        if (!labels) {
            labels = Array(Math.max(cpuData.length, ramData.length)).fill('');
        }

        return {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'CPU %',
                        data: cpuData,
                        borderColor: 'rgb(255, 99, 132)',
                        backgroundColor: 'rgba(255, 99, 132, 0.1)',
                        tension: 0.4,
                        fill: true
                    },
                    {
                        label: 'RAM %',
                        data: ramData,
                        borderColor: 'rgb(54, 162, 235)',
                        backgroundColor: 'rgba(54, 162, 235, 0.1)',
                        tension: 0.4,
                        fill: true
                    }
                ]
            },
            options: {
                animation: false,
                responsive: true,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    title: {
                        display: true,
                        text: 'Live CPU/RAM Monitor'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100,
                        ticks: {
                            callback: function(value) {
                                return value + '%';
                            }
                        }
                    }
                }
            }
        };
    }

    /**
     * Создает график истории за период
     */
    createHistoryChart(cpuStats, ramStats, diskStats = null, labels = null) {
        const datasets = [
            {
                label: 'CPU %',
                data: cpuStats,
                borderColor: 'rgb(255, 99, 132)',
                backgroundColor: 'rgba(255, 99, 132, 0.1)',
                tension: 0.4,
                fill: true
            },
            {
                label: 'RAM %',
                data: ramStats,
                borderColor: 'rgb(54, 162, 235)',
                backgroundColor: 'rgba(54, 162, 235, 0.1)',
                tension: 0.4,
                fill: true
            }
        ];

        if (diskStats && diskStats.length > 0) {
            datasets.push({
                label: 'DISK %',
                data: diskStats,
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.1)',
                tension: 0.4,
                fill: true
            });
        }

        if (!labels) {
            labels = Array(Math.max(...datasets.map(d => d.data.length))).fill('');
        }

        return {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                animation: false,
                responsive: true,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100,
                        ticks: {
                            callback: function(value) {
                                return value + '%';
                            }
                        }
                    }
                }
            }
        };
    }

    /**
     * Получает URL графика для отправки в Telegram
     */
    getChartUrl(type, data) {
        let chartConfig;
        
        if (type === 'live') {
            chartConfig = this.createLiveChart(data.cpu, data.ram, data.labels);
        } else if (type === 'history') {
            chartConfig = this.createHistoryChart(
                data.cpu,
                data.ram,
                data.disk,
                data.labels
            );
        }
        
        return this.generateChartUrl(chartConfig);
    }
}

module.exports = new ChartGenerator();
