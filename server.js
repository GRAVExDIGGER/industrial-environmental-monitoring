
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from public directory

// PostgreSQL connection configuration
const pool = new Pool({
    user: process.env.DB_USER || 'your_username',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'environmental_monitoring',
    password: process.env.DB_PASSWORD || 'your_password',
    port: process.env.DB_PORT || 5432,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Sensor configuration
const SENSOR_TYPES = ['CO2', 'HUMIDITY', 'AIR_QUALITY', 'TEMPERATURE', 'DUST_PM25'];
const LOCATIONS = ['LOC_001', 'LOC_002', 'LOC_003', 'LOC_004', 'LOC_005'];

const SENSOR_CONFIGS = {
    'CO2': { base: 450, variance: 200, unit: 'ppm', thresholds: { normal: 1000, warning: 2000, critical: 5000 }},
    'HUMIDITY': { base: 50, variance: 20, unit: '%', thresholds: { normal: 70, warning: 80, critical: 90 }},
    'AIR_QUALITY': { base: 25, variance: 30, unit: 'AQI', thresholds: { normal: 50, warning: 100, critical: 150 }},
    'TEMPERATURE': { base: 22, variance: 5, unit: '°C', thresholds: { normal: 25, warning: 30, critical: 40 }},
    'DUST_PM25': { base: 8, variance: 10, unit: 'µg/m³', thresholds: { normal: 12, warning: 25, critical: 35 }}
};

// Store active connections
const activeConnections = new Set();

// Database connection test
async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Database connected successfully');
        client.release();
        return true;
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        console.log('📝 Using simulation mode without database persistence');
        return false;
    }
}

// Generate realistic sensor reading
function generateSensorReading(sensorType, locationId) {
    const config = SENSOR_CONFIGS[sensorType];
    const now = new Date();
    const hour = now.getHours();

    // Time-based variations (higher values during work hours)
    let timeFactor = 1.0;
    if (hour >= 8 && hour <= 18) {
        timeFactor = 1.2 + (Math.random() * 0.3);
    } else if (hour >= 19 && hour <= 22) {
        timeFactor = 0.8 + (Math.random() * 0.2);
    } else {
        timeFactor = 0.6 + (Math.random() * 0.2);
    }

    // Location-specific factors
    const locationFactors = {
        'LOC_001': 1.3, // Production floor
        'LOC_002': 0.8, // Storage
        'LOC_003': 0.7, // QC Lab
        'LOC_004': 1.1, // Packaging
        'LOC_005': 0.9  // Entrance
    };

    const locationFactor = locationFactors[locationId] || 1.0;

    // Generate reading with noise
    let reading = config.base * timeFactor * locationFactor;
    reading += (Math.random() - 0.5) * config.variance * 0.6;
    reading = Math.max(0, reading);

    // Calculate quality score
    const thresholds = config.thresholds;
    let qualityScore = 100;
    let status = 'normal';

    if (reading > thresholds.critical) {
        qualityScore = Math.max(10, 100 - (reading - thresholds.critical) / thresholds.critical * 80);
        status = 'critical';
    } else if (reading > thresholds.warning) {
        qualityScore = Math.max(40, 100 - (reading - thresholds.warning) / thresholds.warning * 40);
        status = 'warning';
    } else if (reading > thresholds.normal) {
        qualityScore = Math.max(70, 100 - (reading - thresholds.normal) / thresholds.normal * 20);
        status = 'warning';
    }

    return {
        locationId,
        sensorType,
        value: Math.round(reading * 1000) / 1000,
        unit: config.unit,
        qualityScore: Math.round(qualityScore),
        status,
        timestamp: now.toISOString(),
        metadata: {
            calibrationDate: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            sensorVersion: `v2.${Math.floor(Math.random() * 5) + 1}`,
            temperatureCompensation: Math.random() > 0.5
        }
    };
}

