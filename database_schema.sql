
-- Industrial Environmental Monitoring System Database Schema
-- Time-series optimized PostgreSQL design with partitioning

-- Create main sensors table (partitioned by date)
CREATE TABLE IF NOT EXISTS sensor_readings (
    id BIGSERIAL,
    location_id VARCHAR(50) NOT NULL,
    sensor_type VARCHAR(50) NOT NULL,
    reading_value DECIMAL(10,3) NOT NULL,
    unit VARCHAR(20) NOT NULL,
    quality_score INTEGER CHECK (quality_score >= 0 AND quality_score <= 100),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB
) PARTITION BY RANGE (timestamp);

-- Create location master table
CREATE TABLE IF NOT EXISTS locations (
    location_id VARCHAR(50) PRIMARY KEY,
    location_name VARCHAR(100) NOT NULL,
    factory_zone VARCHAR(50),
    coordinates POINT,
    installation_date DATE,
    is_active BOOLEAN DEFAULT TRUE
);

-- Create sensor types lookup
CREATE TABLE IF NOT EXISTS sensor_types (
    sensor_type VARCHAR(50) PRIMARY KEY,
    description TEXT,
    measurement_unit VARCHAR(20),
    normal_range_min DECIMAL(10,3),
    normal_range_max DECIMAL(10,3),
    critical_threshold DECIMAL(10,3)
);

-- Create daily partitions (example for current month)
DO $$
DECLARE
    start_date DATE;
    end_date DATE;
    current_date DATE;
    partition_name TEXT;
BEGIN
    start_date := DATE_TRUNC('month', CURRENT_DATE);
    end_date := start_date + INTERVAL '2 months';
    current_date := start_date;

    WHILE current_date < end_date LOOP
        partition_name := 'sensor_readings_' || TO_CHAR(current_date, 'YYYY_MM_DD');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF sensor_readings 
             FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            current_date,
            current_date + INTERVAL '1 day'
        );
        current_date := current_date + INTERVAL '1 day';
    END LOOP;
END $$;

-- Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_sensor_readings_timestamp 
    ON sensor_readings USING BRIN (timestamp) WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_location_time 
    ON sensor_readings (location_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_type_time 
    ON sensor_readings (sensor_type, timestamp DESC);

-- Insert sample reference data
INSERT INTO sensor_types (sensor_type, description, measurement_unit, normal_range_min, normal_range_max, critical_threshold)
VALUES 
    ('CO2', 'Carbon Dioxide Concentration', 'ppm', 350.0, 1000.0, 5000.0),
    ('HUMIDITY', 'Relative Humidity', '%', 30.0, 70.0, 90.0),
    ('AIR_QUALITY', 'Air Quality Index', 'AQI', 0.0, 50.0, 150.0),
    ('TEMPERATURE', 'Ambient Temperature', '°C', 18.0, 25.0, 40.0),
    ('DUST_PM25', 'Particulate Matter 2.5', 'µg/m³', 0.0, 12.0, 35.0)
ON CONFLICT (sensor_type) DO NOTHING;

INSERT INTO locations (location_id, location_name, factory_zone, installation_date, is_active)
VALUES 
    ('LOC_001', 'Production Floor A', 'Manufacturing', CURRENT_DATE - INTERVAL '30 days', TRUE),
    ('LOC_002', 'Storage Warehouse', 'Storage', CURRENT_DATE - INTERVAL '25 days', TRUE),
    ('LOC_003', 'Quality Control Lab', 'QC', CURRENT_DATE - INTERVAL '20 days', TRUE),
    ('LOC_004', 'Packaging Unit', 'Packaging', CURRENT_DATE - INTERVAL '15 days', TRUE),
    ('LOC_005', 'Main Entrance', 'Reception', CURRENT_DATE - INTERVAL '10 days', TRUE)
ON CONFLICT (location_id) DO NOTHING;

-- Create views for reporting
CREATE OR REPLACE VIEW hourly_averages AS
SELECT 
    location_id,
    sensor_type,
    DATE_TRUNC('hour', timestamp) as hour,
    AVG(reading_value) as avg_value,
    MIN(reading_value) as min_value,
    MAX(reading_value) as max_value,
    COUNT(*) as reading_count
FROM sensor_readings
WHERE timestamp >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY location_id, sensor_type, DATE_TRUNC('hour', timestamp);

CREATE OR REPLACE VIEW daily_compliance_report AS
SELECT 
    sr.location_id,
    l.location_name,
    sr.sensor_type,
    st.description,
    DATE(sr.timestamp) as report_date,
    AVG(sr.reading_value) as daily_average,
    MAX(sr.reading_value) as daily_maximum,
    COUNT(CASE WHEN sr.reading_value > st.critical_threshold THEN 1 END) as critical_violations,
    COUNT(*) as total_readings
FROM sensor_readings sr
JOIN locations l ON sr.location_id = l.location_id
JOIN sensor_types st ON sr.sensor_type = st.sensor_type
WHERE sr.timestamp >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY sr.location_id, l.location_name, sr.sensor_type, st.description, DATE(sr.timestamp)
ORDER BY report_date DESC, sr.location_id;

-- Create backup and archiving procedures
CREATE OR REPLACE FUNCTION archive_old_data() RETURNS void AS $$
BEGIN
    -- Archive data older than 1 year to archive table
    CREATE TABLE IF NOT EXISTS sensor_readings_archive (LIKE sensor_readings);

    -- Move old data to archive
    WITH moved_data AS (
        DELETE FROM sensor_readings 
        WHERE timestamp < CURRENT_DATE - INTERVAL '1 year'
        RETURNING *
    )
    INSERT INTO sensor_readings_archive SELECT * FROM moved_data;

    -- Drop old partitions
    -- This would be implemented based on specific partition naming strategy

    RAISE NOTICE 'Data archiving completed for data older than 1 year';
END;
$$ LANGUAGE plpgsql;

-- Create automated cleanup job (requires pg_cron extension)
-- SELECT cron.schedule('monthly-archive', '0 2 1 * *', 'SELECT archive_old_data();');

COMMENT ON TABLE sensor_readings IS 'Main time-series table for environmental sensor data with daily partitioning';
COMMENT ON VIEW hourly_averages IS 'Hourly aggregated sensor data for the last 7 days';
COMMENT ON VIEW daily_compliance_report IS 'Daily compliance report showing violations and statistics';
