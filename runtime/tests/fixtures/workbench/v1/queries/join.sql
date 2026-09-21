SELECT p.source_row_id, p.timestamp_utc, p.demand_mwh FROM predict p LEFT JOIN predictions r USING (source_row_id) ORDER BY p.timestamp_utc;