// Save sensor reading to database
async function saveSensorReading(reading, useDaÏatabase = true) {
    if (!useDatabase) return;

    try {
        const query = `
            INSERT INTO sensor_readings (location_id, sensor_type, reading_value, unit, quality_score, timestamp, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;

        await pool.query(query, [
            reading.locationId,
            reading.sensorType,
            reading.value,
            reading.unit,
            reading.qualityScore,
            reading.timestamp,
            JSON.stringify(reading.metadata)
        ]);
    } catch (err) {
        console.error('Error saving sensor reading:', err.message);
    }
}

// Get historical sensor data from database
async function getHistoricalData(hours = 24, useDatabase = true) {
    if (!useDatabase) {
        // Return simulated historical data
        const data = [];
        const now = new Date();

        for (let i = hours * 6; i >= 0; i--) {
            const timestamp = new Date(now.getTime() - i * 10 * 60 * 1000);

            LOCATIONS.forEach(locationId => {
                SENSOR_TYPES.forEach(sensorType => {
                    const reading = generateSensorReading(sensorType, locationId);
                    reading.timestamp = timestamp.toISOString();
                    data.push(reading);
                });
            });
        }

        return data;
    }

    try {
        const query = `
            SELECT 
                location_id as "locationId",
                sensor_type as "sensorType", 
                reading_value as value,
                unit,
                quality_score as "qualityScore",
                timestamp,
                metadata
            FROM sensor_readings 
            WHERE timestamp >= NOW() - INTERVAL '${hours} hours'
            ORDER BY timestamp DESC
        `;

        const result = await pool.query(query);
        return result.rows.map(row => ({
            ...row,
            status: getStatusFromValue(row.sensorType, row.value)
        }));
    } catch (err) {
        console.error('Error fetching historical data:', err.message);
        return [];
    }
}

// Get status based on sensor value and thresholds
function getStatusFromValue(sensorType, value) {
    const thresholds = SENSOR_CONFIGS[sensorType]?.thresholds;
    if (!thresholds) return 'normal';

    if (value > thresholds.critical) return 'critical';
    if (value > thresholds.warning) return 'warning';
    if (value > thresholds.normal) return 'warning';
    return 'normal';
}

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log(`📡 Client connected: ${socket.id}`);
    activeConnections.add(socket);

    // Send initial historical data
    getHistoricalData().then(data => {
        socket.emit('historical-data', data);
    });

    socket.on('disconnect', () => {
        console.log(`📡 Client disconnected: ${socket.id}`);
        activeConnections.delete(socket);
    });

    socket.on('request-historical', async (params) => {
        const { hours = 24 } = params || {};
        const data = await getHistoricalData(hours);
        socket.emit('historical-data', data);
    });
});

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        connections: activeConnections.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/sensors', (req, res) => {
    res.json({
        locations: LOCATIONS.map(id => ({
            id,
            name: getLocationName(id)
        })),
        sensorTypes: SENSOR_TYPES.map(type => ({
            type,
            ...SENSOR_CONFIGS[type]
        }))
    });
});

app.get('/api/readings/latest', async (req, res) => {
    try {
        const readings = [];

        LOCATIONS.forEach(locationId => {
            SENSOR_TYPES.forEach(sensorType => {
                const reading = generateSensorReading(sensorType, locationId);
                readings.push(reading);
            });
        });

        res.json(readings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/readings/history', async (req, res) => {
    const { hours = 24 } = req.query;

    try {
        const data = await getHistoricalData(parseInt(hours));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper function to get location name
function getLocationName(locationId) {
    const names = {
        'LOC_001': 'Production Floor A',
        'LOC_002': 'Storage Warehouse', 
        'LOC_003': 'Quality Control Lab',
        'LOC_004': 'Packaging Unit',
        'LOC_005': 'Main Entrance'
    };
    return names[locationId] || locationId;
}

// Simulate real-time sensor data generation
function startSensorSimulation(useDatabase = false) {
    setInterval(async () => {
        if (activeConnections.size === 0) return;

        // Generate readings for all sensors
        const readings = [];
        const alerts = [];

        LOCATIONS.forEach(locationId => {
            SENSOR_TYPES.forEach(sensorType => {
                const reading = generateSensorReading(sensorType, locationId);
                readings.push(reading);

                // Save to database if enabled
                saveSensorReading(reading, useDatabase);

                // Check for alerts
                if (reading.status === 'critical' || reading.status === 'warning') {
                    alerts.push({
                        id: Date.now() + Math.random(),
                        timestamp: reading.timestamp,
                        location: getLocationName(locationId),
                        locationId,
                        sensorType: reading.sensorType,
                        value: reading.value,
                        unit: reading.unit,
                        status: reading.status,
                        threshold: SENSOR_CONFIGS[sensorType].thresholds[reading.status],
                        message: `${reading.sensorType} ${reading.status} at ${getLocationName(locationId)}: ${reading.value}${reading.unit}`
                    });
                }
            });
        });

        // Broadcast to all connected clients
        activeConnections.forEach(socket => {
            socket.emit('sensor-data', readings);
            if (alerts.length > 0) {
                socket.emit('alerts', alerts);
            }
        });

    }, 3000); // Update every 3 seconds
}

// Server startup
const PORT = process.env.PORT || 3000;

async function startServer() {
    const databaseConnected = await testDatabaseConnection();

    server.listen(PORT, () => {
        console.log(`🚀 Industrial Environmental Monitoring Server running on port ${PORT}`);
        console.log(`📊 Dashboard available at http://localhost:${PORT}`);
        console.log(`🔗 WebSocket endpoint: ws://localhost:${PORT}`);

        // Start sensor simulation
        startSensorSimulation(databaseConnected);
    });
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🔄 SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('✅ Server closed');
        pool.end();
        process.exit(0);
    });
});

startServer();
